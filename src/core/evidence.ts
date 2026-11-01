/**
 * Evidence Ledger: every tool result of a turn is recorded as the sources it rests on (a commit, a file and its
 * lines, a CI run, a Jira issue, a Slack message, or the API call itself), each with an id like S3.
 *
 * Sources are read from the result text the toolbox already returns, so no tool has to change: a link is
 * classified by its shape, and a result with no link (a Slack channel read, a file list) is one source for the call.
 * In a chat answer the model cites sources as [S3]; `linkSources` turns those marks into numbered links.
 */

export type EvidenceKind = 'commit' | 'pull_request' | 'file' | 'ci_run' | 'deployment' | 'issue' | 'message' | 'api';
export interface EvidenceSource {
  /** S1, S2, ... in the order the turn found them. */
  id: string;
  kind: EvidenceKind;
  /** Short name: "commit abc1234", "PR #41", "src/core/agent.ts:10-40", "KAN-12", "#dev messages". */
  label: string;
  url?: string;
  /** The text next to the link in the result (a commit title, a task line), shortened. */
  title?: string;
  /** The tool that returned it, and the model step (0 first). */
  tool: string;
  step: number;
}

/** A turn reads at most this many sources into the ledger; one result adds at most `MAX_PER_RESULT`. */
export const MAX_SOURCES = 200;
const MAX_PER_RESULT = 40;
const MAX_TITLE_CHARS = 120;

const URL_PATTERN = /https?:\/\/[^\s<>"'()\]]+[^\s<>"'()\].,;:!?]/g;
const ISSUE_KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/;
/** ci_status names the deployed commit on its own line: "Deployed: abc1234 to production (success, 2026-...)". */
const DEPLOYED_LINE = /^Deployed: ([0-9a-f]{7,40}) to (.+?) \((\w+), [^)]*\)/;

export class EvidenceLedger {
  private readonly sources: EvidenceSource[] = [];
  private readonly byKey = new Map<string, EvidenceSource>();

  get size(): number { return this.sources.length; }
  list(): EvidenceSource[] { return this.sources.slice(); }
  get(id: string): EvidenceSource | undefined { return this.sources.find(source => source.id === id); }

  /** Records the sources in one tool result and returns them (a source seen before keeps its first id). */
  record(tool: string, input: Record<string, unknown>, content: string, step: number): EvidenceSource[] {
    const found: EvidenceSource[] = [];
    const add = (key: string, source: Omit<EvidenceSource, 'id' | 'tool' | 'step'>) => {
      const known = this.byKey.get(key);
      if (known) { if (!found.includes(known)) found.push(known); return; }
      if (this.sources.length >= MAX_SOURCES || found.length >= MAX_PER_RESULT) return;
      const entry: EvidenceSource = { id: `S${this.sources.length + 1}`, ...source, tool, step };
      this.sources.push(entry);
      this.byKey.set(key, entry);
      found.push(entry);
    };
    const lines = content.split('\n');
    // read_file and show_on_screen name the lines they read in the first line: "path (lines 10-40 of 300)".
    const range = /^(\S+) \(lines (\d+)-(\d+) of \d+\)$/.exec(lines[0] ?? '');
    for (const [index, line] of lines.entries()) {
      const deployed = DEPLOYED_LINE.exec(line);
      if (deployed) {
        const url = line.match(URL_PATTERN)?.[0];
        add(`deploy:${deployed[1]}:${deployed[2]}`, { kind: 'deployment', label: `deployment ${deployed[1]!.slice(0, 7)} to ${deployed[2]}`,
          ...(url ? { url } : {}), title: line.replace(URL_PATTERN, '').trim().slice(0, MAX_TITLE_CHARS) });
        continue;
      }
      for (const match of line.matchAll(URL_PATTERN)) {
        const url = match[0];
        const near = line.replace(URL_PATTERN, '').replace(/^[\s\-–•]+|[\s:,.]+$/g, '').trim() ||
          (index > 0 ? lines[index - 1]!.trim() : '');
        const source = classify(url, near, range && index === 1 ? { path: range[1]!, start: range[2]!, end: range[3]! } : undefined);
        add(source.kind === 'file' ? `${url}#${source.label}` : url, source);
      }
    }
    if (!found.length) {
      const channel = typeof input.channel === 'string' ? input.channel : undefined;
      const what = Object.entries(input).filter(([, value]) => value !== undefined && value !== '')
        .map(([name, value]) => `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ').slice(0, 80);
      if (tool === 'read_channel' && channel) {
        add(`channel:${channel}`, { kind: 'message', label: `${channel.startsWith('#') ? channel : `#${channel}`} messages` });
      } else {
        add(`call:${tool}:${what}`, { kind: 'api', label: what ? `${tool} ${what}` : tool });
      }
    }
    return found;
  }
}

function classify(url: string, near: string, lines?: { path: string; start: string; end: string }): Omit<EvidenceSource, 'id' | 'tool' | 'step'> {
  const title = near ? near.slice(0, MAX_TITLE_CHARS) : undefined;
  const base = { url, ...(title ? { title } : {}) };
  let match: RegExpExecArray | null;
  if ((match = /\/commit\/([0-9a-f]{7,40})\b/i.exec(url))) return { kind: 'commit', label: `commit ${match[1]!.slice(0, 7)}`, ...base };
  if ((match = /\/pull\/(\d+)\b/.exec(url))) return { kind: 'pull_request', label: `PR #${match[1]}`, ...base };
  if ((match = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url))) {
    return { kind: 'ci_run', label: match[2] ? `CI job ${match[2]}` : `CI run ${match[1]}`, ...base };
  }
  if ((match = /\/(?:blob|tree)\/[^/]+\/([^#?]+)(?:#L(\d+)(?:-L(\d+))?)?/.exec(url))) {
    const path = decodeURIComponent(match[1]!);
    const start = lines?.start ?? match[2];
    const end = lines?.end ?? match[3];
    return { kind: 'file', label: start ? `${path}:${start}${end && end !== start ? `-${end}` : ''}` : path, ...base };
  }
  if ((match = /\/browse\/([A-Z][A-Z0-9_]+-\d+)\b/.exec(url))) return { kind: 'issue', label: match[1]!, ...base };
  if (/slack\.com\/archives\//.test(url)) return { kind: 'message', label: 'Slack message', ...base };
  const key = ISSUE_KEY.exec(near);
  if (key) return { kind: 'issue', label: key[0], ...base };
  let host = url;
  try { host = new URL(url).hostname; } catch { /* keep the link itself as its name */ }
  return { kind: 'api', label: host, ...base };
}

/** The result as the model sees it in a chat turn: each link followed by its source id, and a result without links
 *  headed by its one source. */
export function tagSources(content: string, sources: readonly EvidenceSource[]): string {
  const withUrl = sources.filter(source => source.url);
  let tagged = content;
  if (withUrl.length) {
    const ids = new Map<string, string[]>();
    for (const source of withUrl) ids.set(source.url!, [...(ids.get(source.url!) ?? []), source.id]);
    tagged = content.replace(URL_PATTERN, url => ids.has(url) ? `${url} [${ids.get(url)!.join(', ')}]` : url);
  }
  const bare = sources.filter(source => !source.url);
  return bare.length ? `[Source ${bare.map(source => `${source.id}: ${source.label}`).join('; ')}]\n${tagged}` : tagged;
}

export const CITE_SOURCES_PROMPT = 'Tool results mark their sources as [S1], [S2], ... After each claim that rests on a ' +
  'tool result, put the mark of its source, for example "The backoff fix is in PR #41 [S2]." Use only marks you were ' +
  'given; a claim with no source is your own reasoning and must read that way. Do not write a list of sources: it is added for you.';

/** How many sources a chat answer that cites none still links to. */
const UNCITED_SOURCES = 3;

/**
 * A chat answer with its [S3] marks turned into [1], [2] in the order they are first cited, and a "Sources:" list of
 * those, with links. Marks the ledger does not know are dropped. An answer that cites nothing lists the first sources
 * that have links, so a chat answer is never without them.
 */
export function linkSources(answer: string, ledger: EvidenceLedger): { text: string; cited: string[] } {
  const cited: string[] = [];
  const text = answer.replace(/\s*\[(S\d+(?:\s*,\s*S\d+)*)\]/g, (_whole, ids: string) => {
    const known = ids.split(',').map(id => id.trim()).filter(id => ledger.get(id));
    for (const id of known) if (!cited.includes(id)) cited.push(id);
    return known.length ? ` [${known.map(id => cited.indexOf(id) + 1).join(', ')}]` : '';
  }).trim();
  const listed = cited.length ? cited.map(id => ledger.get(id)!)
    : ledger.list().filter(source => source.url).slice(0, UNCITED_SOURCES);
  if (!listed.length) return { text, cited };
  const lines = listed.map((source, index) => `[${index + 1}] ${source.label}${source.url ? ` ${source.url}` : ''}`);
  return { text: `${text}\n\nSources:\n${lines.join('\n')}`, cited };
}

/**
 * Proof levels, lowest first: how far a capability has got. Each level includes the ones below it.
 * In chat the answer names the level its sources reach; "works in production" needs a deployment the tools found.
 */
export const PROOF_LEVELS = ['planned', 'in_code', 'tested', 'voice_lab', 'meeting', 'production'] as const;
export type ProofLevel = typeof PROOF_LEVELS[number];
export const PROOF_LEVEL_NAMES: Record<ProofLevel, string> = {
  planned: 'written in the plan', in_code: 'exists in code', tested: 'passed tests', voice_lab: 'passed the voice lab',
  meeting: 'tried in a meeting', production: 'works in production',
};
const SUCCEEDED = /\b(success|succeeded|passed)\b/i;
const FAILED = /\b(failure|failed|cancelled|timed_out|error)\b/i;

/** The highest level one source can show, or undefined when it shows none (a failed deployment). */
export function proofCeiling(source: EvidenceSource): ProofLevel | undefined {
  const text = `${source.label} ${source.title ?? ''}`;
  switch (source.kind) {
    case 'deployment': {
      // The state is the first word in the parentheses: success, active, failure, pending, ...
      const state = /\((\w+),/.exec(source.title ?? '')?.[1] ?? '';
      return /^(success|active)$/i.test(state) ? 'production' : undefined;
    }
    case 'ci_run': return SUCCEEDED.test(text) && !FAILED.test(text) ? 'tested' : 'in_code';
    case 'commit': case 'pull_request': return 'in_code';
    case 'file': {
      const path = source.label.replace(/:\d+(-\d+)?$/, '');
      if (/^docs\//.test(path)) {
        if (/meeting/i.test(path)) return 'meeting';
        if (/voice[-_ ]?(lab|benchmark|evaluation)/i.test(path)) return 'voice_lab';
        return 'planned';
      }
      if (/^tests?\/|\.test\.[jt]s$/.test(path)) return 'tested';
      return /\.(md|txt)$/i.test(path) ? 'planned' : 'in_code';
    }
    case 'api': return source.tool === 'list_files' || source.tool === 'search_code' ? 'in_code' : 'planned';
    case 'issue': case 'message': return 'planned';
  }
}

function rank(level: ProofLevel | undefined): number { return level ? PROOF_LEVELS.indexOf(level) : -1; }
function levelNamed(words: string): ProofLevel | undefined {
  const key = words.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return PROOF_LEVELS.find(level => level === key || PROOF_LEVEL_NAMES[level] === words.trim().toLowerCase());
}

export interface ProofCheck {
  /** The level the answer claimed, as the model wrote it. */
  claimed?: ProofLevel;
  /** The level shown: the claim, lowered to what its cited sources reach. Undefined when they reach none. */
  shown?: ProofLevel;
  /** A production claim in the prose with no deployment behind it was marked. */
  unsupportedProduction: boolean;
}

const PROOF_LINE = /^[*_]*Proof(?: level)?:[*_]*\s*([A-Za-z_ -]+?)\.?\s*((?:\[S\d+(?:\s*,\s*S\d+)*\]\s*)*)$/im;
const PRODUCTION_CLAIM = /\b(works?|working|runs?|running|live|deployed|shipped|released|out)\b[^.!?\n]{0,30}\b(in|to|on) prod(uction)?\b/i;
const NEGATION = /\b(not|never|no|unknown|unclear|whether|if)\b|n't\b/i;

/**
 * Checks the proof level of a chat answer against the ledger, before `linkSources` numbers the marks.
 * A "Proof: <level> [S2]" line is lowered to the highest level its cited sources reach and spelled out, with the
 * levels not reached yet. A sentence that says something works in production, when no source in the ledger shows a
 * deployment, is marked as not shown.
 */
export function checkProofLevels(answer: string, ledger: EvidenceLedger): { text: string; proof: ProofCheck } {
  const proof: ProofCheck = { unsupportedProduction: false };
  let text = answer;
  const line = PROOF_LINE.exec(text);
  if (line) {
    proof.claimed = levelNamed(line[1]!);
    const marks = line[2]!.trim();
    const ids = [...marks.matchAll(/S\d+/g)].map(match => match[0]).filter(id => ledger.get(id));
    const reached = ids.reduce<ProofLevel | undefined>((best, id) => {
      const ceiling = proofCeiling(ledger.get(id)!);
      return rank(ceiling) > rank(best) ? ceiling : best;
    }, undefined);
    if (proof.claimed) proof.shown = rank(proof.claimed) <= rank(reached) ? proof.claimed : reached;
    const notYet = PROOF_LEVELS.slice(rank(proof.shown) + 1).map(level => PROOF_LEVEL_NAMES[level]);
    const replacement = !proof.claimed ? line[0]
      : proof.shown ? `Proof level: ${PROOF_LEVEL_NAMES[proof.shown]}${marks ? ` ${marks}` : ''}.` +
        (notYet.length ? ` Not shown yet: ${notYet.join(', ')}.` : '')
      : 'Proof level: not shown by any source I found.';
    text = text.replace(line[0], replacement);
  }
  const deployed = ledger.list().some(source => proofCeiling(source) === 'production');
  if (!deployed) {
    text = text.replace(/[^.!?\n]+[.!?]?/g, sentence => {
      if (!PRODUCTION_CLAIM.test(sentence) || NEGATION.test(sentence) || /^Proof level:/.test(sentence.trim())) return sentence;
      proof.unsupportedProduction = true;
      return `${sentence.replace(/[.!?]?$/, '')} (not shown: no deployment was found)${/[.!?]$/.test(sentence) ? sentence.slice(-1) : ''}`;
    });
  }
  return { text, proof };
}
