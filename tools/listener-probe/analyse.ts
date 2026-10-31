export type ProbeMarker = { kind: 'question_end' | 'wait'; atMs: number; label?: string };
export type ProbeFrame = { atMs: number; rms: number };

export interface ProbeSession {
  version: 1;
  meeting: string;
  recordedAt: string;
  frameMs: number;
  threshold: number;
  frames: ProbeFrame[];
  markers: ProbeMarker[];
  recording?: string;
}

export interface Measurement {
  label: string;
  markerAtMs: number;
  transitionAtMs: number | null;
  latencyMs: number | null;
}

export interface SessionAnalysis {
  meeting: string;
  recordedAt: string;
  questionToSound: Measurement[];
  waitToSilence: Measurement[];
}

function sustainedTransition(frames: readonly ProbeFrame[], markerAtMs: number, threshold: number,
  active: boolean, requiredMs: number, frameMs: number): number | null {
  let start: number | undefined;
  let previous: number | undefined;
  for (const frame of frames) {
    if (frame.atMs < markerAtMs) continue;
    const matches = active ? frame.rms >= threshold : frame.rms < threshold;
    if (!matches) { start = undefined; previous = undefined; continue; }
    if (previous === undefined || frame.atMs - previous > frameMs * 2) start = frame.atMs;
    previous = frame.atMs;
    if (start !== undefined && frame.atMs - start + frameMs >= requiredMs) return start;
  }
  return null;
}

function measure(session: ProbeSession, kind: ProbeMarker['kind']): Measurement[] {
  const frames = [...session.frames]
    .filter(frame => Number.isFinite(frame.atMs) && Number.isFinite(frame.rms))
    .sort((a, b) => a.atMs - b.atMs);
  return [...session.markers].filter(marker => marker.kind === kind).sort((a, b) => a.atMs - b.atMs).map(marker => {
    const transitionAtMs = sustainedTransition(frames, marker.atMs, session.threshold, kind === 'question_end',
      kind === 'question_end' ? 60 : 300, session.frameMs);
    return { label: marker.label ?? kind.replace('_end', ''), markerAtMs: marker.atMs, transitionAtMs,
      latencyMs: transitionAtMs === null ? null : Math.max(0, transitionAtMs - marker.atMs) };
  });
}

export function analyseSession(session: ProbeSession): SessionAnalysis {
  if (session.version !== 1 || !session.meeting.trim() || !Number.isFinite(session.frameMs) || session.frameMs <= 0 ||
      !Number.isFinite(session.threshold) || session.threshold <= 0) throw new Error('invalid listener probe session');
  return { meeting: session.meeting, recordedAt: session.recordedAt,
    questionToSound: measure(session, 'question_end'), waitToSilence: measure(session, 'wait') };
}

function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]!;
}

const fmt = (value: number | null): string => value === null ? 'n/a' : `${Math.round(value)} ms`;

export function renderComparison(results: readonly SessionAnalysis[]): string {
  const lines = [
    '# Listener-side Meet measurements', '',
    'Timings are measured from the second participant’s microphone capture. Missing transitions stay missing.', '',
    '| Meeting | question n | question p50 | question p95 | wait n | wait p50 | wait p95 |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const result of results) {
    const questions = result.questionToSound.flatMap(item => item.latencyMs === null ? [] : [item.latencyMs]);
    const waits = result.waitToSilence.flatMap(item => item.latencyMs === null ? [] : [item.latencyMs]);
    lines.push(`| ${result.meeting} | ${questions.length} | ${fmt(percentile(questions, 50))} | ${fmt(percentile(questions, 95))} | ${waits.length}/${result.waitToSilence.length} | ${fmt(percentile(waits, 50))} | ${fmt(percentile(waits, 95))} |`);
  }
  const missing = results.flatMap(result => [
    ...result.questionToSound.filter(item => item.latencyMs === null).map(item => `${result.meeting} — ${item.label}: ${item.markerAtMs} ms → no sustained sound observed`),
    ...result.waitToSilence.filter(item => item.latencyMs === null).map(item => `${result.meeting} — ${item.label}: ${item.markerAtMs} ms → no stable silence observed`),
  ]);
  if (missing.length) lines.push('', '## Missing observations', '', ...missing.map(item => `- ${item}`));
  lines.push('');
  return lines.join('\n');
}
