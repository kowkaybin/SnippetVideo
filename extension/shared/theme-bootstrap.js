// Classic (non-module) script, loaded before the stylesheet in every page's
// <head>, so an explicit light/dark choice applies before first paint with no
// flash of the system theme. It only reads a cache theme.js keeps in sync;
// the real setting lives in chrome.storage.sync via shared/settings.js.
(function () {
  try {
    var cached = localStorage.getItem('snippet-theme');
    if (cached === 'light' || cached === 'dark') document.documentElement.setAttribute('data-theme', cached);
  } catch (e) {
    // Storage can be unavailable in odd contexts; system theme is a fine fallback.
  }
})();
