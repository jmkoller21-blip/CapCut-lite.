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
- CI now also runs a Windows acceptance test (`tools/ci-smoke.ps1`): silent install, start the installed app in test mode (`LITE_TEST_PORT` / `LITE_TEST_TOKEN`), engine API import + export, memory readout, uninstall. Results are written into the release body (`gh api repos/jmkoller21-blip/lite-editor/releases --jq '.[0].body'`). Read it before handing any installer to the user.

## Verified so far
- Linux, headless Chromium + real engine (`tools/smoke-ui.js`): full flow passes, no console errors. Export is 1280x720 H.264 + AAC, 6 s, frames not black.
- Installer `build-8` (commit 2c932e1) contents checked by decompressing the NSIS stream: all UI modules (including the page-load fix), `ffmpeg.exe`, `ffprobe.exe`, stock pack, fonts, licences. 95 MB installer, about 271 MB unpacked.
- Windows CI: engine tests step and installer build succeeded for build-8. NOTE: the tests step is `continue-on-error`, so its success flag proves little. The new report in the release body shows the true result.
- Low-spec numbers measured on Linux: engine process about 3.4 MB RSS; FFmpeg peak about 239 MB for a 720p export with layered clips, transition, text and audio mix; thumbnails about 65 MB. NOT yet measured: Windows webview memory (CI report will show it).

## Next
1. Read the CI report in the newest release body. Fix any failing check (likely areas: file dialogs via PowerShell, encoder availability in the LGPL FFmpeg build, window creation).
2. When the report says ACCEPTANCE: PASS, send the installer to the user (REST download, see CLAUDE.md) with the release link.
3. Open items: code signing (SmartScreen warning), H.264 licensing review before any public release, app name and audience decision, keyframes / speed curves / masks not built, per-clip waveform on timeline only for audio.
4. Old release `build-4` is the broken blank-window build. This session cannot edit or delete releases; user should delete it.

## Log
- 2026-10-30: verified build-8 installer contents; measured engine memory; wrote the Windows CI acceptance test and test hook in `src-tauri/src/main.rs`; release body now carries the CI report.
- 2026-10-30: widened timeline track headers (labels were wrapping). Added a CI `concurrency` group so a newer push cancels the older build. Release `build-4` is the broken blank-window build; this session cannot edit releases, so the user should delete it or ignore it.
- 2026-10-30: added `tools/smoke-ui.js` (headless Chromium end-to-end test). Found and fixed one bug (media tab rendered before a project was open). Full flow passes: import, timeline, split, undo/redo, text, transition, filter, stock, playback, export (1280x720 H.264+AAC, 6 s, frames not black), reopen.
- 2026-10-30: added `CLAUDE.md` and this file so a new session can resume from the repo alone.
