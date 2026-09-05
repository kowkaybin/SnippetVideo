import { COUNTDOWN_OPTIONS, FPS_OPTIONS, QUALITY_PRESETS, THEME_OPTIONS, loadSettings, saveSettings } from '../shared/settings.js';
import { applyTheme, watchTheme } from '../shared/theme.js';

void watchTheme();

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
  const theme = $('theme');

  fill(fps, FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` })));
  fill(quality, Object.entries(QUALITY_PRESETS).map(([k, v]) => ({ value: k, label: v.label })));
  fill(countdown, COUNTDOWN_OPTIONS.map((c) => ({ value: String(c), label: c === 0 ? 'Off' : `${c} seconds` })));
  fill(theme, THEME_OPTIONS);

  const settings = await loadSettings();
  source.value = settings.defaultSource;
  fps.value = String(settings.fps);
  quality.value = settings.quality;
  countdown.value = String(settings.countdownSeconds);
  maxMinutes.value = String(settings.maxDurationMinutes);
  autoDownload.checked = settings.autoDownload;
  includeCursor.checked = settings.includeCursor;
  theme.value = settings.theme;
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
      theme: theme.value,
    };
    qualityHint.textContent = QUALITY_PRESETS[next.quality].hint;
    applyTheme(next.theme); // instant feedback on this page; watchTheme() syncs the rest
    await saveSettings(next);
  };
  for (const el of [source, fps, quality, countdown, maxMinutes, autoDownload, includeCursor, theme]) {
    el.addEventListener('change', () => void persist());
  }

  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

void init();
