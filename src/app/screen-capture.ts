/**
 * NOGITA_SCREEN_CAPTURE (P8-7): the screen people share in a meeting, for measuring whether she can read it and what
 * that costs before anything is built on it. Attendee sends JPEG frames over a websocket (1 per second at 720p or
 * 1080p). Frames stay in memory, are wiped when the session ends, and no model sees them here.
 *
 * Only frames where the screen changed are kept. Each frame is re-encoded, so a hash of the JPEG always differs; its
 * size barely moves on a still screen, though, and that needs no decoder. A change that keeps the size is caught by
 * also keeping one frame every 30 seconds. The spike measures how good this is.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export const SCREEN_PATH = '/webhooks/attendee/video';
export type ScreenResolution = '720p' | '1080p';

const CHANGED_SIZE_RATIO = 0.03;
const KEEP_AT_LEAST_EVERY_MS = 30_000;
const MAX_KEPT_FRAMES = 40;
const MAX_FRAME_BYTES = 2_000_000;

export interface KeptFrame { n: number; at: number; bytes: number; jpeg: Buffer }
export interface ScreenStats { received: number; receivedBytes: number; kept: number; firstAt?: number; lastAt?: number }

interface Capture { stats: ScreenStats; frames: KeptFrame[]; lastBytes?: number; lastKeptAt: number; socket?: WebSocket }

/** Whether a frame is worth keeping, from its size and the last one kept. */
export function screenChanged(bytes: number, lastBytes: number | undefined, sinceKeptMs: number): boolean {
  if (lastBytes === undefined || sinceKeptMs >= KEEP_AT_LEAST_EVERY_MS) return true;
  return Math.abs(bytes - lastBytes) / lastBytes >= CHANGED_SIZE_RATIO;
}

/** The settings Attendee needs: the screen only, no webcams. */
export function screenWebsocketSettings(url: string, resolution: ScreenResolution): Record<string, unknown> {
  return { url, webcam_resolution: 'none', screenshare_resolution: resolution };
}

export function parseScreenResolution(value: string | undefined): ScreenResolution | undefined {
  const text = value?.trim() ?? '';
  if (!text) return undefined;
  if (text !== '720p' && text !== '1080p') throw new Error('NOGITA_SCREEN_CAPTURE must be 720p or 1080p');
  return text;
}

export class ScreenCaptureHub {
  private readonly captures = new Map<string, Capture>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES * 2 });

  constructor(private readonly baseOrigin: string, private readonly secret: string, private readonly now: () => number = Date.now) {
    if (!secret.trim()) throw new Error('screen capture needs a signing secret');
    if (new URL(baseOrigin).protocol !== 'wss:') throw new Error('screen capture needs a WSS origin');
  }

  private signature(sessionId: string): string {
    return createHmac('sha256', this.secret).update(`nogita-attendee-video-v1\0${sessionId}`).digest('base64url');
  }

  /** The signed URL to give Attendee for this session. */
  register(sessionId: string): string {
    this.captures.set(sessionId, { stats: { received: 0, receivedBytes: 0, kept: 0 }, frames: [], lastKeptAt: 0 });
    const url = new URL(SCREEN_PATH, this.baseOrigin);
    url.searchParams.set('session_id', sessionId);
    url.searchParams.set('signature', this.signature(sessionId));
    return url.toString();
  }

  handleUpgrade(request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): boolean {
    let url: URL;
    try { url = new URL(request.url ?? '', 'http://localhost'); } catch { return false; }
    if (url.pathname !== SCREEN_PATH) return false;
    const sessionId = url.searchParams.get('session_id') ?? '';
    const supplied = Buffer.from(url.searchParams.get('signature') ?? '');
    const expected = Buffer.from(this.signature(sessionId));
    const capture = this.captures.get(sessionId);
    if (!capture || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(request, socket, head, client => {
      capture.socket?.close(1012, 'connection replaced');
      capture.socket = client;
      client.on('message', data => this.onMessage(capture, data));
    });
    return true;
  }

  private onMessage(capture: Capture, data: RawData): void {
    let message: { trigger?: string; data?: { frame?: unknown; source?: unknown; format?: unknown } };
    try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
    const frame = message.data;
    if (message.trigger !== 'realtime_video.per_participant' || frame?.source !== 'screenshare' || frame.format !== 'jpeg' ||
        typeof frame.frame !== 'string') return;
    const jpeg = Buffer.from(frame.frame, 'base64');
    if (!jpeg.length || jpeg.length > MAX_FRAME_BYTES) return;
    const now = this.now();
    const { stats } = capture;
    stats.received++;
    stats.receivedBytes += jpeg.length;
    stats.firstAt ??= now;
    stats.lastAt = now;
    if (!screenChanged(jpeg.length, capture.lastBytes, now - capture.lastKeptAt)) return;
    capture.lastBytes = jpeg.length;
    capture.lastKeptAt = now;
    capture.frames.push({ n: ++stats.kept, at: now, bytes: jpeg.length, jpeg });
    if (capture.frames.length > MAX_KEPT_FRAMES) capture.frames.shift();
  }

  /** What was received, and the frames still held (without their pixels). */
  report(sessionId: string): { stats: ScreenStats; frames: Array<{ n: number; at: number; bytes: number }> } | undefined {
    const capture = this.captures.get(sessionId);
    return capture && { stats: { ...capture.stats }, frames: capture.frames.map(({ n, at, bytes }) => ({ n, at, bytes })) };
  }

  frame(sessionId: string, n: number): Buffer | undefined {
    return this.captures.get(sessionId)?.frames.find(frame => frame.n === n)?.jpeg;
  }

  /** The session ended: its frames are gone. */
  closeSession(sessionId: string): void {
    this.captures.get(sessionId)?.socket?.close(1000, 'session ended');
    this.captures.delete(sessionId);
  }
}
