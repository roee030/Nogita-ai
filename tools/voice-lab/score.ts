/**
 * Turns a played conversation into verdicts: did Nogita hear it, did she do the right thing, how long was
 * the room left in silence.
 */
import { directlyAddressesNogita } from '../../src/core/policy.ts';
import type { TurnRecord } from './conversation.ts';

export interface Check { name: string; ok: boolean; detail?: string }
export interface Judgement { correct: number; natural: number; concise: number; comment: string }
export interface TurnScore {
  checks: Check[];
  passed: boolean;
  wer?: number;
  /** Was Nogita's name recognized when the script addressed her? */
  addressHeard?: boolean;
  judgement?: Judgement;
}

export function words(text: string): string[] {
  return text.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Word error rate of `heard` against `reference`. */
export function wordErrorRate(reference: string, heard: string): number {
  const ref = words(reference);
  const hyp = words(heard);
  if (!ref.length) return hyp.length ? 1 : 0;
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[hyp.length]! / ref.length;
}

export function scoreTurn(record: TurnRecord): TurnScore {
  const expect = record.turn.expect;
  const checks: Check[] = [];
  const said = record.spoken.join(' ');
  const everything = `${said} ${record.chat.join(' ')}`.toLowerCase();
  const spoke = record.spoken.length > 0 && record.timing.firstAudio !== undefined;
  const addressed = directlyAddressesNogita(record.script);
  const addressHeard = addressed ? !!record.heard && directlyAddressesNogita(record.heard) : undefined;

  if (!record.heard && expect.respond !== 'silent') checks.push({ name: 'heard', ok: false, detail: 'no transcript reached Nogita' });
  if (addressHeard === false) checks.push({ name: 'name heard', ok: false, detail: `heard "${record.heard ?? ''}"` });
  if (expect.respond === 'speak') {
    checks.push({ name: 'answered aloud', ok: spoke, detail: spoke ? undefined : record.spoken.length ? 'speech produced no audio' : 'no spoken answer' });
  } else if (expect.respond === 'silent') {
    const quiet = !record.spoken.length && !record.chat.length;
    checks.push({ name: 'stayed silent', ok: quiet, detail: quiet ? undefined : (record.spoken[0] ?? record.chat[0]) });
  } else if (expect.respond === 'chat_only') {
    const ok = !record.spoken.length && record.chat.length > 0;
    checks.push({ name: 'chat only', ok, detail: ok ? undefined : record.spoken.length ? `spoke: ${record.spoken[0]}` : 'no chat notice' });
  }
  for (const group of expect.mentions ?? []) {
    const hit = group.find(phrase => everything.includes(phrase.toLowerCase()));
    checks.push({ name: `mentions ${group.slice(0, 3).join('/')}`, ok: !!hit });
  }
  for (const phrase of expect.forbid ?? []) {
    checks.push({ name: `avoids "${phrase}"`, ok: !everything.includes(phrase.toLowerCase()) });
  }
  if (expect.write && expect.write !== 'any') {
    const kinds = record.writes.map(write => write.split(':')[0]);
    const ok = expect.write === 'none' ? kinds.length === 0 : kinds.includes(expect.write);
    checks.push({ name: expect.write === 'none' ? 'no write' : `${expect.write} written`, ok, detail: record.writes.join('; ') || undefined });
  }
  if (expect.writeIncludes) {
    const hit = expect.writeIncludes.find(phrase => record.writes.some(write => write.toLowerCase().includes(phrase.toLowerCase())));
    checks.push({ name: `write mentions ${expect.writeIncludes.slice(0, 3).join('/')}`, ok: !!hit, detail: record.writes.join('; ') || 'no write' });
  }
  if (expect.handRaisedBefore) checks.push({ name: 'raised hand earlier', ok: record.handRaisedBefore });
  if (record.interruptedByNoise) checks.push({ name: 'not cut off', ok: false, detail: 'speech was interrupted without anyone talking over her' });
  if (record.turn.bargeIn) {
    const stop = record.timing.bargeInStop;
    checks.push({ name: 'stops when interrupted', ok: stop !== undefined && stop < 2_500,
      detail: stop === undefined ? 'kept talking' : `${stop} ms` });
  }
  return {
    checks, passed: checks.every(check => check.ok), addressHeard,
    wer: record.heard ? Math.round(wordErrorRate(record.script, record.heard) * 1000) / 1000 : undefined,
  };
}

export interface Stats { count: number; mean?: number; p50?: number; p90?: number; max?: number; min?: number }
export function stats(values: Array<number | undefined>): Stats {
  const list = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return { count: 0 };
  const at = (q: number) => list[Math.min(list.length - 1, Math.ceil(q * list.length) - 1)]!;
  return { count: list.length, mean: Math.round(list.reduce((sum, value) => sum + value, 0) / list.length),
    p50: at(0.5), p90: at(0.9), min: list[0], max: list.at(-1) };
}

/** Optional second opinion from a model on correctness and naturalness of a spoken answer. */
export async function judge(record: TurnRecord, apiKey: string, model: string, http: typeof fetch = fetch): Promise<Judgement | undefined> {
  if (!record.spoken.length && !record.chat.length) return undefined;
  const prompt = `You grade a voice assistant called Nogita that answers engineers in a meeting. It has tools over the team's GitHub repository, Jira and Slack.
Question (as scripted): ${record.script}
Question (as transcribed): ${record.heard ?? '(nothing)'}
What Nogita said aloud: ${record.spoken.join(' ') || '(nothing)'}
What Nogita wrote in chat: ${record.chat.join(' | ') || '(nothing)'}
Grader notes: ${record.turn.expect.note ?? 'none'}
Score 1-5: correct (answers the actual question, no invented facts), natural (sounds like a helpful colleague speaking, not a document), concise (right length for speech).
Reply with only JSON: {"correct": n, "natural": n, "concise": n, "comment": "one short sentence"}`;
  const response = await http('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = body.content?.find(block => block.type === 'text')?.text ?? '';
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '') as Judgement;
    return { correct: Number(parsed.correct), natural: Number(parsed.natural), concise: Number(parsed.concise),
      comment: String(parsed.comment ?? '').slice(0, 300) };
  } catch { return undefined; }
}
