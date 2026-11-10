/**
 * P9-5: scoring the offline check of meeting-type inference against the labeled set. A confident wrong guess costs more
 * than no guess, so below the threshold the answer is `uncertain`. Every metric is a diagnostic, not a release gate (P9-6).
 */
import { CONFIDENCE_THRESHOLD, type MeetingProfile } from '../../src/core/meeting-profile.ts';

// The inference itself lives in the product code since P9-7 (shadow mode); the offline check uses the same prompt.
export { CONFIDENCE_THRESHOLD, PROFILES, inferProfile, parseInference, type Inference, type MeetingProfile } from '../../src/core/meeting-profile.ts';

export interface Scored { id: string; expected: MeetingProfile; got: MeetingProfile; confidence: number; named?: MeetingProfile }
export interface ProfileReport {
  total: number;
  /** Of the answers that named a type, how many were right: the costly mistake is a confident wrong type. */
  asserted: number; assertedCorrect: number;
  uncertain: number;
  /** Named a type and it was not the label: the costliest mistake. Counted over all answers. */
  confidentlyWrong: number;
  /** Answers the model gave a type for but the threshold turned into uncertain, and how many of those were right. */
  demoted: number; demotedRight: number;
  wrong: Scored[];
}

export function score(results: readonly Scored[]): ProfileReport {
  const asserted = results.filter(result => result.got !== 'uncertain');
  return { total: results.length, asserted: asserted.length, assertedCorrect: asserted.filter(result => result.got === result.expected).length,
    uncertain: results.length - asserted.length, confidentlyWrong: asserted.filter(result => result.got !== result.expected).length,
    demoted: results.filter(result => result.got === 'uncertain' && result.named && result.named !== 'uncertain').length,
    demotedRight: results.filter(result => result.got === 'uncertain' && result.named && result.named !== 'uncertain' && result.named === result.expected).length,
    wrong: results.filter(result => result.got !== result.expected) };
}

export function renderReport(report: ProfileReport): string {
  const share = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : 'n/a';
  // P9-6: diagnostic metrics, not release gates. Counts and denominators are always shown.
  return [`Correct when a type was named: ${report.assertedCorrect}/${report.asserted} (${share(report.assertedCorrect, report.asserted)}; diagnostic, target at least 85%, not a release gate)`,
    `Uncertain: ${report.uncertain}/${report.total} (${share(report.uncertain, report.total)}; diagnostic, target at most 25%, not a release gate)`,
    `Confidently wrong: ${report.confidentlyWrong}/${report.total} (${share(report.confidentlyWrong, report.total)}; diagnostic, target at most 5%, not a release gate)`,
    `Turned uncertain by the ${CONFIDENCE_THRESHOLD} threshold: ${report.demoted}/${report.total}, of which ${report.demotedRight} would have been right (provisional, uncalibrated)`,
    ...(report.wrong.length ? ['', 'Different from the label:', ...report.wrong.map(item => `- ${item.id}: labeled ${item.expected}, got ${item.got} (${item.confidence})`)] : [])].join('\n');
}
