/**
 * Appends recorded chunks to an OPFS file using a synchronous access handle,
 * so every chunk is on disk the moment it arrives. If the recorder page dies
 * mid-recording, everything up to the last chunk survives.
 */
import { RECORDINGS_DIR } from '../shared/library';

type Inbound =
  | { type: 'open'; fileName: string }
  | { type: 'append'; buffer: ArrayBuffer }
  | { type: 'close' };
type Outbound =
  | { type: 'opened' }
  | { type: 'appended'; bytes: number }
  | { type: 'closed'; bytes: number }
  | { type: 'error'; message: string };

let handle: FileSystemSyncAccessHandle | null = null;
let offset = 0;

const post = (m: Outbound) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<Inbound>) => {
  const msg = e.data;
  try {
    if (msg.type === 'open') {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(RECORDINGS_DIR, { create: true });
      const file = await dir.getFileHandle(msg.fileName, { create: true });
      handle = await file.createSyncAccessHandle();
      handle.truncate(0);
      offset = 0;
      post({ type: 'opened' });
    } else if (msg.type === 'append') {
      if (!handle) throw new Error('file not open');
      offset += handle.write(msg.buffer, { at: offset });
      handle.flush();
      post({ type: 'appended', bytes: offset });
    } else if (msg.type === 'close') {
      if (handle) {
        handle.flush();
        handle.close();
        handle = null;
      }
      post({ type: 'closed', bytes: offset });
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
