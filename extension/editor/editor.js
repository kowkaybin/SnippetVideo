/**
 * Editor page: loads a project, wires the player, timeline and properties
 * panel, keeps an undo history, and autosaves.
 */
import {
  addClip,
  addLayer,
  addZoomKeyframe,
  clipAt,
  clipDuration,
  clipFromRecording,
  clipStart,
  getProject,
  imageClipFromAsset,
  insertFreezeAt,
  layersAt,
  moveClip,
  projectDuration,
  removeClip,
  removeLayer,
  removeZoomKeyframe,
  renameProject,
  saveProject,
  setClipDuration,
  setCrop,
  setFade,
  splitAt,
  trimClip,
  updateLayer,
} from '../shared/project.js';
import { addAsset, listAssets, listRecordings } from '../shared/library.js';
import { formatBytes, formatDuration, formatTimecode } from '../shared/format.js';
import { send } from '../shared/messages.js';
import { watchTheme } from '../shared/theme.js';
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
// Drop clips whose recording/asset was deleted from the library. Older projects have no layers array.
{
  const knownRecordings = recordingById();
  const knownAssets = assetById();
  const kept = project.clips.filter((c) => {
    if (c.kind === 'image') return knownAssets.has(c.assetId);
    if (c.kind === 'video' || c.kind === 'freeze') return knownRecordings.has(c.recordingId);
    return true;
  });
  if (kept.length !== project.clips.length || !project.layers) project = { ...project, clips: kept, layers: project.layers ?? [] };
}

let selectedId = null;
let selectedLayerId = null;
let pxPerSec = zoomToPx(Number($('zoom').value));
const past = [];
const future = [];
let saveTimer = 0;

const player = new Player($('stage'));
const thumbs = new Thumbnailer();
const timeline = new Timeline($('timeline'), {
  onSeek: (t) => {
    player.pause();
    player.seek(t);
  },
  onSelect: (id) => {
    selectedId = id;
    selectedLayerId = null;
    render();
  },
  onLayerSelect: (id) => {
    selectedLayerId = id;
    selectedId = null;
    render();
  },
  onLayerMove: (layerId, deltaMs, final) => {
    const base = layerBase ?? (layerBase = project);
    const layer = base.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const next = updateLayer(base, layerId, { startMs: layer.startMs + deltaMs });
    if (final) {
      layerBase = null;
      apply(next, { from: base });
    } else {
      project = next;
      render();
    }
  },
  onLayerTrim: (layerId, edge, deltaMs, final) => {
    const base = layerBase ?? (layerBase = project);
    const layer = base.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const next =
      edge === 'start'
        ? updateLayer(base, layerId, { startMs: layer.startMs + deltaMs, durationMs: layer.durationMs - deltaMs })
        : updateLayer(base, layerId, { durationMs: layer.durationMs + deltaMs });
    if (final) {
      layerBase = null;
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
    const next =
      edge === 'in'
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
let layerBase = null;

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
  renderStageLayers(t);
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
  if (selectedLayerId && !(project.layers ?? []).some((l) => l.id === selectedLayerId)) selectedLayerId = null;
  $('name').value = project.name;
  $('stageEmpty').hidden = project.clips.length > 0;
  timeline.render(project, selectedId, pxPerSec, selectedLayerId);
  $('time').textContent = `${formatTimecode(player.timeMs)} / ${formatTimecode(projectDuration(project))}`;
  $('undo').disabled = past.length === 0;
  $('redo').disabled = future.length === 0;
  $('split').disabled = project.clips.length === 0;
  $('deleteClip').disabled = !selectedId;
  const atPlayhead = clipAt(project, player.timeMs);
  $('freeze').disabled = !atPlayhead || atPlayhead.clip.kind !== 'video';
  renderProps();
  renderLayerProps();
  renderStageLayers(player.timeMs);
}

function renderProps() {
  const clip = project.clips.find((c) => c.id === selectedId);
  $('clipProps').hidden = Boolean(selectedLayerId);
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

function renderLayerProps() {
  const layer = (project.layers ?? []).find((l) => l.id === selectedLayerId);
  $('layerProps').hidden = !layer;
  if (!layer) return;
  const isArrow = layer.kind === 'arrow';
  $('layerText').closest('label').hidden = layer.kind !== 'text';
  $('layerWLabel').textContent = isArrow ? 'X2%' : 'W%';
  $('layerHLabel').textContent = isArrow ? 'Y2%' : 'H%';
  if (document.activeElement !== $('layerText')) $('layerText').value = layer.text;
  if (document.activeElement !== $('layerColor')) $('layerColor').value = layer.color;
  if (document.activeElement !== $('layerX')) $('layerX').value = Math.round(layer.x * 100);
  if (document.activeElement !== $('layerY')) $('layerY').value = Math.round(layer.y * 100);
  if (document.activeElement !== $('layerW')) $('layerW').value = Math.round(layer.w * 100);
  if (document.activeElement !== $('layerH')) $('layerH').value = Math.round(layer.h * 100);
  if (document.activeElement !== $('layerStart')) $('layerStart').value = (layer.startMs / 1000).toFixed(2);
  if (document.activeElement !== $('layerDuration')) $('layerDuration').value = (layer.durationMs / 1000).toFixed(2);
}

/** Draw the annotations visible at project time `tMs` over the stage. */
function renderStageLayers(tMs) {
  const host = $('stageLayers');
  const frag = document.createDocumentFragment();
  for (const layer of layersAt(project, tMs)) {
    const node = document.createElement('div');
    node.className = `stage-layer ${layer.kind}`;
    if (layer.kind === 'arrow') {
      const x1 = layer.x * 100;
      const y1 = layer.y * 100;
      const x2 = layer.w * 100;
      const y2 = layer.h * 100;
      node.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><defs><marker id="head-${layer.id}" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${layer.color}"/></marker></defs><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${layer.color}" stroke-width="1.2" vector-effect="non-scaling-stroke" marker-end="url(#head-${layer.id})" /></svg>`;
    } else {
      node.style.left = `${layer.x * 100}%`;
      node.style.top = `${layer.y * 100}%`;
      node.style.width = `${layer.w * 100}%`;
      node.style.height = `${layer.h * 100}%`;
      node.style.borderColor = layer.color;
      node.style.color = layer.color;
      if (layer.kind === 'text') {
        node.textContent = layer.text;
        node.style.fontSize = `${layer.fontSize}px`;
      }
    }
    frag.append(node);
  }
  host.replaceChildren(frag);
}

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
  selectedLayerId = null;
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
  selectedLayerId = null;
  apply(addClip(project, clip));
});

// ---------- annotation layers ----------

function addLayerOfKind(kind) {
  const next = addLayer(project, { kind, startMs: player.timeMs, durationMs: 3000 });
  selectedLayerId = next.layers[next.layers.length - 1].id;
  selectedId = null;
  apply(next);
}
$('layerAddRect').addEventListener('click', () => addLayerOfKind('rect'));
$('layerAddEllipse').addEventListener('click', () => addLayerOfKind('ellipse'));
$('layerAddArrow').addEventListener('click', () => addLayerOfKind('arrow'));
$('layerAddText').addEventListener('click', () => addLayerOfKind('text'));

$('layerText').addEventListener('change', () => {
  if (selectedLayerId) apply(updateLayer(project, selectedLayerId, { text: $('layerText').value }));
});
$('layerColor').addEventListener('change', () => {
  if (selectedLayerId) apply(updateLayer(project, selectedLayerId, { color: $('layerColor').value }));
});
for (const id of ['layerX', 'layerY', 'layerW', 'layerH']) {
  $(id).addEventListener('change', () => {
    if (!selectedLayerId) return;
    const field = { layerX: 'x', layerY: 'y', layerW: 'w', layerH: 'h' }[id];
    apply(updateLayer(project, selectedLayerId, { [field]: Number($(id).value) / 100 }));
  });
}
$('layerStart').addEventListener('change', () => {
  if (selectedLayerId) apply(updateLayer(project, selectedLayerId, { startMs: Math.round(Number($('layerStart').value) * 1000) }));
});
$('layerDuration').addEventListener('change', () => {
  if (selectedLayerId) apply(updateLayer(project, selectedLayerId, { durationMs: Math.round(Number($('layerDuration').value) * 1000) }));
});
$('layerDelete').addEventListener('click', () => {
  if (!selectedLayerId) return;
  apply(removeLayer(project, selectedLayerId));
  selectedLayerId = null;
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
  if (selectedLayerId) {
    apply(removeLayer(project, selectedLayerId));
    selectedLayerId = null;
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
      selectedLayerId = null;
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
    selectedLayerId = null;
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
  addLayer: (kind) => {
    addLayerOfKind(kind);
    return selectedLayerId;
  },
  selectLayer: (id) => {
    selectedLayerId = id;
    selectedId = null;
    render();
  },
};
