/**
 * Evidence Ledger: every tool result of a turn is recorded as the sources it rests on (a commit, a file and its
 * lines, a CI run, a Jira issue, a Slack message, or the API call itself), each with an id like S3.
 *
 * Sources are read from the result text the toolbox already returns, so no tool has to change: a link is
 * classified by its shape, and a result with no link (a Slack channel read, a file list) is one source for the call.
 * In a chat answer the model cites sources as [S3]; `linkSources` turns those marks into numbered links.
 */

export type EvidenceKind = 'commit' | 'pull_request' | 'file' | 'ci_run' | 'issue' | 'message' | 'api';
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
