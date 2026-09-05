import { COUNTDOWN_OPTIONS, FPS_OPTIONS, QUALITY_PRESETS, loadSettings, saveSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);

function fill(select, options) {
  select.replaceChildren(
    ...options.map((o) => {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      return el;
    }),
  );
}

async function init() {
  const fps = $('fps');
  const quality = $('quality');
  const countdown = $('countdownSeconds');
  const source = $('defaultSource');
  const maxMinutes = $('maxDurationMinutes');
  const autoDownload = $('autoDownload');
  const includeCursor = $('includeCursor');
  const qualityHint = $('qualityHint');

  fill(fps, FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` })));
  fill(quality, Object.entries(QUALITY_PRESETS).map(([k, v]) => ({ value: k, label: v.label })));
  fill(countdown, COUNTDOWN_OPTIONS.map((c) => ({ value: String(c), label: c === 0 ? 'Off' : `${c} seconds` })));

  const settings = await loadSettings();
  source.value = settings.defaultSource;
  fps.value = String(settings.fps);
  quality.value = settings.quality;
  countdown.value = String(settings.countdownSeconds);
  maxMinutes.value = String(settings.maxDurationMinutes);
  autoDownload.checked = settings.autoDownload;
  includeCursor.checked = settings.includeCursor;
  qualityHint.textContent = QUALITY_PRESETS[settings.quality].hint;

  const persist = async () => {
    const next = {
      defaultSource: source.value,
      fps: Number(fps.value),
      quality: quality.value,
      countdownSeconds: Number(countdown.value),
      maxDurationMinutes: Math.min(180, Math.max(1, Number(maxMinutes.value) || 15)),
      autoDownload: autoDownload.checked,
      includeCursor: includeCursor.checked,
    };
    qualityHint.textContent = QUALITY_PRESETS[next.quality].hint;
    await saveSettings(next);
  };
  for (const el of [source, fps, quality, countdown, maxMinutes, autoDownload, includeCursor]) {
    el.addEventListener('change', () => void persist());
  }

  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

void init();
