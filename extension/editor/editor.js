/**
 * Editor page: loads a project, wires the player, timeline and properties
 * panel, keeps an undo history, and autosaves.
 */
import {
  addClip,
  addOverlay,
  addOverlayKeyframe,
  addTrack,
  addZoomKeyframe,
  ANCHOR_OFFSETS,
  clipAt,
  clipDuration,
  clipFromRecording,
  clipStart,
  DEFAULT_OVERLAY_MS,
  getProject,
  imageClipFromAsset,
  insertFreezeAt,
  moveClip,
  overlayBoxAt,
  overlaysAt,
  overlayTransformAt,
  projectDuration,
  removeClip,
  removeOverlay,
  removeOverlayKeyframe,
  removeTrack,
  removeZoomKeyframe,
  renameProject,
  renameTrack,
  saveProject,
  setClipDuration,
  setCrop,
  setFade,
  splitAt,
  trimClip,
  updateOverlay,
} from '../shared/project.js';
import { addAsset, listAssets, listRecordings, readAssetFile } from '../shared/library.js';
import { formatBytes, formatDuration, formatTimecode } from '../shared/format.js';
import { send } from '../shared/messages.js';
import { watchTheme } from '../shared/theme.js';
import { drawOverlay } from '../shared/overlayRender.js';
import { rotationFromDrag, scaleFromDrag } from './overlayGesture.js';
import { Player } from './player.js';
import { Thumbnailer } from './thumbs.js';
import { Timeline } from './timeline.js';

void watchTheme();

const $ = (id) => document.getElementById(id);

const projectId = new URLSearchParams(location.search).get('project');
let project = projectId ? await getProject(projectId) : null;
if (!project) {
  document.body.innerHTML = '<main><h1>Project not found</h1><p class="muted">Open a project from the library.</p></main>';
  throw new Error('project not found');
}

let recordings = await listRecordings();
let assets = await listAssets();
const recordingById = () => new Map(recordings.map((r) => [r.id, r]));
const assetById = () => new Map(assets.map((a) => [a.id, a]));
// Drop clips/overlays whose recording/asset was deleted from the library. Older projects have no overlays array.
{
  const knownRecordings = recordingById();
  const knownAssets = assetById();
  const kept = project.clips.filter((c) => {
    if (c.kind === 'image') return knownAssets.has(c.assetId);
    if (c.kind === 'video' || c.kind === 'freeze') return knownRecordings.has(c.recordingId);
    return true;
  });
  const keptOverlays = (project.overlays ?? []).filter((o) => o.source !== 'image' || knownAssets.has(o.content.assetId));
  if (kept.length !== project.clips.length || keptOverlays.length !== (project.overlays ?? []).length) {
    project = { ...project, clips: kept, overlays: keptOverlays };
  }
}
// Older projects predate tracks entirely: give them one, and put every overlay on it.
if (!project.tracks?.length) {
  const track = { id: `${Date.now().toString(36)}-legacy`, name: 'Track 1' };
  project = { ...project, tracks: [track], overlays: project.overlays.map((o) => ({ ...o, trackId: o.trackId ?? track.id })) };
}

let selectedId = null;
let selectedOverlayId = null;
let pxPerSec = zoomToPx(Number($('zoom').value));
const past = [];
const future = [];
let saveTimer = 0;
const overlayImages = new Map(); // assetId -> HTMLImageElement, for 'image'-source overlays

const player = new Player($('stage'));
const thumbs = new Thumbnailer();
const timeline = new Timeline($('timeline'), {
  onSeek: (t) => {
    player.pause();
    player.seek(t);
  },
  onSelect: (id) => {
    selectedId = id;
    selectedOverlayId = null;
    render();
  },
  onOverlaySelect: (id) => {
    selectedOverlayId = id;
    selectedId = null;
    render();
  },
  onOverlayMove: (overlayId, deltaMs, final) => {
    const base = overlayBase ?? (overlayBase = project);
    const overlay = base.overlays.find((o) => o.id === overlayId);
    if (!overlay) return;
    const next = updateOverlay(base, overlayId, { startMs: overlay.startMs + deltaMs });
    if (final) {
      overlayBase = null;
      apply(next, { from: base });
    } else {
      project = next;
      render();
    }
  },
  onOverlayTrim: (overlayId, edge, deltaMs, final) => {
    const base = overlayBase ?? (overlayBase = project);
    const overlay = base.overlays.find((o) => o.id === overlayId);
    if (!overlay) return;
    const next =
      edge === 'start'
        ? updateOverlay(base, overlayId, { startMs: overlay.startMs + deltaMs, durationMs: overlay.durationMs - deltaMs })
        : updateOverlay(base, overlayId, { durationMs: overlay.durationMs + deltaMs });
    if (final) {
      overlayBase = null;
      apply(next, { from: base });
    } else {
      project = next;
      render();
    }
  },
  onTrim: (clipId, edge, deltaMs, final) => {
    const base = trimBase ?? (trimBase = project);
    const clip = base.clips.find((c) => c.id === clipId);
    if (!clip) return;
    // freeze/image have one size (hold/duration), not an in/out range: the
    // single handle they get (see timeline.js) always adjusts that.
    const next =
      clip.kind !== 'video'
        ? setClipDuration(base, clipId, clipDuration(clip) + deltaMs)
        : edge === 'in'
          ? trimClip(base, clipId, { inMs: clip.inMs + deltaMs })
          : trimClip(base, clipId, { outMs: clip.outMs + deltaMs });
    if (final) {
      trimBase = null;
      apply(next, { from: base });
    } else {
      project = next;
      render();
    }
  },
  onMove: (clipId, slot) => {
    const from = project.clips.findIndex((c) => c.id === clipId);
    const to = slot > from ? slot - 1 : slot;
    apply(moveClip(project, clipId, to));
  },
  thumb: (clip, sourceMs, img) => {
    if (clip.kind === 'image') {
      const url = player.imageUrl(clip.assetId);
      if (url) img.src = url;
      return;
    }
    const url = player.blobUrl(clip.recordingId);
    if (!url) return;
    const t = clip.kind === 'freeze' ? clip.atMs : sourceMs;
    void thumbs.frame(clip.recordingId, url, t).then((data) => {
      if (data && img.isConnected) img.src = data;
    });
  },
});
let trimBase = null;
let overlayBase = null;

player.onSourceDuration = (recordingId, ms) => {
  // Recovered recordings have no known duration until the video loads.
  let changed = false;
  const clips = project.clips.map((c) => {
    if (c.recordingId !== recordingId || (c.kind !== 'video' && c.kind !== 'freeze') || c.sourceDurationMs > 0) return c;
    changed = true;
    return c.kind === 'video' ? { ...c, sourceDurationMs: ms, outMs: c.outMs > 0 ? c.outMs : ms } : { ...c, sourceDurationMs: ms };
  });
  if (changed) apply({ ...project, clips }, { record: false });
};

player.onTick((t, playing) => {
  timeline.setPlayhead(t);
  $('time').textContent = `${formatTimecode(t)} / ${formatTimecode(player.durationMs)}`;
  $('playPause').textContent = playing ? 'Pause' : 'Play';
  renderStageOverlays(t);
  renderStageSelection(t);
});

/** Replace the project, optionally recording the previous value for undo. */
function apply(next, { record = true, from = project } = {}) {
  if (next === project && from === project) return;
  if (record) {
    past.push(from);
    if (past.length > 200) past.shift();
    future.length = 0;
  }
  project = next;
  scheduleSave();
  render();
  void player.setProject(project);
}

function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(project);
  apply(prev, { record: false });
}

function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(project);
  apply(next, { record: false });
}

function scheduleSave() {
  $('saved').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveProject(project);
    $('saved').textContent = 'Saved';
  }, 300);
}

function zoomToPx(v) {
  // 0..100 slider → 8..400 px per second, exponential so both ends are usable.
  return Math.round(8 * Math.pow(50, v / 100));
}

function render() {
  if (selectedId && !project.clips.some((c) => c.id === selectedId)) selectedId = null;
  if (selectedOverlayId && !(project.overlays ?? []).some((o) => o.id === selectedOverlayId)) selectedOverlayId = null;
  $('name').value = project.name;
  $('stageEmpty').hidden = project.clips.length > 0;
  timeline.render(project, selectedId, pxPerSec, selectedOverlayId);
  $('time').textContent = `${formatTimecode(player.timeMs)} / ${formatTimecode(projectDuration(project))}`;
  $('undo').disabled = past.length === 0;
  $('redo').disabled = future.length === 0;
  $('split').disabled = project.clips.length === 0;
  $('deleteClip').disabled = !selectedId;
  const atPlayhead = clipAt(project, player.timeMs);
  $('freeze').disabled = !atPlayhead || atPlayhead.clip.kind !== 'video';
  renderProps();
  renderTrackOptions();
  renderTrackList();
  renderOverlayProps();
  renderStageOverlays(player.timeMs);
  renderStageSelection(player.timeMs);
}

/** The <select> of tracks inside the selected overlay's properties. */
function renderTrackOptions() {
  const select = $('overlayTrack');
  const active = document.activeElement === select;
  select.replaceChildren(
    ...(project.tracks ?? []).map((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      return opt;
    }),
  );
  if (!active && selectedOverlayId) {
    const overlay = project.overlays.find((o) => o.id === selectedOverlayId);
    if (overlay) select.value = overlay.trackId;
  }
}

/** The track management list: rename in place, delete (refused for the last track). */
function renderTrackList() {
  const list = $('trackList');
  list.replaceChildren();
  for (const track of project.tracks ?? []) {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('input');
    name.type = 'text';
    name.value = track.name;
    name.addEventListener('change', () => apply(renameTrack(project, track.id, name.value)));
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.disabled = project.tracks.length <= 1;
    del.title = del.disabled ? "Can't delete the only track" : 'Delete this track (its overlays move to another track)';
    del.addEventListener('click', () => apply(removeTrack(project, track.id)));
    row.append(name, del);
    list.append(row);
  }
}

function renderProps() {
  const clip = project.clips.find((c) => c.id === selectedId);
  $('clipProps').hidden = Boolean(selectedOverlayId);
  $('propsEmpty').hidden = Boolean(clip);
  $('propsBody').hidden = !clip;
  if (!clip) return;
  const isVideo = clip.kind === 'video';
  $('propVideo').hidden = !isVideo;
  $('propHold').hidden = isVideo;
  if (isVideo) {
    const rec = recordingById().get(clip.recordingId);
    $('propSource').textContent = `${rec?.name ?? clip.recordingId} · source ${formatDuration(clip.sourceDurationMs)}`;
    if (document.activeElement !== $('propIn')) $('propIn').value = (clip.inMs / 1000).toFixed(2);
    if (document.activeElement !== $('propOut')) $('propOut').value = (clip.outMs / 1000).toFixed(2);
  } else {
    $('propSource').textContent = clip.kind === 'freeze' ? `Freeze · ${recordingById().get(clip.recordingId)?.name ?? clip.recordingId}` : `Image · ${assetById().get(clip.assetId)?.name ?? clip.assetId}`;
    if (document.activeElement !== $('propHoldMs')) $('propHoldMs').value = (clipDuration(clip) / 1000).toFixed(2);
  }
  $('propDuration').textContent = `Clip length ${formatTimecode(clipDuration(clip))}`;
  const idx = project.clips.indexOf(clip);
  $('moveLeft').disabled = idx === 0;
  $('moveRight').disabled = idx === project.clips.length - 1;

  const crop = clip.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  if (document.activeElement?.id !== 'cropX') $('cropX').value = Math.round(crop.x * 100);
  if (document.activeElement?.id !== 'cropY') $('cropY').value = Math.round(crop.y * 100);
  if (document.activeElement?.id !== 'cropW') $('cropW').value = Math.round(crop.w * 100);
  if (document.activeElement?.id !== 'cropH') $('cropH').value = Math.round(crop.h * 100);

  if (document.activeElement?.id !== 'fadeIn') $('fadeIn').value = ((clip.fadeInMs ?? 0) / 1000).toFixed(2);
  if (document.activeElement?.id !== 'fadeOut') $('fadeOut').value = ((clip.fadeOutMs ?? 0) / 1000).toFixed(2);

  const list = $('zoomList');
  list.replaceChildren();
  for (const kf of clip.zoomKeyframes ?? []) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = `${(kf.tMs / 1000).toFixed(2)}s · ${kf.scale.toFixed(1)}x`;
    const go = document.createElement('button');
    go.textContent = 'Go';
    go.addEventListener('click', () => {
      player.pause();
      player.seek(clipStart(project, clip.id) + kf.tMs);
    });
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', () => apply(removeZoomKeyframe(project, clip.id, kf.tMs)));
    row.append(label, go, del);
    list.append(row);
  }
}

function renderOverlayProps() {
  const overlay = (project.overlays ?? []).find((o) => o.id === selectedOverlayId);
  $('overlayProps').hidden = !overlay;
  if (!overlay) return;
  const active = document.activeElement?.id;
  const isShape = overlay.source === 'shape';
  const isText = overlay.source === 'text';
  $('overlayTextField').hidden = !isText;
  $('overlayColorField').hidden = !isText;
  $('overlayShapeFields').hidden = !isShape;
  $('overlayTextStyle').hidden = !isText;

  if (active !== 'overlayName') $('overlayName').value = overlay.name;
  if (active !== 'overlayTrack') $('overlayTrack').value = overlay.trackId;
  if (active !== 'overlayText' && isText) $('overlayText').value = overlay.content.text;
  if (active !== 'overlayColor' && isText) $('overlayColor').value = overlay.content.color;

  if (isShape) {
    const c = overlay.content;
    if (active !== 'overlayFill') $('overlayFill').value = c.fill ?? '#ff4d4f';
    if (active !== 'overlayFillOn') $('overlayFillOn').checked = Boolean(c.fill);
    if (active !== 'overlayStroke') $('overlayStroke').value = c.stroke ?? '#ff4d4f';
    if (active !== 'overlayStrokeOn') $('overlayStrokeOn').checked = Boolean(c.stroke);
    if (active !== 'overlayStrokeWidth') $('overlayStrokeWidth').value = c.strokeWidth ?? 3;
    $('overlayCornerRadius').closest('label').hidden = c.kind !== 'rect';
    if (active !== 'overlayCornerRadius') $('overlayCornerRadius').value = Math.round((c.cornerRadius ?? 0) * 100);
  }
  if (isText) {
    const c = overlay.content;
    if (active !== 'overlayBg') $('overlayBg').value = c.background ?? '#000000';
    if (active !== 'overlayBgOn') $('overlayBgOn').checked = Boolean(c.background);
    if (active !== 'overlayFontFamily') $('overlayFontFamily').value = c.fontFamily;
    if (active !== 'overlayFontWeight') $('overlayFontWeight').value = c.fontWeight;
  }

  for (const btn of $('overlayAnchorGrid').children) btn.classList.toggle('selected', btn.dataset.anchor === overlay.anchor);
  if (active !== 'overlayW') $('overlayW').value = Math.round(overlay.w * 100);
  if (active !== 'overlayH') $('overlayH').value = Math.round(overlay.h * 100);
  if (active !== 'overlayStart') $('overlayStart').value = (overlay.startMs / 1000).toFixed(2);
  if (active !== 'overlayDuration') $('overlayDuration').value = (overlay.durationMs / 1000).toFixed(2);

  // Keyframe staging fields default to the interpolated value at the playhead,
  // so "Add keyframe" naturally captures "whatever it looks like right now".
  const localMs = player.timeMs - overlay.startMs;
  const t = overlayTransformAt(overlay, localMs);
  if (active !== 'kfX') $('kfX').value = Math.round(t.x * 100);
  if (active !== 'kfY') $('kfY').value = Math.round(t.y * 100);
  if (active !== 'kfScale') $('kfScale').value = t.scale.toFixed(2);
  if (active !== 'kfRotation') $('kfRotation').value = Math.round(t.rotation);
  if (active !== 'kfOpacity') $('kfOpacity').value = t.opacity.toFixed(2);

  const list = $('overlayKeyframeList');
  list.replaceChildren();
  for (const kf of overlay.keyframes) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = `${(kf.tMs / 1000).toFixed(2)}s · ${kf.scale.toFixed(1)}x · ${Math.round(kf.rotation)}°`;
    const go = document.createElement('button');
    go.textContent = 'Go';
    go.addEventListener('click', () => {
      player.pause();
      player.seek(overlay.startMs + kf.tMs);
    });
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', () => apply(removeOverlayKeyframe(project, overlay.id, kf.tMs)));
    row.append(label, go, del);
    list.append(row);
  }
}

/** Load (and cache) the image for an 'image'-source overlay's asset. */
async function ensureOverlayImage(assetId) {
  if (overlayImages.has(assetId)) return overlayImages.get(assetId);
  const file = await readAssetFile(assetId);
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  });
  overlayImages.set(assetId, img);
  return img;
}

/** Draw the overlays visible at project time `tMs` onto the stage's overlay canvas. */
function renderStageOverlays(tMs) {
  const canvas = $('stageOverlays');
  const rect = $('stage').getBoundingClientRect();
  if (canvas.width !== rect.width) canvas.width = rect.width;
  if (canvas.height !== rect.height) canvas.height = rect.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const overlay of overlaysAt(project, tMs)) {
    const localMs = tMs - overlay.startMs;
    const drawn = overlayForRender(overlay, localMs);
    if (overlay.source === 'image') {
      const img = overlayImages.get(overlay.content.assetId);
      if (!img) void ensureOverlayImage(overlay.content.assetId).then(() => renderStageOverlays(player.timeMs));
      drawOverlay(ctx, drawn, localMs, canvas.width, canvas.height, { image: img });
    } else {
      drawOverlay(ctx, drawn, localMs, canvas.width, canvas.height);
    }
  }
}

// ---------- direct manipulation: move/resize/rotate the selected overlay on the stage ----------

/** {overlayId, localMs, x, y, scale, rotation, opacity} while a drag is live; null otherwise. */
let overlayDrag = null;

/** During a live drag, substitute a one-keyframe overlay so it renders exactly the preview state. */
function overlayForRender(overlay, localMs) {
  if (!overlayDrag || overlayDrag.overlayId !== overlay.id) return overlay;
  const { x, y, scale, rotation, opacity } = overlayDrag;
  return { ...overlay, keyframes: [{ tMs: localMs, x, y, scale, rotation, opacity }] };
}

function clampToOverlay(overlay, tMs) {
  return Math.max(0, Math.min(overlay.durationMs, tMs - overlay.startMs));
}

/** Position the selection chrome over the selected overlay, hidden if it isn't on-screen right now. */
function renderStageSelection(tMs) {
  const sel = $('stageSelection');
  const overlay = project.overlays?.find((o) => o.id === selectedOverlayId);
  if (!overlay) {
    sel.hidden = true;
    return;
  }
  const localMs = tMs - overlay.startMs;
  if (localMs < 0 || localMs >= overlay.durationMs) {
    sel.hidden = true;
    return;
  }
  const stageRect = $('stage').getBoundingClientRect();
  const box = overlayBoxAt(overlayForRender(overlay, localMs), localMs);
  const [ax, ay] = ANCHOR_OFFSETS[overlay.anchor] ?? ANCHOR_OFFSETS.center;
  // stageRect is in physical (post-`zoom`) pixels, but a raw style.left/top/
  // width/height assignment is interpreted in local (pre-`zoom`) pixels -
  // divide by the actual applied zoom, same fix as the timeline resizer.
  const zoom = Number(getComputedStyle(document.body).zoom) || 1;
  sel.hidden = false;
  sel.style.left = `${(box.x * stageRect.width) / zoom}px`;
  sel.style.top = `${(box.y * stageRect.height) / zoom}px`;
  sel.style.width = `${(box.w * stageRect.width) / zoom}px`;
  sel.style.height = `${(box.h * stageRect.height) / zoom}px`;
  sel.style.transformOrigin = `${ax * 100}% ${ay * 100}%`;
  sel.style.transform = `rotate(${box.rotation}deg)`;
}

/**
 * Wire a drag gesture on `target` (the selection box body, a resize handle,
 * or the rotate handle) that live-previews via `overlayDrag` and commits one
 * keyframe on release. `computeNext(ctx, pointerEvent)` returns whichever of
 * {x,y,scale,rotation} this particular gesture changes; the rest carry over
 * from the value at drag-start.
 */
function bindOverlayDrag(target, computeNext) {
  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // a handle's drag must never also trigger the box's own move-drag
    const overlay = project.overlays.find((o) => o.id === selectedOverlayId);
    if (!overlay) return;
    const localMs = clampToOverlay(overlay, player.timeMs);
    const start = overlayTransformAt(overlayForRender(overlay, localMs), localMs);
    const stageRect = $('stage').getBoundingClientRect();
    const handleRect = target.getBoundingClientRect();
    const ctx = {
      start,
      stageRect,
      // The anchor point's actual on-screen position - resize/rotate pivot here.
      cx: stageRect.left + start.x * stageRect.width,
      cy: stageRect.top + start.y * stageRect.height,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      handleX: handleRect.left + handleRect.width / 2,
      handleY: handleRect.top + handleRect.height / 2,
    };
    const move = (ev) => {
      overlayDrag = { overlayId: overlay.id, localMs, x: start.x, y: start.y, scale: start.scale, rotation: start.rotation, opacity: start.opacity, ...computeNext(ctx, ev) };
      renderStageOverlays(player.timeMs);
      renderStageSelection(player.timeMs);
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      move(ev); // capture the final position even if the browser skipped a move event right before pointerup
      const { localMs: tMs, x, y, scale, rotation, opacity } = overlayDrag;
      overlayDrag = null;
      apply(addOverlayKeyframe(project, overlay.id, { tMs, x, y, scale, rotation, opacity }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

bindOverlayDrag($('stageSelection'), (ctx, ev) => ({
  x: ctx.start.x + (ev.clientX - ctx.startPointerX) / ctx.stageRect.width,
  y: ctx.start.y + (ev.clientY - ctx.startPointerY) / ctx.stageRect.height,
}));
for (const handle of document.querySelectorAll('#stageSelection .sel-handle.corner')) {
  bindOverlayDrag(handle, (ctx, ev) => ({
    scale: scaleFromDrag({ cx: ctx.cx, cy: ctx.cy, startHandleX: ctx.handleX, startHandleY: ctx.handleY, startScale: ctx.start.scale }, ev.clientX, ev.clientY),
  }));
}
bindOverlayDrag(document.querySelector('#stageSelection .sel-rotate'), (ctx, ev) => ({
  rotation: rotationFromDrag(ctx.cx, ctx.cy, ev.clientX, ev.clientY),
}));

// ---------- controls ----------

$('playPause').addEventListener('click', () => player.toggle());
$('split').addEventListener('click', split);
$('deleteClip').addEventListener('click', deleteSelected);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('zoom').addEventListener('input', () => {
  pxPerSec = zoomToPx(Number($('zoom').value));
  render();
});
$('name').addEventListener('change', () => apply(renameProject(project, $('name').value.trim() || 'Untitled'), { record: false }));
$('propIn').addEventListener('change', () => {
  if (selectedId) apply(trimClip(project, selectedId, { inMs: Math.round(Number($('propIn').value) * 1000) }));
});
$('propOut').addEventListener('change', () => {
  if (selectedId) apply(trimClip(project, selectedId, { outMs: Math.round(Number($('propOut').value) * 1000) }));
});
$('propHoldMs').addEventListener('change', () => {
  if (selectedId) apply(setClipDuration(project, selectedId, Math.round(Number($('propHoldMs').value) * 1000)));
});

// ---------- crop, zoom, fade ----------

function cropFromFields() {
  return {
    x: Number($('cropX').value) / 100,
    y: Number($('cropY').value) / 100,
    w: Number($('cropW').value) / 100,
    h: Number($('cropH').value) / 100,
  };
}
for (const id of ['cropX', 'cropY', 'cropW', 'cropH']) {
  $(id).addEventListener('change', () => {
    if (selectedId) apply(setCrop(project, selectedId, cropFromFields()));
  });
}
$('cropClear').addEventListener('click', () => {
  if (selectedId) apply(setCrop(project, selectedId, null));
});

$('zoomAdd').addEventListener('click', () => {
  if (!selectedId) return;
  const start = clipStart(project, selectedId);
  apply(
    addZoomKeyframe(project, selectedId, {
      tMs: player.timeMs - start,
      x: Number($('zoomX').value) / 100,
      y: Number($('zoomY').value) / 100,
      scale: Number($('zoomScale').value),
    }),
  );
});

$('fadeIn').addEventListener('change', () => {
  if (selectedId) apply(setFade(project, selectedId, { fadeInMs: Math.round(Number($('fadeIn').value) * 1000) }));
});
$('fadeOut').addEventListener('change', () => {
  if (selectedId) apply(setFade(project, selectedId, { fadeOutMs: Math.round(Number($('fadeOut').value) * 1000) }));
});

$('freeze').addEventListener('click', () => {
  player.pause();
  const at = player.timeMs;
  const next = insertFreezeAt(project, at);
  if (next === project) return;
  const loc = clipAt(next, at);
  selectedId = loc?.clip.id ?? null;
  selectedOverlayId = null;
  apply(next);
});

// ---------- image / logo slides ----------

function loadImageSize(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.addEventListener('load', () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    });
    img.addEventListener('error', () => {
      resolve({ width: 0, height: 0 });
      URL.revokeObjectURL(url);
    });
    img.src = url;
  });
}

$('addImage').addEventListener('click', () => $('imageFile').click());
$('imageFile').addEventListener('change', async () => {
  const file = $('imageFile').files?.[0];
  $('imageFile').value = '';
  if (!file) return;
  const size = await loadImageSize(file);
  const asset = await addAsset(file, size);
  assets = await listAssets();
  const clip = imageClipFromAsset(asset);
  selectedId = clip.id;
  selectedOverlayId = null;
  apply(addClip(project, clip));
});

// ---------- overlays ----------

function addOverlayOfKind(source, kind) {
  const content = source === 'shape' ? { kind } : undefined;
  const next = addOverlay(project, { source, content, startMs: player.timeMs, durationMs: DEFAULT_OVERLAY_MS });
  selectedOverlayId = next.overlays[next.overlays.length - 1].id;
  selectedId = null;
  apply(next);
}
$('overlayAddRect').addEventListener('click', () => addOverlayOfKind('shape', 'rect'));
$('overlayAddEllipse').addEventListener('click', () => addOverlayOfKind('shape', 'ellipse'));
$('overlayAddArrow').addEventListener('click', () => addOverlayOfKind('shape', 'arrow'));
$('overlayAddText').addEventListener('click', () => addOverlayOfKind('text'));

$('overlayAddImage').addEventListener('click', () => $('overlayImageFile').click());
$('overlayImageFile').addEventListener('change', async () => {
  const file = $('overlayImageFile').files?.[0];
  $('overlayImageFile').value = '';
  if (!file) return;
  const size = await loadImageSize(file);
  const asset = await addAsset(file, size);
  assets = await listAssets();
  const next = addOverlay(project, { source: 'image', content: { assetId: asset.id }, startMs: player.timeMs, durationMs: DEFAULT_OVERLAY_MS });
  selectedOverlayId = next.overlays[next.overlays.length - 1].id;
  selectedId = null;
  apply(next);
});

$('overlayName').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { name: $('overlayName').value.trim() || 'Overlay' }));
});
$('overlayText').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { content: { text: $('overlayText').value } }));
});
$('overlayColor').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { content: { color: $('overlayColor').value } }));
});
$('overlayTrack').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { trackId: $('overlayTrack').value }));
});

// ---------- shape/text style: fill/stroke/background are a checkbox (on/off) plus a color ----------

function wireColorToggle(checkboxId, colorId, field) {
  const commit = () => {
    if (!selectedOverlayId) return;
    apply(updateOverlay(project, selectedOverlayId, { content: { [field]: $(checkboxId).checked ? $(colorId).value : null } }));
  };
  $(checkboxId).addEventListener('change', commit);
  $(colorId).addEventListener('change', commit);
}
wireColorToggle('overlayFillOn', 'overlayFill', 'fill');
wireColorToggle('overlayStrokeOn', 'overlayStroke', 'stroke');
wireColorToggle('overlayBgOn', 'overlayBg', 'background');

$('overlayStrokeWidth').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { content: { strokeWidth: Number($('overlayStrokeWidth').value) } }));
});
$('overlayCornerRadius').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { content: { cornerRadius: Number($('overlayCornerRadius').value) / 100 } }));
});
$('overlayFontFamily').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { content: { fontFamily: $('overlayFontFamily').value } }));
});
$('overlayFontWeight').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { content: { fontWeight: $('overlayFontWeight').value } }));
});

// ---------- style presets: one-click content patches ----------

const SHAPE_PRESETS = [
  { name: 'Outline', content: { fill: null, stroke: '#ff4d4f', cornerRadius: 0 } },
  { name: 'Outline blue', content: { fill: null, stroke: '#3b82f6', cornerRadius: 0 } },
  { name: 'Filled', content: { fill: '#ff4d4f', stroke: null, cornerRadius: 0 } },
  { name: 'Rounded', content: { fill: '#3b82f6', stroke: null, cornerRadius: 0.2 } },
  { name: 'Pill', content: { fill: null, stroke: '#ffffff', cornerRadius: 0.5 } },
];
const TEXT_PRESETS = [
  { name: 'Plain', content: { color: '#ffffff', background: null } },
  { name: 'Caption', content: { color: '#ffffff', background: 'rgba(0,0,0,0.65)' } },
  { name: 'Alert', content: { color: '#ffffff', background: '#dc2626' } },
  { name: 'Highlight', content: { color: '#111111', background: '#fde047' } },
];

function renderPresets(containerId, presets, isText) {
  const container = $(containerId);
  for (const preset of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = isText ? 'preset-swatch text-preset' : 'preset-swatch';
    btn.title = preset.name;
    if (isText) {
      btn.textContent = 'Aa';
      btn.style.color = preset.content.color;
      btn.style.background = preset.content.background ?? 'transparent';
    } else {
      btn.style.background = preset.content.fill ?? 'transparent';
      btn.style.borderColor = preset.content.stroke ?? 'transparent';
      btn.style.borderWidth = '3px';
      btn.style.borderRadius = `${(preset.content.cornerRadius ?? 0) * 40}px`;
    }
    btn.addEventListener('click', () => {
      if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { content: preset.content }));
    });
    container.append(btn);
  }
}
renderPresets('shapePresets', SHAPE_PRESETS, false);
renderPresets('textPresets', TEXT_PRESETS, true);

$('trackAdd').addEventListener('click', () => {
  const name = $('newTrackName').value;
  $('newTrackName').value = '';
  apply(addTrack(project, name));
});

$('overlayAnchorGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { anchor: btn.dataset.anchor }));
});
$('overlayW').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { w: Number($('overlayW').value) / 100 }));
});
$('overlayH').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { h: Number($('overlayH').value) / 100 }));
});
$('overlayStart').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { startMs: Math.round(Number($('overlayStart').value) * 1000) }));
});
$('overlayDuration').addEventListener('change', () => {
  if (selectedOverlayId) apply(updateOverlay(project, selectedOverlayId, { durationMs: Math.round(Number($('overlayDuration').value) * 1000) }));
});
$('overlayKeyframeAdd').addEventListener('click', () => {
  if (!selectedOverlayId) return;
  const overlay = project.overlays.find((o) => o.id === selectedOverlayId);
  const tMs = Math.max(0, Math.min(overlay.durationMs, player.timeMs - overlay.startMs));
  apply(
    addOverlayKeyframe(project, selectedOverlayId, {
      tMs,
      x: Number($('kfX').value) / 100,
      y: Number($('kfY').value) / 100,
      scale: Number($('kfScale').value),
      rotation: Number($('kfRotation').value),
      opacity: Number($('kfOpacity').value),
    }),
  );
});
$('overlayDelete').addEventListener('click', () => {
  if (!selectedOverlayId) return;
  apply(removeOverlay(project, selectedOverlayId));
  selectedOverlayId = null;
  render();
});

$('moveLeft').addEventListener('click', () => {
  const i = project.clips.findIndex((c) => c.id === selectedId);
  if (i > 0) apply(moveClip(project, selectedId, i - 1));
});
$('moveRight').addEventListener('click', () => {
  const i = project.clips.findIndex((c) => c.id === selectedId);
  if (i >= 0 && i < project.clips.length - 1) apply(moveClip(project, selectedId, i + 1));
});
$('openLibrary').addEventListener('click', () => void send({ target: 'background', type: 'ui:open-library' }));

function split() {
  const next = splitAt(project, player.timeMs);
  if (next !== project) {
    const loc = clipAt(next, player.timeMs);
    selectedId = loc?.clip.id ?? selectedId;
    apply(next);
  }
}

function deleteSelected() {
  if (selectedOverlayId) {
    apply(removeOverlay(project, selectedOverlayId));
    selectedOverlayId = null;
    render();
    return;
  }
  if (!selectedId) return;
  apply(removeClip(project, selectedId));
  selectedId = null;
  render();
}

function stepMs() {
  const loc = clipAt(project, player.timeMs);
  const rec = loc ? recordingById().get(loc.clip.recordingId) : null;
  return 1000 / (rec?.fps || 30);
}

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  switch (e.key) {
    case ' ':
      e.preventDefault();
      player.toggle();
      break;
    case 's':
    case 'S':
      split();
      break;
    case 'Delete':
    case 'Backspace':
      deleteSelected();
      break;
    case 'ArrowLeft':
      player.pause();
      player.seek(player.timeMs - (e.shiftKey ? 1000 : stepMs()));
      break;
    case 'ArrowRight':
      player.pause();
      player.seek(player.timeMs + (e.shiftKey ? 1000 : stepMs()));
      break;
    case 'Home':
      player.pause();
      player.seek(0);
      break;
    case 'End':
      player.pause();
      player.seek(player.durationMs);
      break;
  }
});

// ---------- add recording dialog ----------

$('addClip').addEventListener('click', async () => {
  recordings = await listRecordings();
  const list = $('addList');
  list.replaceChildren();
  if (recordings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No recordings in the library yet.';
    list.append(empty);
  }
  for (const r of recordings) {
    const row = document.createElement('div');
    row.className = 'panel row';
    const info = document.createElement('div');
    info.className = 'grow';
    info.textContent = `${r.name} · ${formatDuration(r.durationMs)} · ${formatBytes(r.bytes)}`;
    const btn = document.createElement('button');
    btn.textContent = 'Add';
    btn.addEventListener('click', () => {
      const clip = clipFromRecording(r);
      selectedId = clip.id;
      selectedOverlayId = null;
      apply(addClip(project, clip));
      $('addDialog').close();
    });
    row.append(info, btn);
    list.append(row);
  }
  $('addDialog').showModal();
});
$('addClose').addEventListener('click', () => $('addDialog').close());

window.addEventListener('resize', render);
window.addEventListener('beforeunload', () => {
  if ($('saved').textContent === 'Saving…') void saveProject(project);
});

// ---------- timeline resize ----------

const TIMELINE_H_KEY = 'snippet-timeline-h';
const timelineEl = $('timeline');
let savedTimelineH = 184;
try {
  savedTimelineH = Number(localStorage.getItem(TIMELINE_H_KEY)) || 184;
} catch {
  // Storage can be unavailable in odd contexts; the default height is fine.
}
timelineEl.style.height = `${Math.min(400, Math.max(120, savedTimelineH))}px`;
$('timelineResizer').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  $('timelineResizer').classList.add('dragging');
  const startY = e.clientY;
  const startH = timelineEl.getBoundingClientRect().height;
  // getBoundingClientRect() and pointer coordinates are both in physical
  // (post-`zoom`) pixels, but a raw `style.height` assignment is read back
  // in local (pre-`zoom`) pixels - divide by the actual applied zoom to
  // convert, rather than assuming a fixed factor that could drift from CSS.
  const zoom = Number(getComputedStyle(document.body).zoom) || 1;
  const move = (ev) => {
    const physicalH = startH - (ev.clientY - startY);
    const h = Math.min(400, Math.max(120, physicalH / zoom));
    timelineEl.style.height = `${h}px`;
    render(); // re-measure the ruler/track width against the new height
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    $('timelineResizer').classList.remove('dragging');
    try {
      localStorage.setItem(TIMELINE_H_KEY, String(parseFloat(timelineEl.style.height)));
    } catch {
      // Best effort; the height just won't persist across reloads.
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ---------- boot ----------

await player.setProject(project);
render();
$('saved').textContent = 'Saved';

// Small hook for the end-to-end test; harmless otherwise.
window.__snippet = {
  get project() {
    return project;
  },
  seek: (t) => player.seek(t),
  split,
  select: (id) => {
    selectedId = id;
    selectedOverlayId = null;
    render();
  },
  freeze: () => $('freeze').click(),
  addImage: async (file) => {
    const size = await loadImageSize(file);
    const asset = await addAsset(file, size);
    assets = await listAssets();
    const clip = imageClipFromAsset(asset);
    selectedId = clip.id;
    apply(addClip(project, clip));
    return clip.id;
  },
  setCrop: (id, crop) => apply(setCrop(project, id, crop)),
  addZoomKeyframe: (id, kf) => apply(addZoomKeyframe(project, id, kf)),
  setFade: (id, fade) => apply(setFade(project, id, fade)),
  addOverlay: (source, kind) => {
    addOverlayOfKind(source, kind);
    return selectedOverlayId;
  },
  addOverlayImage: async (file) => {
    const size = await loadImageSize(file);
    const asset = await addAsset(file, size);
    assets = await listAssets();
    const next = addOverlay(project, { source: 'image', content: { assetId: asset.id }, startMs: player.timeMs, durationMs: DEFAULT_OVERLAY_MS });
    selectedOverlayId = next.overlays[next.overlays.length - 1].id;
    apply(next);
    return selectedOverlayId;
  },
  addOverlayKeyframe: (id, kf) => apply(addOverlayKeyframe(project, id, kf)),
  selectOverlay: (id) => {
    selectedOverlayId = id;
    selectedId = null;
    render();
  },
};
