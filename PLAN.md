# SnippetVideo — Chromium screen-recording extension

Planning document. Status: **Phase 1 implemented** (see README for usage). Decisions recorded below.

## Goal

A Chromium (Manifest V3) extension that records the screen as video at 25–60 fps with
configurable quality, no audio. Toolbar button starts/stops, a running timer is visible
while recording. Later phases add cropping (pre / post / follow), a timeline editor
(cut, slice, append), HTML/CSS annotation layers, freeze frames, and MP4 export.

## Constraints that shape the design

- **MV3 service workers cannot hold a MediaStream.** They are killed after ~30 s idle.
- **`desktopCapture` streams are bound to the page that opened the picker.** Verified
  on Chromium 141: consuming the stream id in an offscreen document or any other
  extension page fails with `AbortError: Invalid state`, and calling the picker from
  the service worker requires a target tab with the same restriction. So the
  recorder lives in the **control window** (an extension popup window), which is
  also where the user wanted the controls for a multi-monitor setup.
- **Capture source.** Screen / window / tab via Chrome's picker, opening on the
  *Tab* pane by default (first entry of the sources array).
- **Encoding path.**
  - MVP: `MediaRecorder` with `video/webm;codecs=vp9` (or `vp8` fallback), fps via
    track constraints, quality via `videoBitsPerSecond`. Simple, hardware-assisted.
  - Editor / MP4 phase: WebCodecs `VideoDecoder`/`VideoEncoder` + `mp4-muxer`
    (H.264, hardware encoder where available). Gives frame-exact cuts, canvas
    compositing for crop/annotations/freeze frames, and true `.mp4` output without
    ffmpeg.wasm. ffmpeg.wasm stays a fallback only.
- **Memory.** Stream recorded chunks to the Origin Private File System (OPFS) as they
  arrive, not into a RAM array. Long recordings must not grow the heap.
- **Timer badge.** `chrome.alarms` has a 30 s minimum, so the control window ticks
  every second and messages the service worker, which calls `chrome.action.setBadgeText`.

## Architecture

```
┌──────────────┐  click   ┌────────────────────┐  msgs   ┌──────────────────────────────┐
│ Toolbar icon │ ───────▶ │ Service worker      │ ◀─────▶ │ Control window (popup)       │
│ (action)     │          │ - state machine     │         │ - picker → MediaStream        │
│ badge timer  │ ◀─────── │ - badge / icon      │         │ - MediaRecorder → OPFS worker │
│ hotkeys      │          │ - opens/focuses     │         │ - timer in title, recordings  │
└──────────────┘          │   control window    │         │ - editor (phase 2+)           │
                          └────────┬───────────┘         └──────────────────────────────┘
                                   │
                          ┌────────▼───────────┐
                          │ Options page       │
                          │ fps, quality, src  │
                          └────────────────────┘
```

State machine: `idle → picking → (countdown) → recording ⇄ paused → stopping → idle`.
Settings in `chrome.storage.sync`. Recording files in OPFS, metadata index in
`chrome.storage.local`, live state in `chrome.storage.session`.

### Stack (chosen)

"Stack" just means the set of tools the code is written and built with. Here it is
deliberately minimal:

- **Plain JavaScript ES modules**, loaded by Chrome directly from `extension/`. No
  compiler, no bundler, no `npm install` to run the extension. JSDoc comments carry
  the type documentation where it helps.
- **Plain DOM + CSS** for the pages. The editor will be built the same way; a UI
  library is added only if the timeline UI proves painful without one.
- **Vendored libraries** live in `extension/vendor/` as single ES module files with
  their licence. Currently only the WebM duration patcher.
- Tests: `node --test` for unit tests (no install). An optional Playwright smoke test
  in `tools/` records for real in Chromium.

### Data model (decide early so the editor is non-destructive)

```ts
type Recording = { id; createdAt; fps; width; height; codec; durationMs; file: OPFS path }
type Project = {
  id; sources: Recording[];
  timeline: Clip[];              // ordered; each Clip = { sourceId, inMs, outMs, speed?, freezeAtMs? }
  crop?: { mode: 'static'|'follow'; rect; keyframes? };
  layers: AnnotationLayer[];     // { fromMs, toMs, html, css, transform }
}
```

Raw recordings are never modified. Export renders `Project` → new file.

## Phases

| Phase | Scope | Output |
|---|---|---|
| **0** Scaffold ✅ | Plain-JS layout, manifest, icons, unit + smoke tests, load-unpacked docs | Loads in Chrome |
| **1** Recorder ✅ | Toolbar / hotkey start-stop-pause, badge timer, subtle countdown, fps + quality presets, picker with tab default, WebM to OPFS, auto-stop, auto-download, control window with library (play / download / delete), orphan recovery | Usable recorder |
| **2** Editor shell | Project model, timeline with multiple recordings, trim, split, reorder | Non-destructive assemble & trim |
| **3** Freeze + crop + zoom | Freeze-frame clips, static crop, momentary zoom following the cursor (needs cursor track: content script for tab capture, else manual keyframes) | Crop/zoom in preview |
| **4** Layers | Simple HTML/CSS annotations (text, arrow, box), fade to black, image/logo slides | Composited in preview |
| **5** Export | WebCodecs render pipeline → vendored `mp4-muxer` H.264 (`.mp4`), WebM alternative; progress UI | MP4 download |
| **6** Audio | Optional voice-over / music track, click and key sounds from cursor events | Sound in export |

## Decisions (from the owner's answers)

- Source: Chrome's screen / window / tab picker, **tab pane first**.
- After stop: kept in the library **and** downloaded immediately (quick mode, toggle in
  settings). Editing / stitching comes with the editor.
- Controls: toolbar icon plus a separate **control window** that can sit on another
  monitor; nothing is drawn over the recorded content.
- Countdown: badge + control window title only, no on-screen overlay. Default 3 s.
- Auto-stop: yes, default 15 min. Pause / resume via hotkey.
- Quality: presets. Frame rate: fixed choices, default 30.
- Cursor: system cursor included; custom cursor visuals, click / key sounds are editor
  features (need a cursor event track, phase 3 / 6).
- Distribution: unpacked, personal use.
- Editor scope: assemble recordings, trim, freeze frame, annotate, crop, momentary zoom
  with cursor, sound, fade to black, image / logo slides. No fancy transitions.
- Branch: `claude/screen`.

## Phase 2 brief: editor shell

Goal: open an editor tab from the library, assemble one or more recordings on a
timeline, trim, split, reorder, and play the result back. Nothing is exported yet;
nothing destructive happens to the recording files.

### Data model (`extension/shared/project.js`)

```js
// Stored in chrome.storage.local under 'projects'; one entry per project.
{
  id, name, createdAt, updatedAt,
  clips: [
    // 'video' clips reference a recording; 'freeze' and 'image' clips come in phase 3/4.
    { id, kind: 'video', recordingId, inMs, outMs },
  ],
  // phase 3+: crop, zoomKeyframes, layers
}
```

Pure helpers, unit-tested with `node --test`: `projectDuration`, `clipAt(project, tMs)`
(maps a project time to a clip and a source time), `splitClip(project, clipId, tMs)`,
`trimClip`, `moveClip`, `removeClip`.

### Pages

- `extension/editor.html` + `editor/editor.js`: opened as a normal tab with
  `?project=<id>`. Layout: preview on top, timeline below, clip list / properties on
  the side. Plain DOM; a small UI library only if this gets painful.
- Library gets "Edit" on each recording (creates a project with one clip) and a
  "Projects" section.

### Playback

One `<video>` element per source recording, all preloaded from OPFS blob URLs; the
player switches which one is visible and seeks it as the playhead crosses clip
boundaries. Simple, accurate enough for editing; export (phase 5) re-renders
frame-exactly with WebCodecs and does not depend on this.

### Order of work

1. `project.js` helpers + tests.
2. Editor page with one clip: preview, playhead, scrub, play/pause.
3. Trim handles and split at playhead.
4. Multiple clips: add recording, drag to reorder, delete.
5. Thumbnails on the timeline (canvas snapshots of each source, cached in OPFS).

Where stronger reasoning helps: step 1 (a wrong model here hurts every later phase)
and the playhead/seek logic in step 2.
