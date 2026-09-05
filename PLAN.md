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
| **5** Export | WebCodecs render pipeline (canvas 2D compositing, no GPU backend needed at this scope) → vendored MP4 muxer, WebM/VP9 fallback; progress UI. See brief below. | MP4 download |
| **6** Audio | Optional voice-over / music track, click and key sounds from cursor events | Sound in export |

## Editor backlog (near-term, additive to the current model)

Raised 2026-09-05. None of these need a rearchitecture — `project.js` already
models clips/layers as plain data, so these are new pure functions plus UI,
same pattern as Phase 3/4.

- **Splice / ripple delete** — remove a range spanning multiple clips (not
  just one clip at a time) and close the gap, shifting everything after it
  left. Complements `splitAt` + `removeClip`.
- **Cut / copy / paste / duplicate** — for both clips and layers, as distinct
  operations, not just one "copy" verb:
  - *Copy* stores a plain-data snapshot (clip or layer minus its `id`).
  - *Cut* is copy + remove (ripple delete for a clip; a plain remove for a
    layer, which doesn't leave a gap to close since layers float freely on
    their own time window rather than occupying the main sequence).
  - *Paste* re-inserts the snapshot at the playhead with a fresh `id`. For a
    clip this copies the reference (`recordingId`/`assetId` + in/out), not
    the underlying media — cheap, consistent with "recordings are never
    modified."
  - *Duplicate* is paste-right-after-itself in one step — the common case of
    "I want another one of these, right next to it" without a separate
    copy/paste round trip.
- **Speed ramp** — a `speed` field on video clips (0.25x–4x). Changes how
  `sourceMs` advances in the player loop and how export paces frames; audio
  (once it exists) would need matching pitch-preserving or simple resampling.
- Likely to come up alongside these: multi-select (for splice/copy across
  several clips at once) and a proper clipboard indicator in the UI.
- **Scheduled with Phase 5**: raised 2026-09-05 as work Phase 5 should carry,
  not something to defer past it. Cut/copy/paste/duplicate are UI-and-model
  work with no dependency on export; doing them first (or alongside) means
  export is built and tested against the fuller editing surface instead of
  needing another pass once these land.

### AnnotationLayer redesign — raised 2026-09-05, rendering approach revised 2026-09-05

As shipped, a layer is a still card: one of four fixed shape kinds
(rect/ellipse/text/arrow), appearing fully-formed at `startMs` and vanishing
outright at `startMs + durationMs`. No fade, no move, no scale, no rotation,
and its "what it looks like" and "where/how it sits" are the same field —
`x/y/w/h` means something different for a rect than for an arrow already.

The owner's brief splits this into two independent things, which is the
right split — it's how real compositors (and CSS) already separate it, and
it's a *simplification* here, not just an addition, because one transform
system then serves every content type instead of one per kind:

```js
{
  id, name,                    // a given name, per the brief
  source: 'shape' | 'text' | 'image' | 'video',
  content: { /* source-specific, see below */ },
  anchor: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | ...,
  startMs, durationMs,
  keyframes: [{ tMs, x, y, scale, rotation, opacity }],  // clip-local, lerp'd like zoomKeyframes
}
```

`anchor` picks which point of the content sits at `(x, y)` and which point
scale/rotation pivot around — a formula, not new machinery. `keyframes` is
the same linear-lerp pattern `zoomKeyframes`/`zoomAt` already does, just
applied to a layer's whole transform instead of a clip's crop window.
Deliberately **not** chasing eased/bezier interpolation, a keyframe graph
editor, or motion paths — that's After Effects territory, past the confirmed
scope. A `fadeInMs`/`fadeOutMs`-only version (no full keyframes) is the cheap
first slice if the full array feels like too much UI at once.

**No DOM/HTML/SVG-as-a-document content source, on purpose (revised).** The
owner wants real pro-tool keyframe control, not CSS animations along for the
ride — which means DOM/SVG rasterization (the `html` source originally
sketched here) was solving a problem that doesn't exist. Canvas 2D already
covers the overwhelming majority of what CSS gets reached for, natively, no
DOM involved: `ctx.filter` takes literal CSS filter syntax (blur, brightness,
drop-shadow, ...), `ctx.globalCompositeOperation` gives the same blend modes
as `mix-blend-mode`, gradients/shadows/`roundRect()` are native, and
`Path2D` accepts SVG **path data** directly (`new Path2D('M10 10 L90 90')`)
for arbitrary vector shapes with zero DOM. So `content` for `shape`/`text` is
a small, canvas-native paint vocabulary — fill, stroke, gradient, shadow,
corner radius, blend mode, path data — where every property is a plain
number or color and therefore keyframeable by construction. The one real gap
against HTML: text wrapping and mixed-style rich text aren't free in canvas
(one font/color per `fillText` call) and need a small, well-known
measure-and-break utility — not exotic, just not automatic.

Because content is canvas-native, **the live preview can call the exact same
draw function as export** — a transparent overlay `<canvas>` in the editor
running `drawLayer(ctx, layer, t)` every animation frame, the same function
export calls once per output frame — instead of a CSS approximation on one
side and canvas math on the other. That removes the preview/export
disagreement risk for this subsystem entirely (crop/zoom still lives with
that risk; layers won't).

For a one-off graphic too elaborate for fill/stroke/gradient/text (a badge
combining a logo and custom layout, wrapped/mixed-style text, a snippet found
somewhere) — this is where real HTML/CSS comes back in, deliberately scoped
as a **one-shot compiler, not a live renderer**: author it in real HTML/CSS
(the browser's actual layout engine, no limits), and the moment editing that
content is done — not every playback frame, just on that one edit — it gets
rendered and rasterized once (the same SVG-`foreignObject`-serialize-then-
`drawImage` technique considered earlier for live rendering, fine here
specifically because it now only runs once per edit, not 60 times a second)
into a cached bitmap. From there the layer *is* that bitmap: a completely
normal `image`-source layer, with full keyframe motion through the same
transform system as everything else. What's regained: essentially all of
HTML's authoring convenience (wrapping, rich mixed-style text, flex/grid
composition, arbitrary markup, web fonts) because the real browser engine did
it, faithfully, once.

**Verified 2026-09-05, not assumed**: spiked the foreignObject-to-canvas
technique against real Chromium (the exact build this project targets) with
a `box-shadow` and a `text-shadow` — both rasterized correctly (confirmed by
sampling output pixels and by eye: a properly blurred drop shadow, a crisp
colored text shadow, nothing dropped). So the rasterize-once path is sound
for what it's meant for.

What it does *not* do, correctly by design rather than as an accidental
gap: once a layer is a baked bitmap, scaling it via keyframes scales pixels —
text doesn't re-wrap to a new width, and a baked shadow's blur grows
proportionally with everything else instead of staying independently
tunable. That's identical to how an imported PNG behaves in any professional
editor; nobody expects a logo to reflow when scaled in Premiere either — it's
the accepted trade for arbitrary-HTML authoring power, not a flaw to fix.
Content that genuinely needs to resize and rewrap live (a caption whose box
grows over time) belongs to the *other* content type instead — canvas-native
`text`, redrawn fresh every frame from live, independently keyframeable
numbers (canvas has a real native text-shadow equivalent too:
`ctx.shadowColor`/`shadowBlur`/`shadowOffsetX`/`shadowOffsetY` ahead of a
`fillText` call — computed live, never baked, correct at any scale). The two
paths aren't competing solutions to the same problem; they're the right tool
for two different needs — dynamic text vs. static complex composition — and
the limitations above belong specifically to the static one.

What's still deliberately not supported: a layer whose
*own content* carries an internal live animation (a div with a built-in CSS
glow pulse) — unnecessary complexity for something already ruled out, not a
loss against what's actually wanted.

**`content` by source, and what's straightforward vs. genuinely new:**

- `shape` / `text` — today's rect/ellipse/arrow/text, plus the richer paint
  vocabulary above, carrying only their own visuals since position lives in
  the transform. Straightforward.
- `image` — a floating overlay (watermark, corner logo) instead of occupying
  the main sequence the way an `'image'` *clip* does today; both stay, they
  serve different uses. Straightforward.
- `video` — picture-in-picture: a second recording composited on top of the
  main one. The one genuinely new piece: two videos decoding and playing
  simultaneously, each with its own clock, instead of one active clip at a
  time. Not a rewrite — the main timeline still resolves one clip via
  `clipAt`; each video layer runs alongside it with its own `<video>`
  element and gets drawn on top — but it's real new work in the player, not
  just the data model. A scoped, useful slice of "multi-track"
  (PIP/webcam-overlay/watermark) well short of a full N-track timeline.

Worth doing whichever slice of this lands *before or alongside* Phase 5, not
after: once a layer can animate, both consumers — the live preview and the
canvas-drawing export pass — need to evaluate the same keyframes and the same
content sources, so designing it once against both avoids redoing the
preview side later. Suggested order if/when this starts: transform +
keyframes + anchor + the canvas-native paint vocabulary first (covers
shape/text/image, the bulk of real use, and unifies preview/export
rendering), `video` source second (the new player work).

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

## Scope, confirmed (2026-09-05)

This is a screen-recording-plus-annotation tool, not a photography/video-camera
editor: no color grading, no 4K (typical source is 1080p screen capture), no
open-ended third-party plugin system. That rules out ever needing a GPU
(WebGL/WebGPU) compositor or a proxy-media pipeline — plain `<canvas>` 2D,
drawing the same clip/layer model the editor already renders, is enough for
export at this scale. It also means Phase 5 can target one rendering backend
with confidence instead of hedging toward a heavier one "just in case."

Still on the list, additive to `project.js` like everything in the backlog
above: a `speed` field per video clip (0.25x–4x). It only changes how a
clip's source time advances against project time — every other field
(`crop`, `zoomKeyframes`, `fadeInMs`/`fadeOutMs`, `layers`) is keyed by time,
not frame count, so it composes with all of them for free.

## Phase 5 brief: export

Goal: turn a project into one playable file — primarily `.mp4` (the format
asked for from the start; broadest compatibility), with `.webm` as the
fallback if the browser can't encode H.264. Nothing here changes the editor;
export is a read-only pass over the same `Project` the editor already renders.

### Pipeline

Decode → composite → encode → mux → save, run entirely in the editor tab (no
`desktopCapture`-style page restriction applies here — a finished recording
is just a file, not a live stream):

1. **Decode**: a hidden `<video>` per source recording, seeked to the exact
   source time needed for each output frame, same technique `editor/thumbs.js`
   already uses successfully for thumbnails. No need for `VideoDecoder`
   (WebCodecs' decode side) — the browser's own WebM demux/decode via
   `<video>` is simpler and already proven in this codebase.
2. **Composite**: for each output frame time `t` (stepped by the export fps),
   draw onto an offscreen `<canvas>` using exactly the functions the player
   already calls for preview — `clipAt`, `viewRectAt`, `fadeAlphaAt`,
   `layersAt` — except crop becomes a real `ctx.drawImage(video, sx, sy, sw,
   sh, ...)` source-rectangle instead of the CSS `scale()` approximation the
   live preview uses. This is the one place export is *more* accurate than
   what you see while editing, not just a recording of it. Layers are drawn
   with plain canvas calls (`fillText`, `strokeRect`, an ellipse path, a line
   plus a triangle for arrowheads).
3. **Encode**: `VideoEncoder` (WebCodecs) turns each canvas frame into a
   compressed chunk. Try H.264 (`avc1...`) first via
   `VideoEncoder.isConfigSupported`; if unsupported, fall back to VP9 with a
   WebM container — same pipeline, the codec is just a config value, not a
   different code path.
4. **Mux**: a small vendored MIT muxer (single ES module file, same pattern
   as `vendor/fix-webm-duration.js`) wraps the encoded chunks into the
   container.
5. **Save**: write to OPFS then `chrome.downloads.download`, exactly like a
   finished recording today.

### New pure, testable piece

`frameTimesMs(durationMs, fps)` — the list of output frame timestamps. Small,
mechanical, but everything else in the pipeline iterates over its result, so
it gets the same treatment `project.js` already gets: written first, unit
tested, before anything touches a canvas.

### UI

The already-present, currently-disabled **Export** button gets a small
dialog: format (MP4/WebM), a quality preset (reusing the same
`QUALITY_PRESETS` bitrates recording already uses), a progress bar
(frames done / total), and Cancel (checked between frames — export is not
guaranteed to run faster than the project's own length for a busy timeline,
so a multi-minute project deserves a way out).

### Order of work

1. `frameTimesMs` + tests.
2. Vendor the muxer; a standalone spike (draw one video to canvas, encode a
   few seconds, mux, confirm the file actually plays) before wiring in the
   full timeline — the same "de-risk in isolation first" approach used when
   the desktopCapture stream-binding constraint was originally discovered.
3. `editor/export.js`: the real pipeline against the full model (video,
   freeze, image, crop, zoom, fade, layers).
4. Progress UI, cancel, wire up the Export button.
5. Extend `tools/smoke.mjs`: export a real project in real Chromium and
   verify the output file's magic bytes and duration actually decode — the
   same kind of check already used for recordings, and the only real way to
   know an exported file plays.

Where stronger reasoning helps: step 3, the frame pipeline itself. It has to
reproduce `project.js`'s timeline math exactly, or an exported file will
visibly disagree with what the editor showed — the kind of bug that's easy to
miss by eye and annoying to track down after the fact.

Where stronger reasoning helps: step 1 (a wrong model here hurts every later phase)
and the playhead/seek logic in step 2.
