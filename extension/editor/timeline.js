/**
 * Timeline view: a ruler, one track of clips laid out left to right, a
 * playhead, trim handles on the selected clip, drag-and-drop reordering, and
 * an overlay track below it (row-packed automatically: overlays whose times
 * don't collide share a row, a colliding one opens the next). It owns no
 * state; the editor re-renders it after every change.
 */
import { assignOverlayRows, clipDuration } from '../shared/project.js';
import { formatDuration } from '../shared/format.js';

const KIND_LABEL = { freeze: '❄', image: '🖼' };

const THUMB_W = 96;
const END_PAD = 120;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300];
/** Height of one overlay row; the track grows to fit however many rows are needed. */
const ROW_H = 26;

export class Timeline {
  /**
   * @param {HTMLElement} root
   * @param {{
   *   onSeek: (tMs: number) => void,
   *   onSelect: (clipId: string | null) => void,
   *   onTrim: (clipId: string, edge: 'in' | 'out', deltaMs: number, final: boolean) => void,
   *   onMove: (clipId: string, slot: number) => void,
   *   thumb: (clip, sourceMs: number, img: HTMLImageElement) => void,
   *   onOverlaySelect: (overlayId: string | null) => void,
   *   onOverlayMove: (overlayId: string, deltaMs: number, final: boolean) => void,
   *   onOverlayTrim: (overlayId: string, edge: 'start' | 'end', deltaMs: number, final: boolean) => void,
   * }} handlers
   */
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.pxPerSec = 60;
    this.project = { clips: [], overlays: [] };
    this.selectedId = null;
    this.selectedOverlayId = null;
    this.timeMs = 0;

    root.classList.add('tl');
    this.inner = el('div', 'tl-inner');
    this.ruler = el('div', 'tl-ruler');
    this.track = el('div', 'tl-track');
    this.overlayTrack = el('div', 'tl-overlays');
    this.playhead = el('div', 'tl-playhead');
    this.marker = el('div', 'tl-drop-marker');
    this.marker.hidden = true;
    this.inner.append(this.ruler, this.track, this.overlayTrack, this.playhead, this.marker);
    root.append(this.inner);

    this.bindScrub(this.ruler);
    this.bindScrub(this.track, { emptyOnly: true });
    this.bindScrub(this.overlayTrack, { emptyOnly: true, deselectOverlay: true });
    this.bindDrop();
  }

  xToMs(clientX) {
    const rect = this.inner.getBoundingClientRect();
    return Math.max(0, ((clientX - rect.left) / this.pxPerSec) * 1000);
  }

  bindScrub(target, { emptyOnly = false, deselectOverlay = false } = {}) {
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (emptyOnly && e.target !== target) return;
      e.preventDefault();
      if (deselectOverlay) this.h.onOverlaySelect(null);
      else if (emptyOnly) this.h.onSelect(null);
      const move = (ev) => this.h.onSeek(this.xToMs(ev.clientX));
      move(e);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  bindDrop() {
    this.track.addEventListener('dragover', (e) => {
      if (!this.draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const slot = this.slotAt(e.clientX);
      const x = this.slotX(slot);
      this.marker.style.left = `${x}px`;
      this.marker.hidden = false;
    });
    this.track.addEventListener('dragleave', (e) => {
      if (e.target === this.track) this.marker.hidden = true;
    });
    this.track.addEventListener('drop', (e) => {
      if (!this.draggingId) return;
      e.preventDefault();
      const slot = this.slotAt(e.clientX);
      this.marker.hidden = true;
      this.h.onMove(this.draggingId, slot);
      this.draggingId = null;
    });
  }

  /** Insertion slot (0..n) for a pointer x, by comparing to clip midpoints. */
  slotAt(clientX) {
    const clips = [...this.track.querySelectorAll('.tl-clip')];
    let slot = clips.length;
    for (let i = 0; i < clips.length; i++) {
      const r = clips[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) {
        slot = i;
        break;
      }
    }
    return slot;
  }

  slotX(slot) {
    let t = 0;
    for (let i = 0; i < slot && i < this.project.clips.length; i++) t += clipDuration(this.project.clips[i]);
    return (t / 1000) * this.pxPerSec;
  }

  setPlayhead(tMs) {
    this.timeMs = tMs;
    const x = (tMs / 1000) * this.pxPerSec;
    this.playhead.style.left = `${x}px`;
    // Keep the playhead in view while playing.
    const view = this.root;
    const left = view.scrollLeft;
    if (x < left + 20 || x > left + view.clientWidth - 20) view.scrollLeft = Math.max(0, x - view.clientWidth / 3);
  }

  render(project, selectedId, pxPerSec, selectedOverlayId = null) {
    this.project = project;
    this.selectedId = selectedId;
    this.selectedOverlayId = selectedOverlayId;
    this.pxPerSec = pxPerSec;
    const totalMs = project.clips.reduce((s, c) => s + clipDuration(c), 0);
    const width = (totalMs / 1000) * pxPerSec + END_PAD;
    this.inner.style.width = `${Math.max(width, this.root.clientWidth)}px`;
    this.renderRuler(Math.max(width, this.root.clientWidth));
    this.renderClips();
    this.renderOverlays();
    this.setPlayhead(this.timeMs);
  }

  renderRuler(widthPx) {
    const step = TICK_STEPS.find((s) => s * this.pxPerSec >= 70) ?? 300;
    const frag = document.createDocumentFragment();
    const seconds = widthPx / this.pxPerSec;
    for (let t = 0; t <= seconds; t += step) {
      const tick = el('div', 'tl-tick');
      tick.style.left = `${t * this.pxPerSec}px`;
      tick.textContent = step < 1 ? `${t.toFixed(2)}s` : formatDuration(t * 1000);
      frag.append(tick);
      const half = el('div', 'tl-tick minor');
      half.style.left = `${(t + step / 2) * this.pxPerSec}px`;
      frag.append(half);
    }
    this.ruler.replaceChildren(frag);
  }

  renderClips() {
    const frag = document.createDocumentFragment();
    for (const clip of this.project.clips) {
      const dur = clipDuration(clip);
      const w = (dur / 1000) * this.pxPerSec;
      const node = el('div', `tl-clip${clip.kind !== 'video' ? ` ${clip.kind}` : ''}`);
      node.dataset.id = clip.id;
      node.style.width = `${w}px`;
      if (clip.id === this.selectedId) node.classList.add('selected');
      node.draggable = true;

      const thumbs = el('div', 'tl-thumbs');
      const count = clip.kind === 'video' ? Math.max(1, Math.floor(w / THUMB_W)) : 1;
      for (let i = 0; i < count; i++) {
        const img = document.createElement('img');
        img.width = THUMB_W;
        img.draggable = false;
        const sourceMs = clip.kind === 'video' ? clip.inMs + ((i + 0.5) * dur) / count : 0;
        this.h.thumb(clip, sourceMs, img);
        thumbs.append(img);
      }
      const label = el('div', 'tl-label');
      label.textContent = formatDuration(dur);
      node.append(thumbs, label);
      if (KIND_LABEL[clip.kind]) {
        const kindTag = el('div', 'tl-kind');
        kindTag.textContent = KIND_LABEL[clip.kind];
        node.append(kindTag);
      }

      if (clip.id === this.selectedId && clip.kind === 'video') {
        node.append(this.handle(clip, 'in'), this.handle(clip, 'out'));
      }

      node.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.classList.contains('tl-handle')) return;
        this.h.onSelect(clip.id);
      });
      node.addEventListener('click', (e) => {
        if (e.target.classList.contains('tl-handle')) return;
        this.h.onSeek(this.xToMs(e.clientX));
      });
      node.addEventListener('dragstart', (e) => {
        this.draggingId = clip.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', clip.id);
        node.classList.add('dragging');
      });
      node.addEventListener('dragend', () => {
        this.draggingId = null;
        this.marker.hidden = true;
        node.classList.remove('dragging');
      });
      frag.append(node);
    }
    this.track.replaceChildren(frag);
  }

  handle(clip, edge) {
    const h = el('div', `tl-handle ${edge}`);
    h.title = edge === 'in' ? 'Drag to trim the start' : 'Drag to trim the end';
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const deltaAt = (ev) => ((ev.clientX - startX) / this.pxPerSec) * 1000;
      const move = (ev) => this.h.onTrim(clip.id, edge, deltaAt(ev), false);
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.h.onTrim(clip.id, edge, deltaAt(ev), true);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    // A handle must never start a reorder drag.
    h.draggable = true;
    h.addEventListener('dragstart', (e) => e.preventDefault());
    return h;
  }

  renderOverlays() {
    const overlays = this.project.overlays ?? [];
    const rows = assignOverlayRows(overlays);

    const frag = document.createDocumentFragment();
    for (const overlay of overlays) {
      const node = el('div', 'tl-overlay');
      node.dataset.id = overlay.id;
      node.style.left = `${(overlay.startMs / 1000) * this.pxPerSec}px`;
      node.style.width = `${Math.max(6, (overlay.durationMs / 1000) * this.pxPerSec)}px`;
      node.style.top = `${rows.get(overlay.id) * ROW_H + 4}px`;
      if (overlay.id === this.selectedOverlayId) node.classList.add('selected');
      node.textContent = overlay.source === 'text' ? overlay.content.text || 'Text' : overlay.source === 'shape' ? overlay.content.kind : overlay.name;
      node.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.classList.contains('tl-handle')) return;
        e.stopPropagation();
        this.h.onOverlaySelect(overlay.id);
        const startX = e.clientX;
        const deltaAt = (ev) => ((ev.clientX - startX) / this.pxPerSec) * 1000;
        const move = (ev) => this.h.onOverlayMove(overlay.id, deltaAt(ev), false);
        const up = (ev) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          this.h.onOverlayMove(overlay.id, deltaAt(ev), true);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      if (overlay.id === this.selectedOverlayId) {
        node.append(this.overlayHandle(overlay, 'start'), this.overlayHandle(overlay, 'end'));
      }
      frag.append(node);
    }
    this.overlayTrack.replaceChildren(frag);
  }

  overlayHandle(overlay, edge) {
    const h = el('div', `tl-handle ${edge === 'start' ? 'in' : 'out'}`);
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const deltaAt = (ev) => ((ev.clientX - startX) / this.pxPerSec) * 1000;
      const move = (ev) => this.h.onOverlayTrim(overlay.id, edge, deltaAt(ev), false);
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.h.onOverlayTrim(overlay.id, edge, deltaAt(ev), true);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return h;
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
