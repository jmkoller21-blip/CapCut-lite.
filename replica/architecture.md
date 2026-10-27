# Architecture: a lightweight Windows video editor (a rebuild of CapCut desktop's core editing loop)

Working name: TBD (brand step comes later; no CapCut name or assets are used anywhere).
Inputs: `replica/recon.md`, `replica/features.csv`. Target: Windows 10/11, i3 / 4 GB RAM / Intel HD 4000 class. Local only, offline, no accounts.

The skill's web defaults (Next.js, Postgres, Stripe, Vercel) do not apply. There is no server, no auth and no payments. The equivalents are below: a local project file instead of a database server, IPC commands instead of HTTP routes, a local job queue instead of cron.

## Stack

| layer | choice | why |
| --- | --- | --- |
| app shell | Tauri 2 (Rust + the Windows WebView2 runtime) | Installer around 10 MB and idle RAM around 100 MB, against 150+ MB and 300+ MB for Electron. WebView2 ships with Windows 11 and current Windows 10, and the installer can bootstrap it. |
| UI | TypeScript + Svelte 5 + Vite | Smallest runtime of the mainstream frameworks, no virtual DOM, fast on weak CPUs. |
| timeline and canvas | Custom Canvas 2D (no UI library) | Timelines with hundreds of clips are redrawn from data, not DOM nodes. DOM-per-clip is the first thing that dies on a weak PC. |
| engine | Rust crate (`engine`): project model, decode, compositor, audio mixer, exporter | One process, one language, no GC pauses, tight memory control. |
| decode | FFmpeg (libav, LGPL build, dynamically linked) | Reads nearly every format. Hardware decode through D3D11VA when present, software path always works. |
| compositing | CPU compositor in Rust with SIMD (`std::simd` or `wide`) as the baseline; optional GPU path via `wgpu` using the D3D11/GL backend | Intel HD 4000 has weak or missing modern GPU APIs, so GPU is an optional speed-up, never a requirement. |
| preview transport | Rust renders preview frames at preview resolution and pushes them to the WebView through a custom protocol (`preview://`) as raw RGBA into a canvas | Avoids shipping a second video player and keeps A/V sync under our control. |
| audio | `cpal` for output, own mixer (volume, fades, speed) | Small, no heavy audio stack. |
| encode | Windows Media Foundation H.264 encoder (through FFmpeg `h264_mf`) as default, Intel QSV / NVENC / AMF when detected, OpenH264 as software fallback | Avoids bundling x264 (GPL). WMF's encoder is part of Windows. Software fallback keeps it working everywhere. |
| project file | SQLite (single `.proj` file, WAL off, via `rusqlite`) | Atomic saves, crash-safe autosave, partial loading of big projects, schema versioning built in. |
| app settings | TOML file in `%APPDATA%` | Trivial and human-editable. |
| jobs | In-process job queue (Rust threads, `rayon` pool capped at cores-1): proxy generation, thumbnails, waveforms, export | No external service. Caps keep the UI responsive. |
| icons | Lucide (ISC) and/or Phosphor (MIT), inlined as SVG sprites | Open licences, clear toolbar vocabulary. Not CapCut's icons. |
| fonts | Open fonts only (Inter, Noto, a few OFL display fonts), bundled as subsets | Licensed and small. |
| bundled media | Small starter pack of CC0 / Pexels / Pixabay-licensed clips, music and sound effects, each with a row in `asset_library` | Satisfies "some stock media" legally. See Licensing notes. |
| transitions and effects | Written in-house as small Rust shaders-on-CPU (dissolve, slide, wipe, zoom, blur, fade through black) | Techniques are generic. Names and look are our own. |
| installer | WiX (MSI) or NSIS, built on a Windows CI runner (GitHub Actions `windows-latest`) | Tauri's bundler produces both. Cannot be built in this Linux workspace. See Build and packaging. |
| tests | `cargo test` for the engine, Vitest for UI logic, a golden-frame test suite for the compositor | Frame-exact tests catch regressions that screenshots miss. |
| telemetry | None | Offline product. |

Why not the alternatives. Electron: too heavy for the stated hardware. Qt/C++: lighter at runtime but a much slower build and a licensing thread (LGPL, FFmpeg). Pure native Rust UI (egui/iced): lightest, but a custom timeline, text editing and accessibility would take longer than using the web layer for the chrome and canvas for the timeline. Revisit if WebView2 memory proves too high in testing.

## Low-spec budget (acceptance numbers for every milestone)

| measure | target | how it is enforced |
| --- | --- | --- |
| installer size | under 150 MB with starter media (under 60 MB without) | CI size check fails the build |
| idle RAM | under 300 MB | benchmark script on a throttled VM |
| RAM during a 1080p, 10-track edit | under 1.5 GB | same |
| cold start | under 3 s on a 2013-class dual-core | same |
| preview | 24+ fps at 540p preview for 1080p source; drops resolution, then frames, never freezes the UI | adaptive preview governor |
| export | never crashes. Segmented render, streamed to disk, memory-capped | export soak test |
| GPU | optional. Everything works with GPU disabled | CI runs the whole suite with `--no-gpu` |

Test hardware stand-in: a Windows VM limited to 2 cores, 4 GB RAM, no GPU passthrough. Real checking on an actual old machine is still needed before release.

## Project file schema

Tables: 12 in the project file, 2 in the app database. Full SQL in `replica/schema.sql`.

Access rules: no multi-user access, so no row-level security. Safety comes from: one writer (the engine), foreign keys enforced (`PRAGMA foreign_keys=ON`), a single transaction per user action, and an undo log table. Media files are referenced by path and never modified or copied unless the user asks.

Conventions (replacing the web ones):
- Times: `INTEGER` microseconds on the timeline. No floats, so no drift over long projects.
- IDs: `TEXT` UUIDv7. Sortable, generated in the engine.
- No owner column, because there are no users. Every table belongs to one project file.
- Money: not applicable.
- Version: `PRAGMA user_version` plus a `meta` table. Migrations run on open, with a backup copy written first.

Decisions on deletes. Deleting a track deletes its clips (`cascade`). Deleting a clip deletes its keyframes, effects and text (`cascade`). Deleting a media item that clips use is refused (`restrict`), and the UI offers to remove the clips too. Transitions reference two clips and are deleted if either goes (`cascade`).

## API (IPC commands, not HTTP)

The UI calls Rust through Tauri commands. All commands are synchronous requests that return quickly, or they start a job and return a job id. Progress comes back as events.

| command | does | caller | input | output | flow |
| --- | --- | --- | --- | --- | --- |
| `project_create` | new project file | UI | name, ratio, w, h, fps | project id | F01 |
| `project_open` / `project_close` | load or close, run migrations | UI | path | project summary, list of missing media | F07 |
| `project_list_recent` | recent projects | UI | none | list | F07 |
| `project_save` / autosave | flush pending changes (autosave every 30 s and on idle) | engine | none | ok | all |
| `media_import` | probe files, insert rows, queue thumbnails, waveforms, proxies | UI | paths | media items, job ids | F01 |
| `media_relink` | point a missing item at a new path | UI | item id, path | ok | F07 |
| `timeline_get` | fetch tracks and clips for a visible range | UI | range | tracks, clips | F01 |
| `clip_add` | place media on a track | UI | media id, track, time | clip | F01 |
| `clip_move` / `clip_trim` / `clip_split` / `clip_delete` | edit operations | UI | clip id, values | updated clips | F01, F04 |
| `clip_ripple_delete` | delete and close the gap | UI | clip ids | updated clips | F04 |
| `clip_set_props` | transform, opacity, volume, speed, crop, blend | UI | clip id, props | ok | F05, F06 |
| `keyframe_set` / `keyframe_delete` | animate a property | UI | clip, property, time, value, easing | ok | F06 |
| `text_add` / `text_update` | titles and captions | UI | text, style | clip | F02 |
| `subtitle_import_srt` | create text clips from an SRT | UI | path | clips | F02 |
| `adjustment_set` | colour controls, filter | UI | clip, values | ok | F05 |
| `transition_set` | add or change a transition between two clips | UI | clip a, clip b, kind, duration | ok | F04 |
| `track_set` | lock, mute, hide, reorder | UI | track, flags | ok | all |
| `marker_add` / `marker_delete` | markers | UI | time, label | ok | F04 |
| `edit_undo` / `edit_redo` | step through the undo log | UI | none | affected clips | all |
| `preview_seek` / `preview_play` / `preview_pause` | transport | UI | time | frames over `preview://` | all |
| `preview_set_quality` | resolution cap or auto governor | UI | level | ok | all |
| `record_start` / `record_stop` | voiceover capture | UI | device id | media item + clip | F08 |
| `export_start` | render to file, as a job | UI | settings | job id | F01 |
| `export_cancel` | stop and clean up partial output | UI | job id | ok | F01 |
| `assets_list` / `assets_add_to_project` | browse bundled stock pack and place into the project | UI | category | assets | F01, F03 |
| `settings_get` / `settings_set` | cache folder, proxy on/off, language | UI | keys | values | S10 |
| `system_probe` | detect CPU, RAM, GPU, hardware codecs, WebView2 version | engine | none | capabilities, used for defaults | startup |

Events out: `job_progress`, `job_done`, `job_failed`, `media_missing`, `autosave_done`, `capability_changed`.

Webhooks in or out: none. Network use: none by default. An optional update check, if added later, is a single manually-triggered HTTPS request.

Jobs (all in-process):
| job | trigger | what it does |
| --- | --- | --- |
| thumbnails | on import | one frame every N seconds, small JPEG cache |
| waveform | on import | peak data for audio display |
| proxy | on import, only if source is above the machine's comfortable resolution | low-res, intra-frame codec copy for smooth scrubbing |
| autosave | every 30 s of changes | commit, rotate 3 backups |
| export | user action | segmented render, audio mix, mux, verify |
| cache cleanup | on close | remove orphaned proxies past a size cap (default 5 GB, user-set) |

## Licensing notes (stock media, icons, codecs)

These are engineering notes, not legal advice.

- Icons: use Lucide and/or Phosphor and keep their licence texts in `THIRD_PARTY_LICENSES`. Do not copy or trace CapCut's icons.
- Stock media: only bundle clips, music and effects whose licence permits redistribution inside an app. CC0 and Public Domain Mark are safest. Pexels and Pixabay content licences allow free use but have conditions about redistributing the files on their own as a stock library, so a small curated starter pack inside an editor is the careful reading, and each file gets a row in `asset_library` with source URL, author, licence name, licence URL and date checked. Re-verify each licence at the time of bundling. Anything unclear stays out.
- Music has the most traps (contentID claims, sync licences). Prefer CC0 and clearly cleared tracks, or generate simple original loops.
- Codecs: FFmpeg built as LGPL, dynamically linked, with source offer and notice. H.264 and AAC patent licensing is a separate question from copyright. Using the OS encoders (Media Foundation) puts that on the OS vendor's licence; a pro review is wise before a commercial release.
- Fonts: OFL or similar only.

## The parts that bite

- Time and sync: audio is the clock. Video frames are chosen to match the audio position, never the reverse. All times are integer microseconds, converted to frames only at render.
- Variable frame rate sources (phone clips) drift. Normalise through the proxy or probe-and-map step, or timelines will go out of sync.
- Seeking: H.264 long-GOP files seek slowly. Proxies use intra-frame codecs, which is the main fix for weak CPUs.
- Memory: decode only the frames in the preview window. Cap the frame cache by RAM detected at startup (for example 25 percent of free RAM).
- Undo: every edit is a command with an inverse, written to the `undo_log` table. Undo across ripple edits is where bugs hide, so it gets its own test suite.
- Crash safety: autosave writes to a new file and renames. Keep 3 backups. Never write over the only copy.
- Export: render in segments of a few seconds, write each to disk, mux at the end. A crash or a cancel resumes or cleans up.
- Disk full and path problems: check free space before export, handle long Windows paths, Unicode names and OneDrive-synced folders (placeholder files).
- Missing media: the project must open without the files, mark clips as offline and offer relink.
- Hardware variance: Intel HD 4000 drivers are old. GPU features are feature-detected and fail closed to the CPU path.
- WebView2: required on the machine. The installer bootstraps it. If it is missing and offline, show a clear message.
- Unsupported codecs: show a plain error, offer a convert-via-proxy option.
- Concurrency: the engine is the only writer. UI sends commands. No shared mutable state across the IPC boundary.
- Accessibility and DPI: respect Windows scaling, keyboard navigation for all core actions.
- Antivirus false positives: unsigned installers get flagged. Code signing is needed for any public release (cost and certificate are an open item).

## Build and packaging

- Dev builds and the engine test suite can run in this Linux workspace (FFmpeg and Rust install via the package registries). The Windows installer cannot be reliably produced here, because the Windows target and MSI/NSIS tooling want a Windows host. Plan: GitHub Actions on `windows-latest` builds the MSI and NSIS installers, runs the low-spec benchmarks, and uploads artifacts. The user downloads the `.exe` or `.msi` from the Actions run and installs it on their laptop.
- Until the repo exists on the user's GitHub, we can still develop and test here and hand over the source plus the workflow file.
- Code signing is not set up. An unsigned installer triggers Windows SmartScreen, which the user can click through for personal use.

## Build order

1. **Vertical slice (milestone 1).** Screens S01, S02, S03 (minimal), S04, S06, S08, S09. Tables: project, media_item, track, clip. Commands: `project_create`, `project_open`, `media_import`, `clip_add`, `clip_trim`, `clip_split`, `preview_play`, `preview_seek`, `export_start`. Goal: import a clip, cut it, play it back smoothly, export MP4 with sound. Includes the CI job that produces a Windows installer, so the full path (edit, export, install) is proven early.
2. **Must-haves (milestones 2 to 4).**
   - M2, editing core: ripple delete, undo/redo, snapping, multi-track layering, keyboard shortcuts, autosave and reopen, relink. (S08, S01, S10)
   - M3, properties and audio: transform on canvas, constant speed, volume, fades, loudness normalisation, audio waveform, voiceover. (S07, S11)
   - M4, text and colour: titles, basic adjustment sliders, export options (resolution, fps, bitrate, progress, cancel). (S05, S07, S09)
   - M4 also lands the low-spec features: proxies, adaptive preview, software-only path, system probe.
3. **Should-haves (milestone 5).** Keyframes, HSL and curves, crop, reverse/mirror/rotate, snapping refinements, track lock/mute, text presets, SRT import, a first set of transitions and filters, bundled starter stock pack with attribution screen, hardware encode, export codec options.
4. **Could-haves (milestone 6).** Speed curves, blend modes, masks, markers, freeze frame, more effects and stickers, 4K export, MOV and audio-only export, auto-update.
5. **Fixes from replica-entrepreneur.** Not run yet. For a desktop editor this will mean reading public reviews for complaints such as watermarks, forced online login, crashes and slow performance, which line up with our local-first, low-spec positioning.

## Riskiest parts

1. Smooth real-time preview and A/V sync on an i3 with 4 GB RAM. Mitigation: proxies, adaptive governor, benchmark in CI from milestone 1.
2. The export pipeline: effects, transitions and keyframes must render identically in preview and export (one compositor, two outputs).
3. Packaging and codecs: unsigned installers, WebView2 bootstrap, and H.264 licensing before any public release.
