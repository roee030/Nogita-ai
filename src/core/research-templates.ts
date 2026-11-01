/** Research templates for the questions teams ask again and again: what changed in a period, the state of a feature,
 *  why something broke, the open tasks on a subject, and the difference between two versions. A template is a short
 *  plan for the turn prompt: which sources to read, in what order, and what the answer must cover. Steps name only the
 *  tools this turn has, so a question that crosses GitHub, Jira and Slack reads all three when they are connected. */
import type { TeamPeriod } from './team-time.ts';

export type ResearchKind = 'version_diff' | 'incident_cause' | 'changes' | 'open_tasks' | 'feature_status';
export const RESEARCH_KINDS: readonly ResearchKind[] = ['version_diff', 'incident_cause', 'changes', 'open_tasks', 'feature_status'];

export interface ResearchMatch {
  kind: ResearchKind;
  /** The team period the question names, for repo_activity. */
  period?: TeamPeriod;
  /** Sources the person named ("in Slack", "the Jira tickets"): those are read even when the template would not. */
  named: Array<'code' | 'board' | 'chat'>;
}

/** One step of a plan: what to do, and the tools it needs (any one of them is enough). */
interface Step { text: string; tools: string[] }

const PERIOD_WORDS: Array<[RegExp, TeamPeriod]> = [
  [/\btoday\b|\bthis morning\b|\bsince (?:this )?morning\b/i, 'today'],
  [/\byesterday\b/i, 'yesterday'],
  [/\blast week\b|\bprevious week\b/i, 'last_week'],
  [/\b(?:past|last) (?:7|seven) days\b/i, 'last_7_days'],
  [/\bthis week\b|\bweek so far\b/i, 'this_week'],
];

/** Checked in order: the narrower kinds come first ("what changed between 1.2 and 1.3" is a version diff, not a
 *  period; "why did the deploy fail" is an incident, not a status question). */
const PATTERNS: Array<[ResearchKind, RegExp]> = [
  ['version_diff', /\b(?:difference|diff|differs?|changed?|compare|comparing|new)\b.*\bbetween\b.+\band\b|\b(?:compare|comparing|diff)\b.+\b(?:with|to|vs\.?|versus|and)\b.*(?:\bv?\d+\.\d+|\brelease|\bversion|\btag)|\bv?\d+\.\d+(?:\.\d+)?\s*(?:vs\.?|versus)\s*v?\d+\.\d+|\bsince (?:v\d|version \d|release \d|the last release)/i],
  ['incident_cause', /\bwhy (?:did|does|is|was|were|are|do)\b.*\b(?:fail|failing|failed|break|breaking|broke|broken|crash|crashing|crashed|down|red|slow|error|erroring|flaky|timing out|time out|stuck|lost|drop|dropping|dropped)|\b(?:root cause|what caused|what broke|cause of|post-?mortem|went wrong)\b|\bwhy\b.*\b(?:outage|incident|regression|bug|5\d\d|exception)/i],
  ['changes', /\bwhat(?:'s| has| have|)\s*(?:changed|landed|shipped|merged|gone in|went in|got in|got merged|is new|new|happened)\b|\bwhat (?:did we|did they|did \w+) (?:ship|merge|push|land|change|do)\b|\b(?:changes|commits|merges|activity|changelog)\b.*\b(?:today|yesterday|this week|last week|days)\b|\bany(?:thing)? new\b.*\b(?:today|yesterday|week)/i],
  ['open_tasks', /\b(?:open|remaining|pending|outstanding|unresolved|unfinished|left)\b.*\b(?:tasks?|tickets?|issues?|bugs?|items?|work)\b|\b(?:tasks?|tickets?|issues?|bugs?)\b.*\b(?:still open|open|left|remaining|not done)\b|\bwhat(?:'s| is) left\b/i],
  ['feature_status', /\b(?:status|state|progress)\b.*\b(?:of|on|for|with)\b|\bwhere (?:are|is|do) (?:we|they|things|it)\b|\bhow(?:'s| is| are)\b.*\b(?:going|coming along|looking|doing)\b|\bis\b.*\b(?:done|ready|finished|shipped|live|deployed|working|merged)\b|\bdid\b.*\b(?:ship|land|get merged|go live)\b/i],
];

const NAMED_SOURCES: Array<[RegExp, 'code' | 'board' | 'chat']> = [
  [/\b(?:github|git|repo|repository|code|commits?|pull requests?|prs?|ci|build|pipeline)\b/i, 'code'],
  [/\b(?:jira|board|tickets?|tasks?|issues?|backlog|sprint|linear)\b/i, 'board'],
  [/\b(?:slack|channel|thread|chat|messages?|discussed|said|talked)\b/i, 'chat'],
];

/** The template a question fits, if any. Questions that only ask for an action ("open a task about ...") fit none. */
export function matchResearchTemplate(request: string): ResearchMatch | undefined {
  const text = request.replace(/\s+/g, ' ').trim();
  if (!text || /^(?:please |can you |could you |nogita,? )*(?:open|create|log|file|add|post|send|assign|move|close|mark)\b/i.test(text)) return undefined;
  const kind = PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
  if (!kind) return undefined;
  const period = PERIOD_WORDS.find(([pattern]) => pattern.test(text))?.[1];
  const named = NAMED_SOURCES.filter(([pattern]) => pattern.test(text)).map(([, source]) => source);
  return { kind, ...(period ? { period } : {}), named: [...new Set(named)] };
}

const CODE = ['repo_activity', 'recent_commits', 'get_change', 'search_code', 'read_file', 'ci_status'];
const BOARD = ['search_tasks', 'get_task'];
const CHAT = ['search_messages', 'read_channel'];

function steps(match: ResearchMatch): Step[] {
  const period = match.period ? `period "${match.period}"` : 'the period they named (since/until when no team period fits)';
  switch (match.kind) {
    case 'changes': return [
      { text: `repo_activity with ${period}: one call returns every commit and merged pull request, so do not page through recent_commits.`, tools: ['repo_activity'] },
      { text: 'get_change only for a change whose title does not say what it did.', tools: ['get_change'] },
      { text: 'search_tasks for tasks moved or closed in the same period, to tie changes to the work they finish.', tools: ['search_tasks'] },
      { text: 'search_messages for announcements or discussion of those changes in the same period.', tools: ['search_messages'] },
    ];
    case 'feature_status': return [
      { text: 'search_tasks for the feature by its name, then get_task on the main one for status, owner and the latest comments.', tools: ['search_tasks', 'get_task'] },
      { text: 'search_code and recent_commits (or repo_activity) for the feature, to see what is actually in the code and when it last moved.', tools: ['search_code', 'recent_commits', 'repo_activity'] },
      { text: 'ci_status on the branch or pull request that carries it, to know whether it passed and whether it is deployed.', tools: ['ci_status'] },
      { text: 'search_messages for the feature, for blockers or decisions the task does not record.', tools: ['search_messages'] },
    ];
    case 'incident_cause': return [
      { text: 'ci_status on the branch, commit or pull request that broke, for the failing job and step.', tools: ['ci_status'] },
      { text: 'repo_activity for the hours before it started, then get_change on the changes that touch the failing area.', tools: ['repo_activity', 'get_change'] },
      { text: 'read_file on the code the failure points at, to confirm the cause instead of guessing it from a title.', tools: ['read_file', 'search_code'] },
      { text: 'search_tasks for a bug already open about it.', tools: ['search_tasks'] },
      { text: 'search_messages for the incident discussion: when it was first seen and what was already tried.', tools: ['search_messages'] },
    ];
    case 'open_tasks': return [
      { text: 'search_tasks with the subject\'s words and no done status; search again with a synonym if the first search finds little.', tools: ['search_tasks'] },
      { text: 'get_task on any task whose title does not say what is left.', tools: ['get_task'] },
      { text: 'search_code or recent_commits for work on the subject that no task tracks yet.', tools: ['search_code', 'recent_commits'] },
      { text: 'search_messages for asks on the subject that never became a task.', tools: ['search_messages'] },
    ];
    case 'version_diff': return [
      { text: 'Pin both versions to a commit or a date first: search_code for the changelog or the version in the package file, and recent_commits for release commits.', tools: ['search_code', 'recent_commits'] },
      { text: 'repo_activity with since and until set to the two release times, for every change between them.', tools: ['repo_activity'] },
      { text: 'get_change on the changes that matter most (breaking, migrations, removed behavior).', tools: ['get_change'] },
      { text: 'search_tasks for the tasks those changes close.', tools: ['search_tasks'] },
    ];
  }
}

const COVER: Record<ResearchKind, string> = {
  changes: 'Cover every merged pull request and every commit outside one, grouped by theme, with who made it; give the counts. If nothing landed, say so plainly.',
  feature_status: 'Say where it stands in one sentence, then what each source shows (task, code, CI, discussion) and what is blocking it. When sources disagree (the task says done, the code is not merged), say so.',
  incident_cause: 'Name the cause and the change or condition behind it, separate what a source confirmed from what is still a guess, and say whether it is fixed and where.',
  open_tasks: 'Give the count, then each task with its status and owner, most urgent first; name work found outside the board separately.',
  version_diff: 'Name the two versions and the commits they map to, then the changes between them grouped by theme, breaking changes first. If a version cannot be pinned, say which and stop there.',
};

const SOURCE_OF: Record<'code' | 'board' | 'chat', string[]> = { code: CODE, board: BOARD, chat: CHAT };
const SOURCE_NAME: Record<'code' | 'board' | 'chat', string> = { code: 'the repository', board: 'the board', chat: 'the chat' };

/** The research plan for a question, or undefined when it fits no template or no step's tool is available. */
export function researchPlan(request: string, tools: readonly string[], options: { voice?: boolean } = {}): string | undefined {
  const match = matchResearchTemplate(request);
  if (!match) return undefined;
  const have = new Set(tools);
  const usable = steps(match).filter(step => step.tools.some(tool => have.has(tool)));
  if (!usable.length) return undefined;
  const missing = match.named.filter(source => !SOURCE_OF[source].some(tool => have.has(tool)));
  const used = new Set(usable.flatMap(step => step.tools.filter(tool => have.has(tool))));
  const crossing = (Object.keys(SOURCE_OF) as Array<'code' | 'board' | 'chat'>)
    .filter(source => SOURCE_OF[source].some(tool => used.has(tool))).map(source => SOURCE_NAME[source]);
  return [
    `Research plan for this question (${match.kind.replace('_', ' ')}). Run the independent lookups in parallel${options.voice ? ', in at most two rounds' : ''}:`,
    ...usable.map((step, index) => `${index + 1}. ${step.text}`),
    crossing.length > 1 ? `Answer from ${crossing.slice(0, -1).join(', ')} and ${crossing.at(-1)} together; say which source each fact came from.` : '',
    missing.length ? `They asked about ${missing.map(source => SOURCE_NAME[source]).join(' and ')}, which you cannot read here: say so in one short clause.` : '',
    options.voice ? `Say the gist out loud; the full answer goes to chat. ${COVER[match.kind]}` : COVER[match.kind],
  ].filter(Boolean).join('\n');
}
