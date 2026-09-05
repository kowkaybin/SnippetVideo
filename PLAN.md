# SnippetVideo — Chromium screen-recording extension

Planning document. Status: **draft, awaiting answers to the open questions at the bottom.**

## Goal

A Chromium (Manifest V3) extension that records the screen as video at 25–60 fps with
configurable quality, no audio. Toolbar button starts/stops, a running timer is visible
while recording. Later phases add cropping (pre / post / follow), a timeline editor
(cut, slice, append), HTML/CSS annotation layers, freeze frames, and MP4 export.

## Constraints that shape the design

- **MV3 service workers cannot hold a MediaStream.** They are killed after ~30 s idle.
  Recording must live in an **offscreen document** (`chrome.offscreen`), which stays
  alive while it has active media.
- **Capture source decides the API.**
  - Current tab only: `chrome.tabCapture.getMediaStreamId()` in the service worker on
    action click, then `getUserMedia` in the offscreen doc. No picker dialog, and
    Region Capture (`CropTarget`) is available for pre-crop.
  - Screen / window / any tab: `chrome.desktopCapture.chooseDesktopMedia()` (Chrome's
    picker) or `getDisplayMedia()` from an extension page with a user gesture.
- **Encoding path.**
  - MVP: `MediaRecorder` with `video/webm;codecs=vp9` (or `vp8` fallback), fps via
    track constraints, quality via `videoBitsPerSecond`. Simple, hardware-assisted.
  - Editor / MP4 phase: WebCodecs `VideoDecoder`/`VideoEncoder` + `mp4-muxer`
    (H.264, hardware encoder where available). Gives frame-exact cuts, canvas
    compositing for crop/annotations/freeze frames, and true `.mp4` output without
    ffmpeg.wasm. ffmpeg.wasm stays a fallback only.
- **Memory.** Stream recorded chunks to the Origin Private File System (OPFS) as they
  arrive, not into a RAM array. Long recordings must not grow the heap.
- **Timer badge.** `chrome.alarms` has a 30 s minimum, so the offscreen doc ticks
  every second and messages the service worker, which calls `chrome.action.setBadgeText`.

## Architecture

```
┌──────────────┐  click   ┌────────────────────┐  msgs   ┌─────────────────────────┐
│ Toolbar icon │ ───────▶ │ Service worker      │ ◀─────▶ │ Offscreen document      │
│ (action)     │          │ - state machine     │         │ - MediaStream + Recorder │
│ badge timer  │ ◀─────── │ - badge / icon      │         │ - chunk → OPFS writer    │
└──────────────┘          │ - streamId / picker │         │ - 1 s timer tick         │
                          └────────┬───────────┘         └─────────────────────────┘
                                   │ opens
                          ┌────────▼───────────┐         ┌─────────────────────────┐
                          │ Options page       │         │ Editor page (phase 2+)  │
                          │ fps, quality, src  │         │ timeline, crop, layers  │
                          └────────────────────┘         └─────────────────────────┘
```

State machine: `idle → (countdown) → recording → stopping → idle`. Settings in
`chrome.storage.sync`. Recordings and edit lists in OPFS + IndexedDB metadata.

### Proposed stack

- TypeScript, Vite + `@crxjs/vite-plugin` (HMR for extension pages), pnpm.
- Preact for options/editor UI (small bundle; React-compatible). Plain DOM is fine
  for the MVP popup if we keep one.
- Vitest for units (state machine, edit-list model). Playwright with the bundled
  Chromium for smoke tests (`--load-extension`).
- ESLint + Prettier.

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
| **0** Scaffold | Vite + CRXJS + TS, manifest, lint, CI, load-unpacked docs | Loads in Chrome, icon does nothing yet |
| **1** MVP record | Click to start/stop, badge timer, fps + quality presets, capture source, WebM to OPFS, download on stop, optional countdown / max duration, keyboard shortcut | Usable recorder |
| **2** Library + editor shell | Recordings list page, player, project model, cut / slice / append on a timeline | Non-destructive trim & join |
| **3** Crop | Pre-crop (Region Capture for tab, constraints/canvas otherwise), post-crop (static rect), follow-crop (keyframed rect, optional cursor-follow) | Crop in preview and export |
| **4** Layers + freeze | HTML/CSS annotation layers with time range, freeze-frame clips with duration | Composited in preview |
| **5** Export | WebCodecs render pipeline → `mp4-muxer` H.264 (`.mp4`), WebM alternative; progress UI | MP4 download |

## Open questions (answer these to unblock Phase 0/1)

1. **Capture source.** Current tab only, or Chrome's screen/window/tab picker? (Tab-only
   is simpler and enables Region Capture pre-crop; picker covers the whole screen.)
   *Default if unanswered: picker, with "this tab" as a shortcut.*
2. **After stop.** Immediately download a `.webm`, or keep it in an in-extension library
   (needed anyway for the editor)? *Default: both — save to library, offer download.*
3. **Toolbar behaviour.** Single click starts with saved settings and single click stops
   (no popup), or click opens a small popup with Start + quick settings? *Default: click
   toggles; right-click → Options; keyboard shortcut Alt+Shift+R.*
4. **Timer semantics.** Elapsed time on the badge only, or also a 3-2-1 countdown before
   start and an optional max-duration auto-stop? *Default: all three, countdown and max
   duration configurable and off by default.*
5. **Quality control.** Presets (Low / Medium / High / Lossless-ish) or explicit bitrate
   and resolution scale (e.g. 100 % / 75 % / 50 %)? *Default: presets that map to
   bitrate + scale, plus an "advanced" custom field.*
6. **fps.** Fixed choices 25 / 30 / 50 / 60, or free input? *Default: fixed choices, 30.*
7. **Cursor.** Show the mouse cursor in the recording? *Default: yes, toggle in options.*
8. **Stack.** OK with TypeScript + Vite + CRXJS + Preact? Any preference for plain JS or
   another framework? *Default: as proposed.*
9. **Target Chrome version / distribution.** Personal unpacked use, or Chrome Web Store
   publishing (affects permission justifications, privacy policy)? *Default: unpacked,
   Chrome 120+, store-ready manifest kept in mind.*
10. **Editor ambition.** Multi-track (clips + layers on separate lanes) or a single video
    lane with layers as overlays attached to clips? *Default: one video lane, one
    layer lane.*
11. **Branch.** This session is pinned to `claude/chromium-screen-recording-wmxbet`.
    You asked for `claude/fabel` — confirm and I will rename / push there.
