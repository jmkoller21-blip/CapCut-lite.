# Lite Editor: notes for Claude (read this first)

A lightweight offline video editor for low-end Windows PCs, built as a clean-room rebuild of the *features and flows* of CapCut desktop's core editing loop. Nothing of CapCut's code, icons, stock media, name or branding is used. Working title only; a real name is chosen at the brand step.

## Standing instructions from the user
- Keep going stage by stage until the final Windows `.exe` installer is built and delivered. Only stop to ask when a real decision comes up.
- **Save every step, big or small, so the next session starts where this one stopped:** commit and push to GitHub after each step, and add a line to `docs/PROGRESS.md`.
- The user has given permission for all file creation in this project.
- Must run well on potato PCs (target: i3 / 4 GB RAM / Intel HD 4000 class). Windows 10/11 only for now.
- Audience (personal / free release / sell) is still undecided. Brand and launch steps are on hold until it is.

## Where things live
- Repo: `jmkoller21-blip/lite-editor` on GitHub (renamed from `CapCut-lite.`; a trailing dot in a repo name breaks Windows CI checkout).
- In a fresh session the repo is attached through the GitHub connector; the managed clone path is `/home/claude/lite-editor` (earlier sessions also used `/home/claude/lite-editor-repo`).
- `engine/`: Rust crate, std only. Project model, FFmpeg process driver, export graph, command layer (`cmd.rs`), local HTTP server (`server.rs`), tests.
- `ui/`: plain ES modules (no bundler). `main.js` entry, `state.js` project state + undo, `timeline.js` canvas timeline, `preview.js` stage + playback, `panels.js` left tool panels, `props.js` right panel, `library.js` import/proxies, `ui.js` helpers.
- `src-tauri/`: Tauri 2 shell. Starts the engine server on a random local port and opens a window on it.
- `stock/`: original CC0 stock (made by `tools/make_stock.py`). `ui/fonts/`: Inter (OFL).
- `docs/`: recon, architecture, schema, design tokens, feature matrix. `replica/` holds the same working copies from the Replica skill pack.
- `.github/workflows/build-windows.yml`: builds the NSIS installer on `windows-latest`, runs engine tests, attaches the `.exe` to a GitHub Release.

## Environment facts (this Linux workspace)
- Cannot build the Windows `.exe` here. GitHub Actions builds it. Download via REST: `gh api -H "Accept: application/octet-stream" repos/OWNER/REPO/releases/assets/ID` (`gh release download` fails: GraphQL is blocked).
- npm, crates.io and PyPI are blocked, so no new dependencies can be installed. That is why the engine uses std only and the UI has no bundler.
- Engine tests: `cargo test --offline --manifest-path engine/Cargo.toml` (16 tests, need local ffmpeg).
- UI smoke test: run `engine/examples/devserver` (`LITE_DATA_DIR=... ./devserver ../ui 7788 ../stock`), open `http://127.0.0.1:7788/?t=devtoken` in headless Chromium (Playwright at `/opt/node22/lib/node_modules/playwright`).
- CI logs cannot be downloaded (blocked host). Read failures from check-run annotations: `gh api repos/OWNER/REPO/check-runs/JOB_ID/annotations`.

## Rules the project follows
- Clean room: never copy CapCut's assets or copy. Open icons / own icons, open fonts, own text, own transitions, own stock.
- Unsigned installer: Windows SmartScreen will warn. Code signing is an open item.
- Check `docs/PROGRESS.md` for the current status and next steps.
