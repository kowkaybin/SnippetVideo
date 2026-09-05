/**
 * Theme selection: 'system' follows the OS/browser (the default); 'light' and
 * 'dark' override it. Applied as a `data-theme` attribute on <html>, which
 * style.css keys off. `theme-bootstrap.js` (a classic script, loaded before
 * the stylesheet in each page) reads a localStorage cache of the last choice
 * synchronously, so an override applies with no flash before this module
 * (which talks to the real, async chrome.storage.sync setting) has run.
 */
import { loadSettings } from './settings.js';

const CACHE_KEY = 'snippet-theme';

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(CACHE_KEY, theme);
    } catch {
      // Best effort; the page still renders correctly, just without the pre-paint cache.
    }
  } else {
    root.removeAttribute('data-theme');
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // See above.
    }
  }
}

/**
 * Apply the current theme setting now, and keep it live: another page (e.g.
 * Options) changing it updates this one immediately, no reload needed.
 */
export async function watchTheme() {
  applyTheme((await loadSettings()).theme);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) applyTheme(changes.settings.newValue?.theme ?? 'system');
  });
}
