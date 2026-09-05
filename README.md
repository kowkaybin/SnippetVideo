# SnippetVideo

A Chromium extension that records your screen, a window, or a tab as silent
video. Click the toolbar icon to start, click again to stop. Recordings are kept
in a local library inside the extension and, by default, downloaded as `.webm`
the moment you stop.

Plain JavaScript, no build step, no dependencies. The `extension/` folder is
loaded into Chrome as-is.

Status: **Phase 4 (recorder + editor with freeze frames, crop, zoom, fades,
image slides, and text/shape annotations)**. See `PLAN.md` for the roadmap
(MP4 export, audio).

## Install

Works in Chrome, Edge, Brave and other Chromium browsers. No account, no store,
no build tools.

**1. Get the files.** Either

- click the green **Code** button on GitHub → **Download ZIP**, then unzip it
  somewhere permanent (Chrome loads the extension from that folder every time
  it starts, so do not delete it), or
- `git clone https://github.com/kowkaybin/SnippetVideo.git`

**2. Load it into the browser.**

1. Open a new tab and go to `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`extension`** folder inside the files you downloaded. Not the
   repo root: the folder that contains `manifest.json`.
5. Click the puzzle-piece icon in the toolbar and **pin** SnippetVideo so its
   icon stays visible.

**3. Record.** Click the icon, choose what to capture in Chrome's picker, and
click the icon again to stop. The file downloads and also appears in the
library.

**Updating.** Replace the folder contents with the new version (or `git pull`),
then press the circular reload arrow on the SnippetVideo card in
`chrome://extensions`.

## Use

| Action | How |
|---|---|
| Start | Click the toolbar icon, or `Alt+Shift+R`. Chrome's picker opens on the **Tab** pane by default; choose a tab, window, or screen. |
| Countdown | Shown only on the badge and the control window title (default 3 s). |
| Stop | Click the icon again, `Alt+Shift+R`, or Chrome's own "Stop sharing" bar. |
| Pause / resume | `Alt+Shift+P`, or the Pause button in the control window. |
| Library | `Alt+Shift+L`, or right-click the icon → *Recordings library*. |
| Settings | Right-click the icon → *Options*. |
| Edit | Press **Edit** on a recording in the library. The editor opens in a normal tab. |

The **control window** is a small popup that shows the timer, hosts the
recorder, and lists your recordings with play, download and delete. Drag it to
another monitor; it remembers its position. Closing it while recording ends the
recording (Chrome ties the capture stream to that page); whatever was already
written is recovered into the library next time it opens.

Settings: theme (system/light/dark), picker default pane, frame rate
(25/30/50/60), quality preset (2/5/10/20 Mbps), countdown, auto-stop limit
(default 15 min), auto-download, cursor.

**Dark mode** follows your system by default; pick Light or Dark in Settings
to override it. Applies instantly to every open SnippetVideo page (library,
editor, settings), no reload needed.

### Editor

A project is a sequence of clips cut from your recordings. Nothing is ever
written back to the recordings; every change is saved to the project itself.

- **Add recording** appends another recording from the library as a clip.
  **Add image/logo** appends a still image (a slide, a logo card) held for a
  few seconds — pick one from disk.
- Click a clip to select it; drag the red handles to trim, or type exact start
  and end seconds in the side panel.
- **Split** (or `S`) cuts the clip under the playhead in two.
- Drag a clip to reorder it. **Delete** removes the selected clip.
- `Space` plays, `←`/`→` step one frame, `Shift+←`/`→` step one second,
  `Ctrl+Z` undoes.

**Freeze frame** holds the frame under the playhead for a couple of seconds —
handy for pacing before or after an action. Its length is editable afterwards
(hold, in seconds) in the side panel.

**Crop**, **zoom** and **fade** live in the side panel for whichever clip is
selected:

- *Crop* is a fixed rectangle (X/Y/W/H, as percentages of the frame).
- *Zoom* is one or more keyframes (a focal point + scale) at points along the
  clip; the preview eases between them, for a momentary "push in" on part of
  the screen. Add one at the playhead, delete it from the list.
- *Fade* fades to black over the first/last N seconds of the clip.

These are previewed with a CSS approximation (crop and zoom both narrow the
frame to a rectangle and scale it up to fill the stage); export renders them
exactly later.

**Annotations** (Box, Ellipse, Arrow, Text) sit on the project timeline in
their own track below the clips, independent of which clip is playing
underneath. Add one at the playhead, then edit its position/size (as
percentages of the stage), color, and timing (start/length in seconds) in the
side panel, or drag it on the timeline track to move or trim its timing.

Export to a single file arrives in a later phase.

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
  editor.html, editor/     project editor: player, timeline, thumbnails
  shared/                  settings, message protocol, formatting, recordings/assets index, project model
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
