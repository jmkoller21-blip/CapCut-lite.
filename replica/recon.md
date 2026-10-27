# Recon map: CapCut desktop (Windows 10/11)

Scope: the core editing loop. Import media, multi-track timeline, trim/split/ripple, text and captions (manual), basic transitions/filters/effects, colour adjustment, speed, keyframes, audio tools, export to MP4. No cloud, AI, templates or stock library.
For: TBD (personal use, free/open-source release, or a product to sell). Brand and launch steps are held until this is decided.
Date: 2026-10-26

Extra constraint from the user: must run well on low-end ("potato") PCs and ship as a Windows installer. CapCut's own stated minimum is the baseline to beat (see Low-spec targets).

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | CapCut for Windows page | https://capcut.com/resource/capcut-for-windows | system requirements, feature summary |
| 2 | Standard vs Pro comparison | https://capcut.com/resource/capcut-standard-vs-pro | which features are gated, plan prices |
| 3 | How to use CapCut | https://capcut.com/resource/how-to-use-capcut | panel-by-panel workflow, export and share windows |
| 4 | Help: no 2K/4K export option | https://www.capcut.com/help/no-2k-or-4k-option-for-export | export resolution/fps limits, hardware fallbacks |
| 5 | Desktop tutorial (third party) | https://primalvideo.com/guides/capcut-for-pc-mac-tutorial/ | layout, edit order, shortcuts |

Not yet done: the user's own installed copy was not driven, and no screenshots exist in `replica/screens/`. Pixel-level layout, exact shortcut map and hidden states are therefore unverified. Supply screenshots of your own copy (editor, export window, empty project, error dialogs) to raise confidence on those rows.

## Core loop

Drop clips on a timeline, cut and layer them with text, audio and effects, then export a finished MP4.

## Screens

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Home / project list | app launch | start or reopen a project | New project button, recent projects grid, search | empty, filled |
| S02 | New project settings | New project / project settings | name, aspect ratio, resolution, frame rate, media handling | form, dropdowns, ratio presets | default, locked-to-preset |
| S03 | Editor workspace | open a project | the main surface: panels, preview, timeline | S04-S08 below | empty, filled, playing, unsaved |
| S04 | Media panel (left) | Media tab | import and browse project media | import button, thumbnail grid, drag source | empty, filled, importing, unsupported file |
| S05 | Left tool panels | Audio, Text, Stickers, Effects, Transitions, Filters tabs | pick an item to add | category list, preview tiles, add button | default (built-in set only in clone) |
| S06 | Preview window | centre of S03 | playback and on-canvas transform | player, play/scrub, aspect/zoom, safe frame, handles | paused, playing, buffering |
| S07 | Properties panel (right) | select a clip | edit the selected item | tabs: Video, Audio, Speed, Adjustment, Animation; sliders, curve editor | per item type, nothing selected |
| S08 | Timeline | bottom of S03 | arrange, cut, layer | tracks, playhead, ruler, clip blocks, waveform, markers, zoom | empty, filled, selected, snapping |
| S09 | Export dialog | Export button | choose output and render | title, destination, resolution, fps, format, codec, bitrate, audio-only export | idle, rendering with progress, done, error, cancelled |
| S10 | Settings / preferences | menu | cache location, proxy, language, shortcuts | form | default |
| S11 | Voiceover recorder | Record icon | record a mic track | mic picker, level meter, record button | idle, recording, no mic |

Excluded screens (out of scope): template gallery, cloud space, share-to-TikTok/YouTube window, account/subscription, AI tool dialogs.

## Flows

```
F01 Make a basic edit and export
    S01 -> S02 -> S03/S04 (import) -> S08 (drag to timeline) -> S08 (trim, split) -> S09 -> done
    happy path clicks: ~10 (new project, confirm, import, select files, drag, split, trim, export, confirm, done)
    edge: unsupported file format, file moved or deleted after import, disk full on export, project resolution lower than source

F02 Add a title or caption
    S03 -> S05 (Text tab) -> add to timeline -> S07 edit text, font, size, colour -> S06 reposition on canvas
    happy path clicks: ~6
    edge: missing font, very long text, text outside safe area

F03 Add music and balance audio
    S03 -> S05 (Audio tab) or S04 (import audio) -> S08 audio track -> S07 volume, fade, normalise
    happy path clicks: ~6
    edge: source clip has no audio, clipping, mismatched sample rate

F04 Cut and tighten
    S08 select clip -> split at playhead -> delete left/right -> ripple delete gap
    happy path clicks: 3 (or 2 keyboard shortcuts)
    edge: split at clip boundary, ripple across multiple tracks, undo after ripple

F05 Colour and look
    S08 select clip -> S07 Adjustment (basic, HSL, curves) or S05 Filters -> compare in S06
    happy path clicks: ~4
    edge: apply to all clips, reset to default

F06 Animate with keyframes and speed
    S08 place playhead -> S07 click keyframe icon -> change value at second playhead position
    S07 Speed tab -> constant or curve preset
    happy path clicks: ~6
    edge: keyframes on clips later trimmed, speed change changes audio pitch or mutes

F07 Reopen a project
    S01 -> select recent project -> S03 (state restored)
    happy path clicks: 2
    edge: missing media (relink), project from newer app version, corrupted project file

F08 Record a voiceover
    S03 -> S11 -> record -> clip appears on audio track
    happy path clicks: 3
    edge: no microphone, permission denied
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Button | primary, secondary, icon-only, toggle | default, hover, focus, disabled, active | all |
| Slider | single value, with numeric field | default, dragging, disabled, reset | S07 |
| Dropdown / select | standard | default, open, disabled | S02, S09 |
| Text input / numeric stepper | standard | default, focus, error | S02, S07, S09 |
| Tab bar | left panel tabs, right panel tabs | selected, hover | S03, S07 |
| Thumbnail tile | media, effect, transition, filter | default, hover (preview), selected, dragging | S04, S05 |
| Timeline track | video, audio, text, effect, sticker | locked, muted, hidden, selected | S08 |
| Timeline clip | video, audio (with waveform), text, effect | selected, trimming, dragging, missing media | S08 |
| Playhead and ruler | zoomable | scrubbing, snapping | S06, S08 |
| Curve editor | speed curve, colour curves | idle, dragging point | S07 |
| Colour wheel / HSL controls | standard | default, adjusting | S07 |
| Progress bar | export | rendering, done, error | S09 |
| Modal dialog | confirm, error, relink media | open | all |
| Context menu | clip menu, track menu | open | S08 |
| Toast | info, error | shown | all |
| Marker | flag | placed, selected | S08 |

## Inferred data model

```
Project     id, name, aspect_ratio, width, height, fps, created_at, updated_at, app_version
            evidence: S02 settings, S01 list, F07 reopen
            confidence: high

MediaItem   id, project_id, path, type (video | audio | image), duration, width, height, fps, has_audio, proxy_path
            evidence: S04 import, missing-media relink
            confidence: high (proxy_path is our addition for low-spec)

Track       id, project_id, kind (video | audio | text | effect | sticker), order, locked, muted, hidden
            evidence: S08, track toolbar
            confidence: high

Clip        id, track_id, media_item_id (nullable for text), start (timeline), in_point, out_point, speed, speed_curve (json)
            transform (x, y, scale, rotation), opacity, blend_mode, volume, fade_in, fade_out, reverse, mirror, crop
            evidence: S07 Video/Audio/Speed tabs, clip toolbar (freeze, reverse, mirror, rotate, resize)
            confidence: high

TextItem    id, clip_id, content, font, size, colour, alignment, style (json)
            evidence: S05 Text tab, F02
            confidence: medium

Adjustment  id, clip_id, basic (json), hsl (json), curves (json), filter_id, filter_strength
            evidence: S07 Adjustment, S05 Filters
            confidence: medium

Keyframe    id, clip_id, property, time, value, easing
            evidence: keyframe icon in S07, F06
            confidence: medium

Effect / Transition   id, kind, name, params (json), clip_id or between clip_a_id/clip_b_id, duration
            evidence: S05 tabs
            confidence: medium

Marker      id, project_id, time, label
            evidence: timeline toolbar
            confidence: high

ExportJob   id, project_id, resolution, fps, container (mp4 | mov), codec, bitrate, destination, audio_only, status, progress
            evidence: S09 fields as documented
            confidence: high
```

Relationships: Project 1-n Track, Track 1-n Clip, Clip n-1 MediaItem, Clip 1-0..1 TextItem, Clip 1-n Keyframe, Clip 1-n Effect, Transition links 2 adjacent Clips, Project 1-n Marker, Project 1-n ExportJob.

Storage note: a project is a single local JSON (or SQLite) file plus a cache folder. No server is needed. This is what lets the app work offline and stay light.

## Feature matrix

See `features.csv` (73 rows). Buildable: must 32, should 17, could 13. Skip: 11 (marked `skip` in the clone column). Of the buildable rows, 4 are clone-only low-spec and installer goals that the original does not have, so the parity tool scores 58 features, 28 of them must-haves.

## Low-spec targets (the user's "potato PC" constraint)

CapCut's stated minimum, from its Windows page: Windows 10+, Intel Core i3, 4 GB RAM, Intel HD Graphics 4000, 2 GB disk. Proposed budget for the clone, to be confirmed by replica-architect:

- Idle RAM under 300 MB, and under 1.5 GB during a 1080p edit.
- Installer under 150 MB, installed size under 400 MB.
- Cold start under 3 seconds on a 2013-era dual-core.
- Preview must never block the UI: if playback cannot keep up, drop to a lower preview resolution first, then drop frames, never freeze.
- Software-only path must work. GPU acceleration is optional and detected at runtime, not required.
- Proxy media (low-res copies made in the background) is the main tool for smooth editing of 1080p and 4K sources on weak CPUs.
- Export is allowed to be slow but must not crash: render in segments, stream to disk, cap memory.

Reference point from CapCut's own help page: CapCut automatically drops to 1080p export on devices it judges unable to handle higher resolutions, and 4K export depends on hardware and GPU drivers. The clone should do the same, honestly and with a message.

## Out of scope (cannot or should not be cloned)

- CapCut's music library, sound effects, stickers, fonts, effect and transition presets, templates, and stock footage. These are licensed content. The clone ships its own small, openly licensed set (or none).
- AI features (auto captions, background removal, text-to-speech, video translation, AI generation, motion tracking, vocal isolation, relight). Gated to Pro and server- or model-heavy. Conflicts with the potato-PC goal. Possible later as optional, off-by-default add-ons.
- Cloud storage and team collaboration.
- Share-to-TikTok/YouTube and the copyright check. These depend on the platforms' own services.
- Accounts, subscriptions and the Pro paywall.
- CapCut's name, logo, icons, UI artwork and copy. Never copied. Rebrand required before any release.
- The CapCut project file format and any private APIs. Not read, not reverse engineered.

## Size

Screens 11, flows 8, entities 10. Hard parts: (1) the real-time preview engine (decode, composite, play audio in sync) on weak hardware, (2) the export render pipeline with effects, transitions and keyframes, (3) a timeline UI with smooth zoom, snapping and drag editing over hundreds of clips. Also notable: undo/redo across every operation, and Windows installer and codec licensing (H.264 encoding via a patent-clean route).

Size: L (a quarter for a solid core). Rescope to M if effects, transitions and keyframes are cut to a minimum for v1.
