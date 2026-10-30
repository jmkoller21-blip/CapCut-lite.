# Progress log

Newest at the bottom. One line per step, big or small. Update and push after every step.

## Done
- Recon map, feature matrix, architecture, SQLite schema, design tokens and component specs (`docs/`).
- Engine (Rust, std only): JSON, project model, FFmpeg driver, media import/probe/thumbnails/waveforms/proxies, export graph (transitions, effects, text, audio mix), command layer, local HTTP server with per-launch token. 16 tests pass.
- Original CC0 stock pack (6 videos, 4 images, 3 music loops, 3 sound effects) with licence records.
- Tauri 2 shell, NSIS installer config, Windows CI workflow.
- Repo renamed to `lite-editor` (trailing dot had broken CI checkout).
- 2026-10-28: first successful Windows build. Release `build-4` has `Lite.Editor_0.1.0_x64-setup.exe` (about 97 MB, NSIS, unsigned). **Do not use it**: `ui/main.js` and several UI modules were never committed, so that build opens to a blank window.
- 2026-10-28/30: wrote the missing UI modules (`main.js`, `ui.js`, `library.js`, `props.js`, `panels.js`): home screen, new-project dialog, transport, shortcuts, settings, media/stock/text/transitions/filters/audio panels, properties panel, export dialog, SRT import, voiceover recording.

## In progress
- Smoke-testing the new UI in headless Chromium against the real engine (import, add to timeline, split, text, transition, export, ffprobe the output).

## Next
1. Fix whatever the smoke test finds. Commit and push.
2. Push, let CI build, download the installer, check it (size, PE header, NSIS marker), send it to the user.
3. Low-spec checks: RAM and start-up time on a throttled run.
4. Open items: code signing, H.264 licensing review before any public release, app name and audience decision, per-clip waveforms and keyframes are not built yet.

## Log
- 2026-10-30: added `CLAUDE.md` and this file so a new session can resume from the repo alone.
