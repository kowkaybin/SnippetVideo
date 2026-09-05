/**
 * Recording engine, hosted by the control window. Opens Chrome's source
 * picker, runs the countdown, drives MediaRecorder, streams chunks to OPFS
 * through a worker, and finalises the file (patching the WebM duration header
 * so the result is seekable). Progress is reported to the service worker,
 * which owns the visible state.
 */
import fixWebmDuration from 'fix-webm-duration';
import { QUALITY_PRESETS, type Settings, type SourceKind } from '../shared/settings';
import { send } from '../shared/messages';
import { fileName, newRecordingId, readRecordingFile, recordingsDirectory, type RecordingMeta } from '../shared/library';
import { recordingName } from '../shared/format';

interface Session {
  id: string;
  name: string;
  settings: Settings;
  stream: MediaStream | null;
  worker: Worker | null;
  recorder: MediaRecorder | null;
  pickerRequest: number | null;
  mimeType: string;
  width: number;
  height: number;
  /** Recorded milliseconds from completed (unpaused) segments. */
  accumulatedMs: number;
  /** performance.now() when the current unpaused segment began. */
  segmentStart: number;
  paused: boolean;
  autoStopped: boolean;
  cancelled: boolean;
  ticker: number | null;
  pendingChunks: Promise<void>;
}

let session: Session | null = null;

export function isActive(): boolean {
  return session !== null;
}

const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

function pickMimeType(): string {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

function elapsedMs(s: Session): number {
  return s.accumulatedMs + (s.paused ? 0 : performance.now() - s.segmentStart);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function workerCall(worker: Worker, message: unknown, transfer: Transferable[] = []): Promise<{ bytes?: number }> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      worker.removeEventListener('message', onMessage);
      if (e.data?.type === 'error') reject(new Error(e.data.message));
      else resolve(e.data ?? {});
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage(message, transfer);
  });
}

function pickerSources(preferred: SourceKind): SourceKind[] {
  // The first entry decides which pane the picker opens on.
  const all: SourceKind[] = ['tab', 'window', 'screen'];
  return [preferred, ...all.filter((k) => k !== preferred)];
}

function chooseSource(s: Session): Promise<string> {
  return new Promise((resolve) => {
    s.pickerRequest = chrome.desktopCapture.chooseDesktopMedia(pickerSources(s.settings.defaultSource), (streamId) => {
      s.pickerRequest = null;
      resolve(streamId ?? '');
    });
  });
}

async function acquireStream(streamId: string, settings: Settings): Promise<MediaStream> {
  // Chrome-specific constraints for desktopCapture stream ids.
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId,
        maxFrameRate: settings.fps,
      },
    },
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const [track] = stream.getVideoTracks();
  if (!track) throw new Error('No video track from capture');
  await track.applyConstraints({ frameRate: { ideal: settings.fps, max: settings.fps } }).catch(() => undefined);
  return stream;
}

export async function start(settings: Settings): Promise<void> {
  if (session) throw new Error('Already recording');
  const now = new Date();
  const s: Session = {
    id: newRecordingId(now),
    name: recordingName(now),
    settings,
    stream: null,
    worker: null,
    recorder: null,
    pickerRequest: null,
    mimeType: pickMimeType(),
    width: 0,
    height: 0,
    accumulatedMs: 0,
    segmentStart: 0,
    paused: false,
    autoStopped: false,
    cancelled: false,
    ticker: null,
    pendingChunks: Promise.resolve(),
  };
  session = s;

  try {
    const streamId = await chooseSource(s);
    if (s.cancelled) return;
    if (!streamId) {
      session = null;
      await send({ target: 'background', type: 'cancelled' });
      return;
    }
    s.stream = await acquireStream(streamId, settings);
    const [track] = s.stream.getVideoTracks();
    // Read dimensions now: a stopped track reports empty settings.
    const { width = 0, height = 0 } = track!.getSettings();
    s.width = width;
    s.height = height;
    // User pressed Chrome's own "Stop sharing" bar.
    track!.addEventListener('ended', () => void stop());

    for (let remaining = settings.countdownSeconds; remaining > 0; remaining--) {
      await send({ target: 'background', type: 'countdown', remaining });
      await sleep(1000);
      if (s.cancelled) return;
    }

    s.worker = new Worker(new URL('./opfs-worker.ts', import.meta.url), { type: 'module' });
    await workerCall(s.worker, { type: 'open', fileName: fileName(s.id) });

    const recorder = new MediaRecorder(s.stream, {
      mimeType: s.mimeType || undefined,
      videoBitsPerSecond: QUALITY_PRESETS[settings.quality].bitsPerSecond,
    });
    s.recorder = recorder;
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size === 0 || !s.worker) return;
      const worker = s.worker;
      s.pendingChunks = s.pendingChunks.then(async () => {
        const buffer = await e.data.arrayBuffer();
        await workerCall(worker, { type: 'append', buffer }, [buffer]);
      });
    });
    recorder.addEventListener('error', (e) => {
      void abort(`Recorder error: ${(e as ErrorEvent).error?.message ?? 'unknown'}`);
    });

    recorder.start(1000);
    s.segmentStart = performance.now();
    await send({ target: 'background', type: 'started' });

    s.ticker = window.setInterval(() => {
      const ms = elapsedMs(s);
      void send({ target: 'background', type: 'tick', elapsedMs: ms, paused: s.paused });
      if (ms >= settings.maxDurationMinutes * 60_000) {
        s.autoStopped = true;
        void stop();
      }
    }, 1000);
  } catch (err) {
    await abort(err instanceof Error ? err.message : String(err));
  }
}

export function pause(): void {
  const s = session;
  if (!s?.recorder || s.paused || s.recorder.state !== 'recording') return;
  s.recorder.pause();
  s.accumulatedMs += performance.now() - s.segmentStart;
  s.paused = true;
  void send({ target: 'background', type: 'tick', elapsedMs: s.accumulatedMs, paused: true });
}

export function resume(): void {
  const s = session;
  if (!s?.recorder || !s.paused) return;
  s.recorder.resume();
  s.segmentStart = performance.now();
  s.paused = false;
  void send({ target: 'background', type: 'tick', elapsedMs: elapsedMs(s), paused: false });
}

function releaseMedia(s: Session): void {
  if (s.ticker !== null) clearInterval(s.ticker);
  s.ticker = null;
  s.stream?.getTracks().forEach((t) => t.stop());
  if (s.pickerRequest !== null) {
    chrome.desktopCapture.cancelChooseDesktopMedia(s.pickerRequest);
    s.pickerRequest = null;
  }
}

export async function stop(): Promise<void> {
  const s = session;
  if (!s) return;
  session = null;
  const recorder = s.recorder;

  if (!recorder) {
    // Still picking or counting down: cancel cleanly.
    s.cancelled = true;
    releaseMedia(s);
    s.worker?.terminate();
    await send({ target: 'background', type: 'cancelled' });
    return;
  }

  try {
    const durationMs = Math.round(elapsedMs(s));
    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
    }
    releaseMedia(s);
    await s.pendingChunks;
    const { bytes = 0 } = await workerCall(s.worker!, { type: 'close' });
    s.worker!.terminate();
    if (bytes === 0) throw new Error('Recording produced no data');

    const file = await finalise(s.id, durationMs, s.mimeType);

    const meta: RecordingMeta = {
      id: s.id,
      name: s.name,
      createdAt: Date.now() - durationMs,
      durationMs,
      bytes: file.size,
      width: s.width,
      height: s.height,
      fps: s.settings.fps,
      quality: s.settings.quality,
      mimeType: s.mimeType || 'video/webm',
      autoStopped: s.autoStopped,
    };
    const blobUrl = URL.createObjectURL(file);
    await send({ target: 'background', type: 'finished', recording: meta, blobUrl });
  } catch (err) {
    await send({ target: 'background', type: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
}

/** MediaRecorder omits the WebM duration; patch it in so players can seek. */
async function finalise(id: string, durationMs: number, mimeType: string): Promise<File> {
  const raw = await readRecordingFile(id);
  let fixed: Blob = raw;
  try {
    fixed = await fixWebmDuration(raw, durationMs, { logger: false });
  } catch (err) {
    console.warn('duration patch failed, keeping raw file', err);
    return raw;
  }
  if (fixed === raw) return raw;
  const dir = await recordingsDirectory();
  const handle = await dir.getFileHandle(fileName(id));
  const writable = await handle.createWritable();
  await writable.write(fixed);
  await writable.close();
  const out = await handle.getFile();
  return new File([out], fileName(id), { type: mimeType || 'video/webm' });
}

async function abort(message: string): Promise<void> {
  const s = session;
  session = null;
  if (s) {
    releaseMedia(s);
    if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
    s.worker?.terminate();
  }
  await send({ target: 'background', type: 'failed', message });
}
