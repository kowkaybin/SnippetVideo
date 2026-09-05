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
| **2** Editor shell ✅ | Project model, timeline with multiple recordings, trim, split, reorder | Non-destructive assemble & trim |
| **3** Freeze + crop + zoom ✅ | Freeze-frame clips, static crop, momentary zoom via manual keyframes (a focal point + scale at points along a clip; cursor-following auto-zoom was dropped — manual keyframes cover the "push in on this" use case with far less complexity) | Crop/zoom in preview |
| **4** Layers ✅ | Simple HTML/CSS annotations (text, arrow, box, ellipse) on their own project-time track, fade to black, image/logo slides | Composited in preview |
| **5** Export | WebCodecs render pipeline → vendored `mp4-muxer` H.264 (`.mp4`), WebM alternative; progress UI | MP4 download |
| **6** Audio | Optional voice-over / music track, click and key sounds from cursor events | Sound in export |

## Editor backlog (near-term, additive to the current model)

Raised 2026-09-05. None of these need a rearchitecture — `project.js` already
models clips/layers as plain data, so these are new pure functions plus UI,
same pattern as Phase 3/4.

- **Splice / ripple delete** — remove a range spanning multiple clips (not
  just one clip at a time) and close the gap, shifting everything after it
  left. Complements `splitAt` + `removeClip`.
- **Copy / paste** — clips and layers. Copy stores a plain-data snapshot
  (clip or layer minus its `id`); paste re-inserts it at the playhead with a
  fresh `id`. For a clip this is copying the reference (`recordingId`/
  `assetId` + in/out), not the underlying media — cheap, and consistent with
  "recordings are never modified."
- **Speed ramp** — a `speed` field on video clips (0.25x–4x). Changes how
  `sourceMs` advances in the player loop and how export paces frames; audio
  (once it exists) would need matching pitch-preserving or simple resampling.
- Likely to come up alongside these: multi-select (for splice/copy across
  several clips at once) and a proper clipboard indicator in the UI.

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

## Phase 3/4: freeze, crop, zoom, fade, image slides, annotations

Built together since they share one thing: extending the same non-destructive
`project.js` model rather than bolting on a second system.

### Data model additions

- Two new clip kinds alongside `'video'`: `'freeze'` (a held source frame,
  `atMs`/`holdMs`) and `'image'` (an uploaded asset, `assetId`/`durationMs`).
  `clipDuration` and `clipAt` dispatch on `kind`; `trimClip`/`splitAt` stay
  video-only (freeze/image length changes through `setClipDuration` instead).
- Any clip may carry a static `crop` ({x,y,w,h} fractions), `zoomKeyframes`
  (`{tMs,x,y,scale}`, linearly interpolated by `zoomAt`), and
  `fadeInMs`/`fadeOutMs`. `viewRectAt` composes crop + zoom into one
  source-fraction rectangle — the one piece of math worth getting right once,
  unit-tested, and shared by every consumer.
- `layers` sit on the *project*, not a clip: `{kind, x, y, w, h, color, text,
  startMs, durationMs}` (arrow reuses x/y/w/h as two endpoints). They render
  over the stage whenever the project time falls in their window, independent
  of which clip is playing underneath.
- Uploaded images live in `shared/library.js` next to recordings: OPFS files
  under `/assets/<id>`, metadata in `chrome.storage.local['assets']`.

### Preview approximation

Crop and zoom are rendered with `object-fit: cover` plus one `transform:
scale()` around a `transform-origin` at the view rectangle's center — a
uniform-scale approximation of an arbitrary-aspect crop, good enough to edit
by. `.stage` needs `overflow: hidden` for this (a zoomed frame is larger than
the stage box). Export (phase 5) renders the exact rectangle with WebCodecs
and does not depend on this.

### Placement is numeric, not drag-and-drop

The owner's brief explicitly ruled out "fancy... placement tools", so crop,
zoom keyframes, and every layer are positioned with number fields (percentages
of the frame/stage) rather than on-stage drag handles — the position updates
the live preview immediately either way, and it cut a large amount of pointer
event/handle code for no loss of capability. The one exception: annotation
*timing* (when a layer starts and how long it lasts) is a drag/trim on its own
timeline track, since that's the same interaction as trimming a clip and
reusing it was cheap.

### Cursor-following zoom, reconsidered

The original brief asked for zoom that follows the cursor automatically. That
needs a cursor-position track, which only a content script in a **tab**
capture can provide — screen/window captures have no such source, so it would
have been two different mechanisms for a "sometimes" feature. Manual zoom
keyframes (a focal point + scale you place along the clip) cover the same
"push in on this" editing need for every capture source, with one mechanism
and far less code. Automatic cursor tracking stays a possible follow-up if it
turns out to be missed in practice.

Where stronger reasoning helps: step 1 (a wrong model here hurts every later phase)
and the playhead/seek logic in step 2.
