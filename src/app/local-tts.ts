import { spawn } from 'node:child_process';

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

export async function synthesizeLocalMp3(text: string): Promise<Buffer> {
  const spoken = text.trim();
  if (!spoken || spoken.length > 2000) throw new Error('invalid local speech text');
  const espeak = spawn('espeak-ng', ['--stdout', '-v', 'en-us', '-s', '165', spoken], {
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0',
    '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  espeak.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdin.on('error', () => { espeak.kill(); });
  espeak.stderr.resume();
  ffmpeg.stderr.resume();
  const chunks: Buffer[] = [];
  let size = 0;
  ffmpeg.stdout.on('data', chunk => {
    const buffer = Buffer.from(chunk as Buffer); size += buffer.length;
    if (size > MAX_AUDIO_BYTES) {
      espeak.kill(); ffmpeg.kill(); return;
    }
    chunks.push(buffer);
  });
  const timeout = setTimeout(() => { espeak.kill(); ffmpeg.kill(); }, 15_000);
  try {
    const [espeakCode, ffmpegCode] = await Promise.all([
      new Promise<number | null>((resolve, reject) => {
        espeak.once('error', reject); espeak.once('close', resolve);
      }),
      new Promise<number | null>((resolve, reject) => {
        ffmpeg.once('error', reject); ffmpeg.once('close', resolve);
      }),
    ]);
    if (espeakCode !== 0 || ffmpegCode !== 0 || size === 0 || size > MAX_AUDIO_BYTES) {
      throw new Error('local speech synthesis failed');
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
    espeak.kill();
    ffmpeg.kill();
  }
}
