/**
 * Appends recorded chunks to an OPFS file using a synchronous access handle,
 * so every chunk is on disk the moment it arrives. If the recorder page dies
 * mid-recording, everything up to the last chunk survives.
 *
 * Inbound:  { type: 'open', fileName } | { type: 'append', buffer } | { type: 'close' }
 * Outbound: { type: 'opened' } | { type: 'appended', bytes } | { type: 'closed', bytes } | { type: 'error', message }
 */
import { RECORDINGS_DIR } from '../shared/library.js';

let handle = null;
let offset = 0;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'open') {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(RECORDINGS_DIR, { create: true });
      const file = await dir.getFileHandle(msg.fileName, { create: true });
      handle = await file.createSyncAccessHandle();
      handle.truncate(0);
      offset = 0;
      self.postMessage({ type: 'opened' });
    } else if (msg.type === 'append') {
      if (!handle) throw new Error('file not open');
      offset += handle.write(msg.buffer, { at: offset });
      handle.flush();
      self.postMessage({ type: 'appended', bytes: offset });
    } else if (msg.type === 'close') {
      if (handle) {
        handle.flush();
        handle.close();
        handle = null;
      }
      self.postMessage({ type: 'closed', bytes: offset });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
