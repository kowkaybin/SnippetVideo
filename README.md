# SnippetVideo

A Chromium extension that records your screen, a window, or a tab as silent
video. Click the toolbar icon to start, click again to stop. Recordings are kept
in a local library inside the extension and, by default, downloaded as `.webm`
the moment you stop.

Status: **Phase 1 (recorder)**. See `PLAN.md` for the roadmap (editor, crop,
annotations, MP4 export).

## Install (unpacked)

1. `npm install`
2. `npm run build` → produces `dist/`
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   pick the `dist/` folder.
4. Pin the SnippetVideo icon to the toolbar.

After changing code, run `npm run build` again and press the reload icon on the
extension card. `npm run dev` rebuilds on every save (you still reload the
extension by hand).

## Use

| Action | How |
|---|---|
| Start | Click the toolbar icon, or `Alt+Shift+R`. Chrome's picker opens on the **Tab** pane by default; choose a tab, window, or screen. |
| Countdown | Shown only on the badge and the control window title (default 3 s). |
| Stop | Click the icon again, `Alt+Shift+R`, or Chrome's own "Stop sharing" bar. |
| Pause / resume | `Alt+Shift+P`, or the Pause button in the control window. |
| Library | `Alt+Shift+L`, or right-click the icon → *Recordings library*. |
| Settings | Right-click the icon → *Options*. |

The **control window** is a small popup that shows the timer, hosts the
recorder, and lists your recordings with play, download and delete. Drag it to
another monitor; it remembers its position. Closing it while recording ends the
recording (Chrome ties the capture stream to that page); whatever was already
written is recovered into the library next time it opens.

Settings: picker default pane, frame rate (25/30/50/60), quality preset
(2/5/10/20 Mbps), countdown, auto-stop limit (default 15 min), auto-download,
cursor.

## Develop

```
npm run typecheck   # tsc
npm test            # vitest unit tests
npm run build       # icons + vite build into dist/
npm run smoke       # loads dist/ into Chromium and records for real (needs a display; use xvfb-run on Linux)
npm run check       # all of the above
```

`scripts/smoke.mjs` uses `playwright-core` with the system Chromium (set
`CHROME_PATH` if it is not on the default path) and the
`--auto-select-desktop-capture-source` flag so the picker needs no clicking.

## Layout

```
src/
  public/manifest.json     MV3 manifest, icons
  background/sw.ts         service worker: state machine, badge, hotkeys, control window
  library.html + library/  control window: recorder host, timer, recordings list
    recorder.ts            picker → MediaRecorder → OPFS chunks → duration fix
    opfs-worker.ts         synchronous file writes so every second is on disk
  options.html + options/  settings page
  shared/                  settings, message types, formatting, recordings index
scripts/make-icons.mjs     generates the PNG icons
scripts/smoke.mjs          end-to-end test
test/                      unit tests
```

## Why the recorder lives in a page, not a background worker

Manifest V3 service workers cannot hold a media stream, and Chrome only lets
the page that opened the `desktopCapture` picker consume the resulting stream
(an offscreen document gets `AbortError: Invalid state`). So the control window
owns the stream and reports progress to the service worker, which drives the
toolbar badge.
