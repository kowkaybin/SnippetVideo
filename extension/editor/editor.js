/**
 * Editor page: loads a project, wires the player, timeline and properties
 * panel, keeps an undo history, and autosaves.
 */
import {
  addClip,
  clipAt,
  clipDuration,
  clipFromRecording,
  getProject,
  moveClip,
  projectDuration,
  removeClip,
  renameProject,
  saveProject,
  splitAt,
  trimClip,
} from '../shared/project.js';
import { listRecordings } from '../shared/library.js';
import { formatBytes, formatDuration, formatTimecode } from '../shared/format.js';
import { send } from '../shared/messages.js';
import { Player } from './player.js';
import { Thumbnailer } from './thumbs.js';
import { Timeline } from './timeline.js';

const $ = (id) => document.getElementById(id);

const projectId = new URLSearchParams(location.search).get('project');
let project = projectId ? await getProject(projectId) : null;
if (!project) {
  document.body.innerHTML = '<main><h1>Project not found</h1><p class="muted">Open a project from the library.</p></main>';
  throw new Error('project not found');
}

let recordings = await listRecordings();
const recordingById = () => new Map(recordings.map((r) => [r.id, r]));
// Drop clips whose recording was deleted from the library.
{
  const known = recordingById();
  const kept = project.clips.filter((c) => known.has(c.recordingId));
  if (kept.length !== project.clips.length) project = { ...project, clips: kept };
}

let selectedId = null;
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
    render();
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
    const url = player.blobUrl(clip.recordingId);
    if (!url) return;
    void thumbs.frame(clip.recordingId, url, sourceMs).then((data) => {
      if (data && img.isConnected) img.src = data;
    });
  },
});
let trimBase = null;

player.onSourceDuration = (recordingId, ms) => {
  // Recovered recordings have no known duration until the video loads.
  let changed = false;
  const clips = project.clips.map((c) => {
    if (c.recordingId !== recordingId || c.sourceDurationMs > 0) return c;
    changed = true;
    return { ...c, sourceDurationMs: ms, outMs: c.outMs > 0 ? c.outMs : ms };
  });
  if (changed) apply({ ...project, clips }, { record: false });
};

player.onTick((t, playing) => {
  timeline.setPlayhead(t);
  $('time').textContent = `${formatTimecode(t)} / ${formatTimecode(player.durationMs)}`;
  $('playPause').textContent = playing ? 'Pause' : 'Play';
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
  $('name').value = project.name;
  $('stageEmpty').hidden = project.clips.length > 0;
  timeline.render(project, selectedId, pxPerSec);
  $('time').textContent = `${formatTimecode(player.timeMs)} / ${formatTimecode(projectDuration(project))}`;
  $('undo').disabled = past.length === 0;
  $('redo').disabled = future.length === 0;
  $('split').disabled = project.clips.length === 0;
  $('deleteClip').disabled = !selectedId;
  renderProps();
}

function renderProps() {
  const clip = project.clips.find((c) => c.id === selectedId);
  $('propsEmpty').hidden = Boolean(clip);
  $('propsBody').hidden = !clip;
  if (!clip) return;
  const rec = recordingById().get(clip.recordingId);
  $('propSource').textContent = `${rec?.name ?? clip.recordingId} · source ${formatDuration(clip.sourceDurationMs)}`;
  if (document.activeElement !== $('propIn')) $('propIn').value = (clip.inMs / 1000).toFixed(2);
  if (document.activeElement !== $('propOut')) $('propOut').value = (clip.outMs / 1000).toFixed(2);
  $('propDuration').textContent = `Clip length ${formatTimecode(clipDuration(clip))}`;
  const idx = project.clips.indexOf(clip);
  $('moveLeft').disabled = idx === 0;
  $('moveRight').disabled = idx === project.clips.length - 1;
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
    render();
  },
};
