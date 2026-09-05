/**
 * Open an extension page as a regular tab. The control window is a popup, so
 * a plain chrome.tabs.create from it would fail or land in the wrong place;
 * pick the last focused normal window, or make one.
 */
export async function openInNormalWindow(path) {
  const url = chrome.runtime.getURL(path);
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => undefined);
    return;
  }
  const normal = (await chrome.windows.getAll({ windowTypes: ['normal'] })).sort(
    (a, b) => Number(b.focused) - Number(a.focused),
  );
  const target = normal[0];
  if (target?.id !== undefined) {
    await chrome.tabs.create({ url, windowId: target.id, active: true });
    await chrome.windows.update(target.id, { focused: true }).catch(() => undefined);
  } else {
    await chrome.windows.create({ url, type: 'normal', focused: true });
  }
}
