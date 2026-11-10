/**
 * P9-15 (partial): how far a model judge agrees with human labels, per dimension, before the judge's score is allowed to
 * influence a decision (P9-18 supplies the human labels). Reports counts and denominators, exact agreement, Cohen's kappa
 * and, for numeric scores, how often the two are within one point. No threshold here is a gate.
 */

export interface Rating { caseId: string; dimension: string; judge: string | number; human: string | number }

export interface Agreement {
  dimension: string;
  n: number;
  exact: number;
  /** Cohen's kappa: agreement beyond chance. 1 is perfect, 0 is chance. Undefined when chance agreement is total. */
  kappa?: number;
  /** Numeric scores only: pairs within one point of each other. */
  withinOne?: number;
  disagreements: Rating[];
}

export function cohensKappa(pairs: ReadonlyArray<readonly [string, string]>): number | undefined {
  if (!pairs.length) return undefined;
  const n = pairs.length;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const labels = new Set(pairs.flat());
  let expected = 0;
  for (const label of labels) {
    const a = pairs.filter(([x]) => x === label).length / n;
    const b = pairs.filter(([, y]) => y === label).length / n;
    expected += a * b;
  }
  return expected === 1 ? undefined : (observed - expected) / (1 - expected);
}

export function agreement(ratings: readonly Rating[]): Agreement[] {
  const byDimension = new Map<string, Rating[]>();
  for (const rating of ratings) byDimension.set(rating.dimension, [...(byDimension.get(rating.dimension) ?? []), rating]);
  return [...byDimension].sort(([a], [b]) => a.localeCompare(b)).map(([dimension, items]) => {
    const pairs = items.map(item => [String(item.judge), String(item.human)] as const);
    const numeric = items.every(item => typeof item.judge === 'number' && typeof item.human === 'number');
    const kappa = cohensKappa(pairs);
    return { dimension, n: items.length, exact: pairs.filter(([a, b]) => a === b).length,
      ...(kappa !== undefined ? { kappa } : {}),
      ...(numeric ? { withinOne: items.filter(item => Math.abs(Number(item.judge) - Number(item.human)) <= 1).length } : {}),
      disagreements: items.filter(item => String(item.judge) !== String(item.human)) };
  });
}

export function renderAgreement(results: readonly Agreement[]): string {
  if (!results.length) return 'No ratings.';
  const lines = ['| Dimension | Exact | Kappa | Within one |', '|---|---|---|---|'];
  for (const r of results) lines.push(`| ${r.dimension} | ${r.exact}/${r.n} | ${r.kappa === undefined ? 'n/a' : r.kappa.toFixed(2)} | ${r.withinOne === undefined ? 'n/a' : `${r.withinOne}/${r.n}`} |`);
  const off = results.flatMap(r => r.disagreements.map(d => `- ${r.dimension} / ${d.caseId}: judge ${d.judge}, human ${d.human}`));
  return [...lines, ...(off.length ? ['', 'Disagreements:', ...off] : []), '',
    'Diagnostic only: no agreement level is a gate until Roee sets one (P9-18).'].join('\n');
}
