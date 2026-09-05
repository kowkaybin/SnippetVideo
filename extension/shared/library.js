/**
 * Recording files live in the extension's Origin Private File System (OPFS)
 * under /recordings/<id>.webm. Metadata lives in chrome.storage.local so the
 * library page can list recordings without touching the files.
 *
 * @typedef {object} RecordingMeta
 * @property {string} id
 * @property {string} name
 * @property {number} createdAt
 * @property {number} durationMs
 * @property {number} bytes
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {string} quality
 * @property {string} mimeType
 * @property {boolean} autoStopped   True when the max-duration guard stopped it.
 * @property {boolean} [recovered]   True when adopted from an orphaned file.
 */

const INDEX_KEY = 'recordings';
export const RECORDINGS_DIR = 'recordings';

/** @returns {Promise<RecordingMeta[]>} newest first */
export async function listRecordings() {
  const list = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] ?? [];
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

/** @param {RecordingMeta} meta */
export async function addRecording(meta) {
  const list = await listRecordings();
  await chrome.storage.local.set({ [INDEX_KEY]: [meta, ...list.filter((r) => r.id !== meta.id)] });
}

export async function removeRecording(id) {
  const list = await listRecordings();
  await chrome.storage.local.set({ [INDEX_KEY]: list.filter((r) => r.id !== id) });
  const dir = await recordingsDirectory();
  await dir.removeEntry(fileName(id)).catch(() => undefined);
}

export function fileName(id) {
  return `${id}.webm`;
}

export async function recordingsDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RECORDINGS_DIR, { create: true });
}

export async function readRecordingFile(id) {
  const dir = await recordingsDirectory();
  const handle = await dir.getFileHandle(fileName(id));
  return handle.getFile();
}

/**
 * A recording whose control window was closed mid-way has its chunks on disk
 * but no index entry. Adopt such files so nothing is silently lost.
 * @returns {Promise<number>} how many were adopted
 */
export async function recoverOrphans() {
  const known = new Set((await listRecordings()).map((r) => r.id));
  const dir = await recordingsDirectory();
  let recovered = 0;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.webm')) continue;
    const id = name.slice(0, -'.webm'.length);
    if (known.has(id)) continue;
    const file = await handle.getFile();
    if (file.size === 0) {
      await dir.removeEntry(name).catch(() => undefined);
      continue;
    }
    await addRecording({
      id,
      name: `recovered-${id}`,
      createdAt: file.lastModified,
      durationMs: 0,
      bytes: file.size,
      width: 0,
      height: 0,
      fps: 30,
      quality: 'high',
      mimeType: 'video/webm',
      autoStopped: false,
      recovered: true,
    });
    recovered++;
  }
  return recovered;
}

export function newRecordingId(date) {
  return `${date.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
