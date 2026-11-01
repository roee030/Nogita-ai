/**
 * Structured digest of a tool result too large to hand to the model whole.
 *
 * Cutting at a fixed length keeps the first items and silently loses the rest: "what landed this week" would never
 * see the last day. The digest keeps the result's shape instead: every section with its item count, the groups its
 * items fall into (status, channel, author) and its top items, plus the offset where each omitted part starts.
 * The full text stays with the turn, and the model reads any part of it with `more_of_result`.
 */

import type { AgentToolSpec } from './agent.ts';

export const MORE_OF_RESULT = 'more_of_result';
export interface ResultDigest {
  text: string;
  omittedItems: number;
  omittedLines: number;
}
/** Characters returned by one `more_of_result` call. */
export const RESULT_PAGE_CHARS = 12_000;
const DIGEST_CHARS = 6_000;
const MAX_ITEM_CHARS = 300;
const MAX_PREAMBLE_LINES = 6;
const MAX_GROUPS = 8;
/** Room kept for a "... 12 more items from offset 48213" line. */
const MORE_LINE_CHARS = 60;

export const MORE_OF_RESULT_SPEC: AgentToolSpec = {
  name: MORE_OF_RESULT,
  description: 'Read more of a large tool result that was shown as a digest. Give the result id from the digest and the ' +
    `character offset to start at (the digest names the offset of each omitted part). Returns up to ${RESULT_PAGE_CHARS} ` +
    'characters and the offset to continue from. Only call it when the digest is not enough to answer.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The result id, for example "r1".' },
      offset: { type: 'integer', minimum: 0, description: 'Character offset to start reading at; 0 is the start.' },
    },
    required: ['id'],
  },
};

interface Line { text: string; offset: number }
interface Item { title: string; offset: number }
interface Section {
  heading?: Line;
  /** Items when the section is a list; undefined for plain text (a file, a patch). */
  items?: Item[];
  lines: Line[];
  end: number;
}

/** A digest of `text` for the model, at most about `budget` characters, naming `id` for `more_of_result`. */
export function digestResult(text: string, id: string, budget = DIGEST_CHARS): string {
  return digestResultWithStats(text, id, budget).text;
}

/** The digest plus counts that an operational trace can report without retaining result text. */
export function digestResultWithStats(text: string, id: string, budget = DIGEST_CHARS): ResultDigest {
  const lines = splitLines(text);
  const banner = `[Large result ${id}: ${text.length} characters, ${lines.length} lines, shown as a digest. ` +
    `Call ${MORE_OF_RESULT} with id "${id}" and an offset to read any part in full.]`;
  const sections = text.includes('\n---\n') ? blockSections(lines, text.length) : paragraphSections(lines, text.length);
  // A leading plain section is the result's own header ("3 commits, 2 merged pull requests."): keep it as is.
  const preamble: string[] = [];
  if (sections[0] && !sections[0].items) {
    const first = sections.shift()!;
    const lines = [...(first.heading ? [first.heading] : []), ...first.lines];
    preamble.push(...lines.slice(0, MAX_PREAMBLE_LINES).map(line => clip(line.text)));
    if (lines.length > MAX_PREAMBLE_LINES) preamble.push(`... ${lines.length - MAX_PREAMBLE_LINES} more lines from offset ${lines[MAX_PREAMBLE_LINES].offset}`);
  }
  const blocks = sections.map(section => ({ section, summary: summarize(section), shown: [] as string[], next: 0 }));
  // What is always shown: the banner, the preamble, and per section its summary and room for its "... more" line.
  const fixed = (kept: number) => [banner, ...preamble].join('\n').length + (kept < blocks.length ? MORE_LINE_CHARS : 0) +
    blocks.slice(0, kept).reduce((sum, block) => sum + block.summary.length + 2 + MORE_LINE_CHARS, 0);
  // Too many sections for even one line each: list as many as fit, then say how many were left out.
  let kept = blocks.length;
  while (kept > 1 && fixed(kept) > budget) kept--;
  const listed = blocks.slice(0, kept);
  let used = fixed(kept);
  // Top items, round-robin across sections, so the last section is not starved by the first.
  for (let added = true; added;) {
    added = false;
    for (const block of listed) {
      const entries = entriesOf(block.section);
      if (block.next >= entries.length) continue;
      const line = `  ${clip(entries[block.next].title)}`;
      if (used + line.length + 1 > budget) continue;
      block.shown.push(line);
      block.next++;
      used += line.length + 1;
      added = true;
    }
  }
  const out = [banner];
  if (preamble.length) out.push(...preamble);
  for (const block of listed) {
    out.push('', block.summary, ...block.shown);
    const entries = entriesOf(block.section);
    if (block.next < entries.length) {
      const what = block.section.items ? 'items' : 'lines';
      out.push(`  ... ${entries.length - block.next} more ${what} from offset ${entries[block.next].offset}`);
    }
  }
  if (kept < blocks.length) {
    out.push('', `... ${blocks.length - kept} more sections from offset ${blocks[kept].section.heading?.offset ?? blocks[kept].section.lines[0]?.offset ?? 0}`);
  }
  let omittedItems = 0;
  let omittedLines = 0;
  for (const block of listed) {
    const omitted = entriesOf(block.section).length - block.next;
    if (block.section.items) omittedItems += omitted; else omittedLines += omitted;
  }
  for (const block of blocks.slice(kept)) {
    if (block.section.items) omittedItems += entriesOf(block.section).length;
    else omittedLines += entriesOf(block.section).length;
  }
  return { text: out.join('\n'), omittedItems, omittedLines };
}

/** Part of a stored result, starting at a line boundary at or after `offset`, with where to continue. */
export function resultPage(text: string, id: string, offset: number, size = RESULT_PAGE_CHARS): string {
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  if (offset >= text.length) return `[${id}: offset ${offset} is past the end; the result has ${text.length} characters.]`;
  // Start at the line that holds `offset`, so a page never begins mid-line.
  const start = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;
  let end = Math.min(text.length, start + size);
  if (end < text.length) {
    const lineEnd = text.lastIndexOf('\n', end);
    if (lineEnd > start) end = lineEnd + 1;
  }
  const body = text.slice(start, end).replace(/\n$/, '');
  const tail = end < text.length ? `\n[${id} continues from offset ${end}.]` : `\n[End of ${id}.]`;
  return `[${id}, characters ${start}-${end} of ${text.length}]\n${body}${tail}`;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const part of text.split('\n')) {
    lines.push({ text: part, offset });
    offset += part.length + 1;
  }
  return lines;
}

/** Sections separated by blank lines; a section is a list when most of its top-level lines are items. */
function paragraphSections(lines: readonly Line[], length: number): Section[] {
  const sections: Section[] = [];
  let current: Line[] = [];
  const close = (end: number) => {
    if (current.length) sections.push(toSection(current, end));
    current = [];
  };
  for (const line of lines) {
    if (line.text.trim()) current.push(line);
    else close(line.offset);
  }
  close(length);
  return sections;
}

function toSection(lines: Line[], end: number): Section {
  const [first, ...rest] = lines;
  const heading = !isItem(first.text) && rest.length ? first : undefined;
  const body = heading ? rest : lines;
  const top = body.filter(line => !/^\s/.test(line.text));
  const listLike = top.length >= 2 && top.filter(line => isItem(line.text)).length >= top.length * 0.6;
  if (!listLike) return { heading, lines: body, end };
  const items: Item[] = [];
  for (const line of body) {
    // Indented lines (a pull request's body under its title) belong to the item above them.
    if (/^\s/.test(line.text) && items.length) continue;
    items.push({ title: line.text.trim(), offset: line.offset });
  }
  return { heading, items, lines: body, end };
}

/** Results made of `---`-separated blocks (code search evidence): each block is an item, titled by its first line. */
function blockSections(lines: readonly Line[], length: number): Section[] {
  const items: Item[] = [];
  let start = true;
  for (const line of lines) {
    if (line.text === '---') { start = true; continue; }
    if (start && line.text.trim()) { items.push({ title: line.text.trim(), offset: line.offset }); start = false; }
  }
  return [{ heading: { text: 'Matches:', offset: 0 }, items, lines: lines.slice(), end: length }];
}

function isItem(text: string): boolean {
  return /^(?:[-*•]\s|\[\d+\]\s|\d+[.)]\s|[A-Z][A-Z0-9_]+-\d+\b|\[[^\]]+\]\s|#\S+\s)/.test(text);
}

function entriesOf(section: Section): Item[] {
  return section.items ?? section.lines.map(line => ({ title: line.text, offset: line.offset }));
}

function summarize(section: Section): string {
  const heading = section.heading ? clip(section.heading.text.replace(/:$/, '')) : section.items ? 'Items' : 'Text';
  if (!section.items) return `${heading}: ${section.lines.length} lines.`;
  const groups = groupsOf(section.items);
  return `${heading}: ${section.items.length} items${groups ? `; ${groups}` : ''}.`;
}

/** Counts by the first key most items share: a status tag, a channel, a file change, or an author. */
function groupsOf(items: readonly Item[]): string | undefined {
  const keys: Array<[string, (title: string) => string | undefined]> = [
    ['status', title => /^\S+\s+\[([^\]\d][^\]]{0,30})\]/.exec(title)?.[1]],
    ['channel', title => /(?:^|\s)(#[a-z][\w.-]*)\s/i.exec(title)?.[1]],
    ['change', title => /\((added|modified|removed|renamed|changed|copied),/.exec(title)?.[1]],
    ['author', title => /\(([^(),]{1,40}),/.exec(title)?.[1]?.trim()],
  ];
  for (const [name, key] of keys) {
    const counts = new Map<string, number>();
    let keyed = 0;
    for (const item of items) {
      const value = key(item.title);
      if (value === undefined) continue;
      keyed++;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    if (keyed < items.length * 0.6 || counts.size < 1) continue;
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = sorted.slice(0, MAX_GROUPS).map(([value, count]) => `${value} ${count}`);
    if (sorted.length > MAX_GROUPS) shown.push(`${sorted.length - MAX_GROUPS} other ${name}s`);
    return `by ${name}: ${shown.join(', ')}`;
  }
  return undefined;
}

function clip(text: string): string {
  return text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}...` : text;
}
