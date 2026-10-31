import { stats, type Stats } from './score.ts';

export type TtsBenchmarkPhase = 'cold' | 'warm';

export interface TtsBenchmarkSample {
  provider: string;
  model: string;
  voice: string;
  phase: TtsBenchmarkPhase;
  textId: string;
  /** Connection handshake, included in cold TTFA and reported separately for diagnosis. */
  connectMs: number;
  /** Request start to the first audio byte; cold samples include connectMs. */
  ttfaMs?: number;
  /** Request start to the provider's completion event; cold samples include connectMs. */
  totalMs?: number;
  audioBytes?: number;
  error?: string;
}

export interface TtsBenchmarkGroup {
  provider: string;
  model: string;
  voice: string;
  phase: TtsBenchmarkPhase;
  attempts: number;
  successes: number;
  failures: number;
  ttfa: Stats;
  total: Stats;
}

export interface TtsBenchmarkProvider {
  name: string;
  model: string;
  voice: string;
  sampleRate: number;
  open(): Promise<{ connectMs: number; synthesize(text: string): Promise<{ ttfaMs: number; totalMs: number; audio: Buffer }>;
    close(): Promise<void> }>;
}

/** A provider-neutral scorecard. Keep it beside the randomized clips and fill it before opening the manifest. */
export function renderBlindRatingCsv(blindIds: readonly string[]): string {
  const header = 'blind_id,naturalness_1_5,pronunciation_1_5,pacing_1_5,technical_clarity_1_5,preference_rank,notes';
  return [header, ...blindIds.map(id => `${id},,,,,,`), ''].join('\n');
}

export async function runTtsBenchmark(providers: readonly TtsBenchmarkProvider[], corpus: readonly { id: string; text: string }[],
  onAudio?: (sample: TtsBenchmarkSample, audio: Buffer, sampleRate: number) => void | Promise<void>): Promise<TtsBenchmarkSample[]> {
  const samples: TtsBenchmarkSample[] = [];
  for (const provider of providers) {
    for (let index = 0; index < corpus.length; index += 2) {
      let session: Awaited<ReturnType<TtsBenchmarkProvider['open']>>;
      try { session = await provider.open(); }
      catch (error) {
        for (const item of corpus.slice(index, index + 2)) samples.push({ provider: provider.name, model: provider.model,
          voice: provider.voice, phase: item === corpus[index] ? 'cold' : 'warm', textId: item.id, connectMs: 0,
          error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      try {
        for (const [offset, item] of corpus.slice(index, index + 2).entries()) {
          const phase: TtsBenchmarkPhase = offset === 0 ? 'cold' : 'warm';
          const connectMs = phase === 'cold' ? session.connectMs : 0;
          try {
            const result = await session.synthesize(item.text);
            const sample: TtsBenchmarkSample = { provider: provider.name, model: provider.model, voice: provider.voice,
              phase, textId: item.id, connectMs, ttfaMs: Math.round(result.ttfaMs + connectMs),
              totalMs: Math.round(result.totalMs + connectMs), audioBytes: result.audio.length };
            samples.push(sample);
            await onAudio?.(sample, result.audio, provider.sampleRate);
          } catch (error) {
            samples.push({ provider: provider.name, model: provider.model, voice: provider.voice, phase,
              textId: item.id, connectMs, error: error instanceof Error ? error.message : String(error) });
          }
        }
      } finally { await session.close().catch(() => undefined); }
    }
  }
  return samples;
}

export function summarizeTtsBenchmark(samples: readonly TtsBenchmarkSample[]): TtsBenchmarkGroup[] {
  const groups = new Map<string, TtsBenchmarkSample[]>();
  for (const sample of samples) {
    const key = [sample.provider, sample.model, sample.voice, sample.phase].join('\0');
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!;
    const successes = group.filter(sample => sample.error === undefined && sample.ttfaMs !== undefined && sample.totalMs !== undefined);
    return { provider: first.provider, model: first.model, voice: first.voice, phase: first.phase,
      attempts: group.length, successes: successes.length, failures: group.length - successes.length,
      ttfa: stats(successes.map(sample => sample.ttfaMs)), total: stats(successes.map(sample => sample.totalMs)) };
  }).sort((a, b) => `${a.provider}\0${a.phase}`.localeCompare(`${b.provider}\0${b.phase}`));
}
