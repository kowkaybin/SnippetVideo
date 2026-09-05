import type { Fps, QualityPreset } from './settings';

/**
 * Recording files live in the extension's Origin Private File System (OPFS)
 * under /recordings/<id>.webm. Metadata lives in chrome.storage.local so the
 * library page can list recordings without touching the files.
 */
export interface RecordingMeta {
  id: string;
  name: string;
  createdAt: number;
  durationMs: number;
  bytes: number;
  width: number;
  height: number;
  fps: Fps;
  quality: QualityPreset;
  mimeType: string;
  /** True when the max-duration guard stopped the recording. */
  autoStopped: boolean;
  /** True when adopted from an orphaned file; duration is unknown and seeking may not work. */
  recovered?: boolean;
}

const INDEX_KEY = 'recordings';
export const RECORDINGS_DIR = 'recordings';

export async function listRecordings(): Promise<RecordingMeta[]> {
  const list = ((await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] as RecordingMeta[] | undefined) ?? [];
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function addRecording(meta: RecordingMeta): Promise<void> {
  const list = await listRecordings();
  await chrome.storage.local.set({ [INDEX_KEY]: [meta, ...list.filter((r) => r.id !== meta.id)] });
}

export async function removeRecording(id: string): Promise<void> {
  const list = await listRecordings();
  await chrome.storage.local.set({ [INDEX_KEY]: list.filter((r) => r.id !== id) });
  const dir = await recordingsDirectory();
  await dir.removeEntry(fileName(id)).catch(() => undefined);
}

export function fileName(id: string): string {
  return `${id}.webm`;
}

export async function recordingsDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RECORDINGS_DIR, { create: true });
}

export async function readRecordingFile(id: string): Promise<File> {
  const dir = await recordingsDirectory();
  const handle = await dir.getFileHandle(fileName(id));
  return handle.getFile();
}

/**
 * A recording whose control window was closed mid-way has its chunks on disk
 * but no index entry. Adopt such files so nothing is silently lost.
 */
export async function recoverOrphans(): Promise<number> {
  const known = new Set((await listRecordings()).map((r) => r.id));
  const dir = await recordingsDirectory();
  let recovered = 0;
  // Async iteration of directory handles is missing from TypeScript's DOM lib.
  const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [name, handle] of entries) {
    if (handle.kind !== 'file' || !name.endsWith('.webm')) continue;
    const id = name.slice(0, -'.webm'.length);
    if (known.has(id)) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
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

export function newRecordingId(date: Date): string {
  return `${date.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
