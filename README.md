# SnippetVideo

A Chromium extension that records your screen, a window, or a tab as silent
video. Click the toolbar icon to start, click again to stop. Recordings are kept
in a local library inside the extension and, by default, downloaded as `.webm`
the moment you stop.

Plain JavaScript, no build step, no dependencies. The `extension/` folder is
loaded into Chrome as-is.

Status: **Phase 1 (recorder)**. See `PLAN.md` for the roadmap (editor, crop,
annotations, MP4 export).

## Install (unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder of this repo.
3. Pin the SnippetVideo icon to the toolbar.

After editing a file, press the reload icon on the extension card and reopen
the control window.

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

## Layout

```
extension/                 ← load this folder in Chrome
  manifest.json            MV3 manifest
  icons/                   toolbar icons (idle / recording / paused)
  background/sw.js         service worker: state machine, badge, hotkeys, control window
  library.html, library/   control window: recorder host, timer, recordings list
    recorder.js            picker → MediaRecorder → OPFS chunks → duration fix
    opfs-worker.js         synchronous file writes so every second is on disk
  options.html, options/   settings page
  shared/                  settings, message protocol, formatting, recordings index
  vendor/                  fix-webm-duration (MIT), converted to an ES module
test/                      unit tests:  node --test
tools/                     optional dev tooling (see below)
```

## Optional developer tooling

None of this is needed to run the extension.

```
node --test                      # unit tests, no install needed
node tools/make-icons.mjs        # regenerate the PNG icons, no install needed
cd tools && npm install          # once, for the smoke test only
node smoke.mjs                   # loads extension/ into Chromium and records for real
```

The smoke test uses `playwright-core` with the system Chromium (set
`CHROME_PATH` if it is not on the default path) and Chrome's
`--auto-select-desktop-capture-source` flag so the picker needs no clicking.
On a headless Linux box run it under `xvfb-run`.

## Why the recorder lives in a page, not a background worker

Manifest V3 service workers cannot hold a media stream, and Chrome only lets
the page that opened the `desktopCapture` picker consume the resulting stream
(an offscreen document gets `AbortError: Invalid state`). So the control window
owns the stream and reports progress to the service worker, which drives the
toolbar badge.
