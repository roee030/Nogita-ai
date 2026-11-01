import type { ActionReceipt, Actor, BoardPort, ChatPort, CiStatus, CodeChange, CodePort, Evidence, ExternalAction, MeetingMemoryPort, PolicyPort, PullRequestPort, RepoActivity, ScreenCard, TaskSearch } from './contracts.ts';
import { isExplicitPRRequest } from './policy.ts';
import { findVolunteer, withMeetingQuotes, type ActionItem } from './drafting.ts';
import type { AgentToolbox, AgentToolSpec, ToolOutcome } from './agent.ts';
import type { DirectRequest, MissionReport } from './missions.ts';
import { TEAM_PERIODS, UTC_TEAM, teamPeriod, type TeamPeriod, type TeamTime } from './team-time.ts';

/** Maps spoken names to people a board can assign. Trusted configuration only, never model output. */
export interface PeopleDirectory {
  /** Internal identity IDs whose display name matches `name` (full name or a unique first name). */
  findByName(name: string): Array<{ id: string; displayName: string }>;
  /** Display name for an internal identity ID, used for "assign it to me". */
  displayNameFor(id: string): string | undefined;
}

export interface ToolboxContext {
  actor: Actor;
  /** The direct request (plus the original request for a follow-up), used for explicit-write checks. */
  request: string;
  sessionId: string;
  eventId: string;
  policy: PolicyPort;
  code: CodePort;
  board: BoardPort;
  chat?: ChatPort;
  /** Draft pull requests, when the team turned them on. */
  drafts?: PullRequestPort;
  people?: PeopleDirectory;
  /** What was said before this request, "Name: text" oldest first: quoted in new tasks and read for a volunteer owner. */
  transcript?: () => readonly string[];
  /** Action items heard in this meeting so far, with their owners. */
  actionItems?: () => ActionItem[];
  /** Decisions and action items of earlier meetings, when the team turned meeting memory on. */
  memory?: MeetingMemoryPort;
  /** Called after a successful write so the meeting chat gets the link immediately. */
  onReceipt: (receipt: ActionReceipt) => Promise<void>;
  /** Idempotency memory shared across retries of the same event. */
  completed: Map<string, ActionReceipt>;
  recordAction?: (action: ExternalAction) => void;
  /** Puts a card on the meeting's shared screen (undefined clears it). Voice meetings with a presence screen only. */
  show?: (card: ScreenCard | undefined) => void;
  /** Who can see the shared screen: participants not mapped to a known team member. Unknown when undefined. */
  screenAudience?: () => { unverified: number } | undefined;
  /** A mission runs a write only after its owner approved that exact action, so the request wording is not checked. */
  writesApproved?: boolean;
  /** Delegated missions of the person speaking (start, check, approve, decline, resume, cancel). */
  missions?: MissionPort;
  /** Leaves the meeting once this reply is over. Live meetings only. */
  leave?: () => void;
  /** With NOGITA_SHORT_SPOKEN_RESULTS in a voice meeting: a long result goes to chat whole, and the spoken reply stays short. */
  postDetails?: (text: string) => Promise<void>;
  /** The team's time zone and week start, for "today" and "this week". UTC when not configured. */
  team?: TeamTime;
  now?: () => number;
  /** Offers create_tasks and update_tasks (up to 10 items each, one chat receipt). Off unless the team turned it on. */
  batchTasks?: boolean;
  /** Offers ci_status (CI runs and the deployed commit). Off unless the team turned it on. */
  ciStatus?: boolean;
  /** Offers mission_status (what a mission did, what failed and what is still open, with sources). Off unless set. */
  missionStatus?: boolean;
  /** Told of every write this toolbox makes, after it succeeded or failed (the audit log). */
  audit?: (write: WriteAudit) => void;
  /** Caps on writes per person and per meeting; a write past a cap is refused with a clear line. */
  limits?: LimitsPort;
}

/** One write to Jira, Slack or GitHub: who asked, where, what was sent, and what came of it. */
export interface WriteAudit {
  action: 'create_task' | 'update_task' | 'post_message' | 'open_draft';
  actor: { id: string; displayName: string };
  /** The meeting, Slack thread or mission ("mission-M-...") the request came from. */
  sessionId: string;
  eventId: string;
  sent: Record<string, unknown>;
  ok: boolean;
  receipt?: ActionReceipt;
  error?: string;
}

type WritePorts = { board: BoardPort; chat?: ChatPort; drafts?: PullRequestPort };
type AroundWrite = (action: WriteAudit['action'], sent: Record<string, unknown>, work: () => Promise<ActionReceipt>) => Promise<ActionReceipt>;

/** The same ports with every write (create or update a task, post a message, open a draft) run through `around`. */
function wrapWrites(ports: WritePorts, around: AroundWrite): WritePorts {
  const wrap = <P extends object>(port: P, writes: Partial<Record<keyof P, (port: P, ...args: never[]) => Promise<ActionReceipt>>>) =>
    new Proxy(port, { get(target, name, receiver) {
      const write = writes[name as keyof P];
      if (write) return (...args: never[]) => write(target, ...args);
      const value = Reflect.get(target, name, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  const board = wrap<BoardPort>(ports.board, {
    createTask: (port, input: Parameters<BoardPort['createTask']>[0]) => around('create_task', { ...input }, () => port.createTask(input)),
    ...(ports.board.updateTask ? { updateTask: (port: BoardPort, input: Parameters<NonNullable<BoardPort['updateTask']>>[0]) =>
      around('update_task', { ...input }, () => port.updateTask!(input)) } : {}),
  });
  const chat = ports.chat && wrap<ChatPort>(ports.chat, {
    postMessage: (port, channel: string, text: string) => around('post_message', { channel, text }, () => port.postMessage(channel, text)),
  });
  const drafts = ports.drafts && wrap<PullRequestPort>(ports.drafts, {
    openDraft: (port, input: Parameters<PullRequestPort['openDraft']>[0]) => around('open_draft', { ...input }, () => port.openDraft(input)),
  });
  return { board, ...(chat ? { chat } : {}), ...(drafts ? { drafts } : {}) };
}

/** The write ports with each write reported to `audit`; reads pass through untouched. */
export function auditedPorts(context: Pick<ToolboxContext, 'actor' | 'sessionId' | 'eventId' | 'board' | 'chat' | 'drafts'>,
  audit: (write: WriteAudit) => void): WritePorts {
  return wrapWrites(context, async (action, sent, work) => {
    const base = { action, actor: { id: context.actor.id, displayName: context.actor.displayName }, sessionId: context.sessionId, eventId: context.eventId, sent };
    try {
      const receipt = await work();
      try { audit({ ...base, ok: true, receipt }); } catch { /* The log never fails a write that happened. */ }
      return receipt;
    } catch (error) {
      try { audit({ ...base, ok: false, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown error' }); } catch { /* as above */ }
      throw error;
    }
  });
}

/** Rate limits: `take` counts one write or model call and returns undefined to go on, or the line to say when this
 *  person or meeting has reached a limit (then nothing is done). */
export interface LimitsPort {
  take(kind: 'write' | 'model_call', who: { actorId: string; sessionId: string }): string | undefined;
}

/** A limit was reached; `spoken` says which and when it frees up. Nothing was sent. */
export class LimitReachedError extends Error {
  constructor(readonly spoken: string) {
    super(`${spoken} Nothing was done. Tell the person that in one short sentence; do not try again.`);
    this.name = 'LimitReachedError';
  }
}

/** The write ports with each write counted against the person's and the meeting's limits first. */
export function limitedPorts(ports: WritePorts, limits: LimitsPort, who: { actorId: string; sessionId: string }): WritePorts {
  return wrapWrites(ports, (_action, _sent, work) => {
    const reached = limits.take('write', who);
    if (reached) return Promise.reject(new LimitReachedError(reached));
    return work();
  });
}

/** Leaving needs words that ask for it in the request itself, never only in something she read. */
const LEAVE_WORDS = /\b(?:leave|leaving|go|bye|goodbye|drop|exit|disconnect|hang up|sign off|log off|get off|get out|head out|end (?:the|this) (?:call|meeting)|done)\b/i;

/** What a conversation may do with missions, already bound to the person speaking. */
export interface MissionPort {
  start(goal: string, doneWhen?: string): Promise<{ id: string }>;
  list(): Array<{ id: string; goal: string; status: string; activity?: string; pending?: string; lastFinding?: string; result?: string; owner: string }>;
  decide(decision: 'approve' | 'decline' | 'resume' | 'cancel', id?: string, note?: string): Promise<{ ok: boolean; message: string }>;
  /** One mission in full, or the latest one this person asked for; undefined when none fits. */
  report?(id?: string): MissionReport | undefined;
  /** With NOGITA_WHATS_LEFT_DIRECT: this person's recent requests done in the turn itself, newest first. */
  recent?(): DirectRequest[];
}

/** Things the engine needs after the turn: the best source link and the receipts that were posted. */
export interface ToolboxReport {
  codeReferences: Evidence[];
  receipts: ActionReceipt[];
  wroteSomething: boolean;
}

const MAX_WRITES_PER_TURN = 5;
const MAX_BATCH_ITEMS = 10;

/** A question about existing things ("what are the open issues?") is not a command, unless it is a polite request. */
function isInformationQuestion(t: string): boolean {
  const lead = t.replace(/^(?:(?:hey|hi|ok|okay|so|and|also|nogita)[,\s]+)+/, '');
  if (/^(?:can|could|would|will) you\b|^please\b/.test(lead)) return false;
  return /^(?:what|what's|whats|which|who|whom|when|where|why|how|did|does|do|is|are|was|were|has|have|any)\b/.test(lead);
}
const TASK_NOUN = String.raw`(?:task|tasks|ticket|tickets|issue|issues|bug|bugs|story|stories|card|cards|todo|to-do)`;

/** A direct request to make a ticket. Wider than the legacy planner check, still deterministic. */
export function requestsTaskWrite(request: string): boolean {
  // A follow-up carries the earlier request on its own line ("what did we merge today?" / "open a task for each
  // one" / "Yes, please"): any line may be the ask, and a question on one line must not veto another.
  if (request.includes('\n')) return request.split('\n').some(line => requestsTaskWrite(line));
  const t = request.toLowerCase().replace(/\s+/g, ' ').trim();
  if (isInformationQuestion(t)) return false;
  if (/\b(?:pr|pull request)\b/.test(t) && !new RegExp(`\\b${TASK_NOUN}\\b`).test(t)) return false;
  // "open" right before a plural noun after a determiner is an adjective: "the open issues", "any open tasks".
  const cleaned = t.replace(/\b(?:the|any|all|our|their|my|your|which|what|many|more|of|are|is|for|with)\s+open\s+(?:tasks|tickets|issues|bugs|stories|items)\b/g, '');
  return new RegExp(`\\b(?:create|open|add|file|make|log|raise|write up|new)\\s+(?:[\\w'-]+\\s+){0,5}?${TASK_NOUN}\\b`).test(cleaned) ||
    // "And open one for me to write tests for ...", right after a task was opened.
    /\b(?:create|open|add|file|log|make)\s+(?:another\s+)?one\s+(?:for|to|about|on)\b/.test(cleaned) ||
    /\b(?:add|put|move|log)\s+(?:it|this|that|these|those|them|both)\b.{0,40}\b(?:backlog|jira|board|sprint)\b/.test(cleaned) ||
    /\bwrite (?:it|this|that) up\b/.test(cleaned);
}
const TASK_TARGET = String.raw`(?:[a-z][a-z0-9_]+-\d+|(?:the|this|that|my|his|her|their|our)\s+(?:[\w'-]+\s+){0,3}?${TASK_NOUN}|it|this|that|them|those|both)`;
const STATUS_CHANGE = new RegExp(String.raw`\b(?:(?:move|set|put|change|switch|push|bump)\s+${TASK_TARGET}\b.{0,40}\b(?:to|in|into|as)\b|mark\s+${TASK_TARGET}\b|(?:close|resolve|reopen|finish)\s+${TASK_TARGET}\b|set\s+the\s+status\b)`);
const ASSIGN_CHANGE = new RegExp(String.raw`\b(?:(?:re)?assign\s+${TASK_TARGET}\b.{0,40}\bto\b|(?:give|hand)\s+${TASK_TARGET}\s+to\b|make\s+\w+(?:\s+\w+)?\s+(?:the\s+)?owner\b)`);
const COMMENT_CHANGE = new RegExp(String.raw`\b(?:comment\s+on\s+${TASK_TARGET}\b|(?:add|leave|write|put)\s+(?:a\s+|an?\s+)?(?:comment|note)\b)`);

/**
 * Which parts of an existing task the request explicitly asks to change. A question about a task ("what's the status of
 * KAN-12?") changes nothing, and each part needs its own words, so a move never brings along a comment nobody asked for.
 */
export function requestedTaskChanges(request: string): { status: boolean; assignee: boolean; comment: boolean } {
  if (request.includes('\n')) {
    const parts = request.split('\n').map(line => requestedTaskChanges(line));
    return { status: parts.some(p => p.status), assignee: parts.some(p => p.assignee), comment: parts.some(p => p.comment) };
  }
  const t = request.toLowerCase().replace(/\s+/g, ' ').trim();
  if (isInformationQuestion(t)) return { status: false, assignee: false, comment: false };
  return { status: STATUS_CHANGE.test(t), assignee: ASSIGN_CHANGE.test(t), comment: COMMENT_CHANGE.test(t) };
}
/** A direct request to send something to a Slack channel. */
export function requestsChatPost(request: string): boolean {
  const t = request.toLowerCase().replace(/\s+/g, ' ').trim();
  if (isInformationQuestion(t)) return false;
  const cleaned = t.replace(/\b(?:tell me|let me|let's|lets|show me|send me)\b/g, '');
  return /\b(?:post|send|share|tell|message|notify|announce|ping|let)\b.{0,80}(?:\bslack\b|\bchannel\b|#[\w-]+|\bthread\b|\beveryone\b|\bthe team\b)/.test(cleaned);
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
}
function int(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}
function formatActivity(activity: RepoActivity): string {
  const lines = [`${activity.repository}, live branch ${activity.branch}, ${activity.since} to ${activity.until}.` +
    (activity.snapshot ? ` (search_code and read_file read the snapshot ${activity.snapshot.slice(0, 7)}.)` : '')];
  lines.push(`${activity.commits.length} commit(s), ${activity.mergedPullRequests.length} merged pull request(s)` +
    `${activity.truncated ? '; lists were capped, so these are lower bounds' : ''}.`);
  if (activity.mergedPullRequests.length) {
    lines.push('', 'Merged pull requests:');
    for (const pull of activity.mergedPullRequests) {
      lines.push(`- #${pull.number} ${pull.title} (${pull.author}, merged ${pull.mergedAt}) ${pull.url}`);
      if (pull.body) lines.push(`  ${pull.body.replace(/\s*\n\s*/g, ' ').slice(0, 300)}`);
    }
  }
  if (activity.commits.length) {
    lines.push('', 'Commits (newest first):');
    for (const commit of activity.commits.slice(0, 60)) {
      lines.push(`- ${commit.sha.slice(0, 7)} ${commit.title} (${commit.author}, ${commit.date}) ${commit.url}`);
    }
    if (activity.commits.length > 60) lines.push(`- ... ${activity.commits.length - 60} more`);
  }
  if (activity.files) {
    lines.push('', `Files: ${activity.files.changed} changed, +${activity.files.additions} -${activity.files.deletions}. Most changed:`);
    for (const file of activity.files.top) lines.push(`- ${file.path} (${file.status}, +${file.additions} -${file.deletions})`);
  }
  if (!activity.commits.length && !activity.mergedPullRequests.length) lines.push('Nothing landed on this branch in that range.');
  return lines.join('\n');
}
function formatChange(change: CodeChange): string {
  const head = change.kind === 'commit' ? `Commit ${change.id.slice(0, 7)}` : `Pull request ${change.id}${change.state ? ` (${change.state})` : ''}`;
  const lines = [`${head}: ${change.title}`, `${change.author}${change.date ? `, ${change.date}` : ''}. ${change.url}`,
    `${change.files.length} file(s), +${change.additions} -${change.deletions}${change.truncated ? '; cut to fit, ask for a single file with read_file if needed' : ''}.`];
  if (change.body) lines.push('', change.body);
  for (const file of change.files) {
    lines.push('', `${file.path} (${file.status}, +${file.additions} -${file.deletions})${file.patch ? '' : ' [no patch shown]'}`);
    if (file.patch) lines.push(file.patch);
  }
  return lines.join('\n');
}
function formatCiStatus(ci: CiStatus): string {
  const { target } = ci;
  const what = target.pr !== undefined ? `pull request #${target.pr} (branch ${target.branch ?? '?'}, head ${target.sha?.slice(0, 7)})`
    : target.sha ? `commit ${target.sha.slice(0, 7)}` : `branch ${target.branch}`;
  const lines = [`${ci.repository}, CI for ${what}, read live.`];
  if (!ci.runs.length) lines.push('No CI runs found for it.');
  else lines.push('', 'Runs (newest first):');
  const deployed = ci.deployment;
  // On a branch whose undeployed commits are all listed, every other commit of that branch is deployed.
  const listedAll = deployed?.undeployed && deployed.undeployed.length === deployed.notDeployed;
  const notLive = new Set(deployed?.undeployed?.map(commit => commit.sha));
  const where = (run: CiStatus['runs'][number]) => !deployed?.undeployed || run.branch !== target.branch ? ''
    : notLive.has(run.sha) ? ', not deployed' : listedAll || run.sha === deployed.sha ? ', deployed' : '';
  for (const run of ci.runs) {
    lines.push(`- ${run.workflow}: ${run.conclusion ?? run.status} on ${run.sha.slice(0, 7)}${run.title ? ` "${run.title}"` : ''}` +
      `${run.branch ? ` (${run.branch}${where(run)})` : ''}` +
      `${run.event ? `, ${run.event}` : ''}${run.startedAt ? `, started ${run.startedAt}` : ''} ${run.url}`);
    for (const job of run.failedJobs ?? []) lines.push(`  failed job: ${job.name}${job.step ? `, at step "${job.step}"` : ''} ${job.url}`);
  }
  if (!deployed) lines.push('', 'No deployment is recorded on GitHub, so what is deployed is unknown.');
  else {
    lines.push('', `Deployed: ${deployed.sha.slice(0, 7)} to ${deployed.environment} (${deployed.state}, ${deployed.createdAt})` +
      `${deployed.url ? ` ${deployed.url}` : ''}.`);
    if (deployed.includesTarget !== undefined) {
      lines.push(deployed.includesTarget ? `So ${what} is deployed: ${deployed.sha.slice(0, 7)} contains it.`
        : `So ${what} is not deployed yet: ${deployed.sha.slice(0, 7)} does not contain it.`);
    }
    if (deployed.notDeployed !== undefined) {
      lines.push(deployed.notDeployed ? `${deployed.notDeployed} commit(s) on ${target.branch} are not deployed yet.`
        : `The deployment is the head of ${target.branch}.`);
      if (deployed.undeployed?.length) {
        lines.push(`Not deployed yet (newest first${deployed.undeployed.length < deployed.notDeployed ? `, the latest ${deployed.undeployed.length}` : ''}):`,
          ...deployed.undeployed.map(commit => `- ${commit.sha.slice(0, 7)} ${commit.title}`),
          `A change in one of these is not deployed; a change in ${deployed.sha.slice(0, 7)} or an older commit on ${target.branch} is.`);
      }
    }
  }
  return lines.join('\n');
}
function formatEvidence(items: readonly Evidence[]): string {
  if (!items.length) return 'No matching code found. Try other words, a likely symbol name, or list_files.';
  return items.map((item, index) => `[${index + 1}] ${item.path}\n${item.url}\n${item.excerpt}`).join('\n---\n');
}

export function buildToolbox(context: ToolboxContext): { toolbox: AgentToolbox; report: ToolboxReport } {
  const report: ToolboxReport = { codeReferences: [], receipts: [], wroteSomething: false };
  const mayRead = context.policy.mayReadCode(context.actor);
  const mayWrite = context.policy.mayWriteTask(context.actor);
  // A limited write is refused before it is audited: only writes that were attempted are in the log.
  const audited = context.audit ? auditedPorts(context, context.audit) : context;
  const ports = context.limits ? limitedPorts(audited, context.limits, { actorId: context.actor.id, sessionId: context.sessionId }) : audited;
  const { code } = context;
  const { board, chat } = ports;
  let writes = 0;
  let taskIndex = 0;
  const specs: AgentToolSpec[] = [];
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<ToolOutcome>>();
  const writeTools = new Set<string>();
  const add = (spec: AgentToolSpec, handler: (input: Record<string, unknown>) => Promise<ToolOutcome>, write = false) => {
    specs.push(spec);
    handlers.set(spec.name, handler);
    if (write) writeTools.add(spec.name);
  };
  const remember = (items: readonly Evidence[]) => {
    for (const item of items) {
      if (!report.codeReferences.some(existing => existing.url === item.url)) report.codeReferences.push(item);
    }
  };

  if (mayRead) {
    add({ name: 'search_code', description: 'Search the team repository for code and docs. Returns the best matching files with excerpts and links. Use concrete words, function or file names. Search again with different words if the first results are not relevant.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Words, symbols or a short question.' } }, required: ['query'] } },
    async input => {
      const query = str(input.query, 500);
      if (!query) return { content: 'query is required', isError: true };
      const found = await code.findEvidence(query);
      context.recordAction?.('code_lookup');
      remember(found.slice(0, 1));
      return { content: formatEvidence(found) };
    });
    if (code.readFile) add({ name: 'read_file', description: 'Read a repository file (or a line range) to see exactly how something is implemented. Lines are numbered.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
    async input => {
      const path = str(input.path, 400);
      if (!path) return { content: 'path is required', isError: true };
      const file = await code.readFile!(path, int(input.start_line, 1, 1_000_000), int(input.end_line, 1, 1_000_000));
      if (!file) return { content: `No file named ${path}. Use list_files or search_code to find the right path.`, isError: true };
      context.recordAction?.('code_lookup');
      remember([{ path: file.path, url: file.url, excerpt: '' }]);
      return { content: `${file.path} (lines ${file.startLine}-${file.endLine} of ${file.totalLines})\n${file.url}\n${file.text}` };
    });
    if (code.listFiles) add({ name: 'list_files', description: 'List repository file paths, optionally under a folder prefix such as "src/adapters".',
      input_schema: { type: 'object', properties: { prefix: { type: 'string' } } } },
    async input => {
      const paths = await code.listFiles!(str(input.prefix, 300));
      return { content: paths.length ? paths.join('\n') : 'No files under that prefix.' };
    });
    if (code.recentCommits) add({ name: 'recent_commits', description: 'Recent commits (newest first), with messages and links. Omit branch to use the revision Nogita reads; pass a branch only if the person named one. Use for "what was the last push"; for a time range ("today", "this week") use repo_activity.',
      input_schema: { type: 'object', properties: { branch: { type: 'string' } } } },
    async input => {
      const commits = await code.recentCommits!(str(input.branch, 100));
      remember(commits.slice(0, 1));
      return { content: formatEvidence(commits) };
    });
    if (code.repoActivity) add({ name: 'repo_activity', description: 'Everything that landed on a branch in a time range, read live: all commits, merged pull requests with their descriptions, authors, and the files changed. Use for "what went in today", "what did we merge this week", "what did Dana push yesterday". Give period for the team\'s today, yesterday or week, or since/until as ISO times. Omit branch for the main branch.',
      input_schema: { type: 'object', properties: {
        period: { type: 'string', enum: [...TEAM_PERIODS] },
        since: { type: 'string', description: 'ISO time, when period does not fit.' },
        until: { type: 'string', description: 'ISO time; defaults to now.' },
        branch: { type: 'string' } } } },
    async input => {
      const period = TEAM_PERIODS.find(item => item === input.period) as TeamPeriod | undefined;
      const range = period ? teamPeriod(period, (context.now ?? Date.now)(), context.team ?? UTC_TEAM)
        : { since: str(input.since, 40), until: str(input.until, 40) };
      if (!range.since) return { content: `period (${TEAM_PERIODS.join(', ')}) or since is required`, isError: true };
      if (Number.isNaN(Date.parse(range.since)) || (range.until && Number.isNaN(Date.parse(range.until)))) {
        return { content: 'since and until must be ISO times, for example 2026-10-31T00:00:00+02:00', isError: true };
      }
      const activity = await code.repoActivity!({ since: range.since, until: range.until, branch: str(input.branch, 100) });
      context.recordAction?.('code_lookup');
      const pull = activity.mergedPullRequests[0];
      const commit = activity.commits[0];
      if (pull) remember([{ path: `PR #${pull.number}`, url: pull.url, excerpt: pull.title }]);
      else if (commit) remember([{ path: `commit ${commit.sha.slice(0, 7)}`, url: commit.url, excerpt: commit.title }]);
      return { content: formatActivity(activity) };
    });
    if (code.getChange) add({ name: 'get_change', description: 'One commit or pull request in detail: its description, the files it changed with +/- counts, and the diff (cut to fit). Use after repo_activity or recent_commits to see what a change actually did.',
      input_schema: { type: 'object', properties: { sha: { type: 'string', description: 'Commit sha (7-40 hex characters).' },
        pr: { type: 'integer', description: 'Pull request number.' } } } },
    async input => {
      const sha = str(input.sha, 40);
      const pr = int(input.pr, 1, 10_000_000);
      if (sha ? !/^[a-f0-9]{7,40}$/i.test(sha) : pr === undefined) return { content: 'give a commit sha (7-40 hex characters) or a pull request number', isError: true };
      const change = await code.getChange!(sha ? { sha } : { pr });
      if (!change) return { content: `No ${sha ? `commit ${sha}` : `pull request #${pr}`} in the repository.`, isError: true };
      context.recordAction?.('code_lookup');
      remember([{ path: change.kind === 'commit' ? `commit ${change.id.slice(0, 7)}` : `PR ${change.id}`, url: change.url, excerpt: change.title }]);
      return { content: formatChange(change) };
    });
    if (code.ciStatus && context.ciStatus) add({ name: 'ci_status', description: 'CI runs for a branch, commit or pull request, read live: the result of each workflow, the jobs and steps that failed with links, and which commit is deployed (and how many commits are not deployed yet). Use for "did CI pass on main?", "why is the build red?", "is the fix deployed?". For "is X deployed?", find the pull request or commit of X in the same round (repo_activity for the last days lists merged pull requests; recent_commits only the latest few), then check it against the commits listed as not deployed: never guess which commit it is. Give one of branch, sha or pr; none means the main branch.',
      input_schema: { type: 'object', properties: { branch: { type: 'string' },
        sha: { type: 'string', description: 'Commit sha (7-40 hex characters).' },
        pr: { type: 'integer', description: 'Pull request number.' } } } },
    async input => {
      const sha = str(input.sha, 40);
      const pr = int(input.pr, 1, 10_000_000);
      const branch = str(input.branch, 100);
      if (sha && !/^[a-f0-9]{7,40}$/i.test(sha)) return { content: 'sha must be 7-40 hex characters', isError: true };
      if (input.pr !== undefined && pr === undefined) return { content: 'pr must be a pull request number', isError: true };
      const ci = await code.ciStatus!(pr !== undefined ? { pr } : sha ? { sha } : { branch });
      if (!ci) return { content: `No ${pr !== undefined ? `pull request #${pr}` : `commit ${sha}`} in the repository.`, isError: true };
      context.recordAction?.('code_lookup');
      const run = ci.runs[0];
      if (run) remember([{ path: `CI ${run.workflow} ${run.conclusion ?? run.status}`, url: run.url, excerpt: run.sha.slice(0, 7) }]);
      return { content: formatCiStatus(ci) };
    });
    if (board.searchTasks) add({ name: 'search_tasks', description: `Search ${board.name} tasks by words, status and owner (all optional; none lists the latest).${board.queryLanguage === 'jql' ? ' For what those cannot say, jql takes a Jira condition (the project filter is added for you).' : ''}`,
      input_schema: { type: 'object', properties: { ...taskFilterSchema(board), limit: { type: 'integer' } } } },
    async input => {
      const filter = await taskFilter(input, context);
      if ('problem' in filter) return { content: filter.problem, isError: true };
      const tasks = await board.searchTasks!({ ...filter, limit: int(input.limit, 1, 30) });
      if (!tasks.length) return { content: 'No matching tasks.' };
      return { content: tasks.map(task => `${task.key} [${task.status ?? '?'}] ${task.title}` +
        `${task.assignee ? ` (assignee: ${task.assignee})` : ' (unassigned)'}${task.updated ? `, updated ${task.updated}` : ''} ${task.url}`).join('\n') };
    });
    if (board.getTask) add({ name: 'get_task', description: 'Read one task by key (for example KAN-12): status, assignee, description and recent comments.',
      input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
    async input => {
      const key = str(input.key, 40)?.toUpperCase();
      if (!key || !/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return { content: 'key must look like ABC-123', isError: true };
      const task = await board.getTask!(key);
      if (!task) return { content: `${key} was not found or is outside the configured project.`, isError: true };
      return { content: [`${task.key}: ${task.title}`, `Status: ${task.status ?? 'unknown'}`, `Assignee: ${task.assignee ?? 'unassigned'}`,
        task.type && `Type: ${task.type}`, task.priority && `Priority: ${task.priority}`, task.reporter && `Reporter: ${task.reporter}`,
        task.created && `Created: ${task.created}`, task.updated && `Updated: ${task.updated}`, `Link: ${task.url}`,
        `Description:\n${task.description || '(empty)'}`,
        task.comments.length ? `Recent comments:\n${task.comments.map(c => `- ${c.author ?? 'someone'}${c.created ? ` (${c.created})` : ''}: ${c.text}`).join('\n')}` : '',
      ].filter(Boolean).join('\n') };
    });
    if (context.show && (board.getTask || board.searchTasks || code.readFile)) add({ name: 'show_on_screen',
      description: 'Put something on your shared screen in the meeting, only when someone asks you to show, share or put it on screen: ' +
        'one task (key), a list of tasks (the same filters as search_tasks), or lines of a file (path, start_line, end_line). what="nothing" clears the screen. ' +
        'Then say briefly that it is on the screen and give the one or two points that matter; do not read it all out.',
      input_schema: { type: 'object', properties: { what: { type: 'string', enum: ['task', 'tasks', 'file', 'nothing'] },
        key: { type: 'string' }, ...taskFilterSchema(board), title: { type: 'string', description: 'Heading for a task list.' },
        path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['what'] } },
    async input => {
      const show = context.show!;
      if (input.what === 'nothing') { show(undefined); return { content: 'The screen is back to your presence view.' }; }
      // The screen is seen by everyone in the call, not only by the person who asked.
      const unverified = context.screenAudience?.()?.unverified ?? 0;
      if (unverified > 0) {
        return { content: `Nothing was shown: ${unverified} participant${unverified === 1 ? ' is' : 's are'} not a verified team member, so private tasks and code stay off the shared screen. Tell them briefly; the link can go in chat if they want.`, isError: true };
      }
      if (input.what === 'task' && board.getTask) {
        const key = str(input.key, 40)?.toUpperCase();
        if (!key || !/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return { content: 'key must look like ABC-123', isError: true };
        const task = await board.getTask(key);
        if (!task) return { content: `${key} was not found or is outside the configured project.`, isError: true };
        show({ kind: 'task', key: task.key, title: task.title, status: task.status, assignee: task.assignee, type: task.type,
          priority: task.priority, description: task.description.slice(0, 1_200), url: task.url });
        return { content: `On screen: ${task.key} ${task.title} [${task.status ?? '?'}], ${task.assignee ?? 'unassigned'}.` };
      }
      if (input.what === 'tasks' && board.searchTasks) {
        const filter = await taskFilter(input, context);
        if ('problem' in filter) return { content: filter.problem, isError: true };
        const tasks = await board.searchTasks({ ...filter, limit: 8 });
        if (!tasks.length) return { content: 'No matching tasks; nothing was shown.' };
        show({ kind: 'tasks', title: str(input.title, 80) ?? `${board.name} tasks`,
          items: tasks.map(task => ({ key: task.key, title: task.title, status: task.status, assignee: task.assignee })) });
        return { content: `On screen: ${tasks.map(task => `${task.key} [${task.status ?? '?'}] ${task.title}`).join('; ')}` };
      }
      if (input.what === 'file' && code.readFile) {
        const path = str(input.path, 400);
        if (!path) return { content: 'path is required', isError: true };
        const start = int(input.start_line, 1, 1_000_000);
        const file = await code.readFile(path, start, int(input.end_line, 1, 1_000_000) ?? (start ?? 1) + 21);
        if (!file) return { content: `No file named ${path}. Use list_files or search_code to find the right path.`, isError: true };
        const numbered = file.text.split('\n').slice(0, 24);
        const lines = numbered.map(line => line.replace(/^\d+: ?/, ''));
        show({ kind: 'code', path: file.path, startLine: file.startLine, lines, url: file.url });
        return { content: `On screen: ${file.path} lines ${file.startLine}-${file.startLine + lines.length - 1}:\n${numbered.join('\n')}` };
      }
      return { content: 'That cannot be shown here.', isError: true };
    });
    if (chat) {
      add({ name: 'list_channels', description: `List the ${chat.name} channels Nogita can read and post in.`,
        input_schema: { type: 'object', properties: {} } },
      async () => {
        const channels = await chat.listChannels();
        return { content: channels.length ? channels.map(c => `#${c.name} (${c.id})`).join('\n') : 'Nogita is not a member of any channel.' };
      });
      add({ name: 'read_channel', description: `Read the most recent messages in a ${chat.name} channel Nogita is a member of.`,
        input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel name like #dev or an ID.' }, limit: { type: 'integer' } }, required: ['channel'] } },
      async input => {
        const channel = str(input.channel, 100);
        if (!channel) return { content: 'channel is required', isError: true };
        const messages = await chat.readChannel(channel, int(input.limit, 1, 50) ?? 20);
        return { content: messages.length ? messages.map(m => `[${m.at}] ${m.author}: ${m.text}`).join('\n') : 'No recent messages.' };
      });
      if (chat.searchMessages) add({ name: 'search_messages', description: `Search ${chat.name} messages across channels.`,
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      async input => {
        const query = str(input.query, 300);
        if (!query) return { content: 'query is required', isError: true };
        const messages = await chat.searchMessages!(query, 15);
        return { content: messages.length ? messages.map(m => `[${m.at}] #${m.channel} ${m.author}: ${m.text}${m.url ? ` ${m.url}` : ''}`).join('\n') : 'No matching messages.' };
      });
    }
  }

  if (mayWrite) {
    /** One task: resolves its owner and writes it under an index-based key. Permission and the write cap are the caller's. */
    const createOne = async (input: Record<string, unknown>): Promise<ItemOutcome> => {
      const title = str(input.title, 200);
      const description = str(input.description, 4000) ?? '';
      if (!title) return { content: 'title is required (at most 200 characters)', isError: true };
      let assigneeId: string | undefined;
      let assigneeName: string | undefined;
      let volunteered = false;
      let unassignedBecause: string | undefined;
      const target = board.boards ? str(input.board, 40) : undefined;
      const wanted = str(input.assignee, 100);
      const lines = context.transcript?.() ?? [];
      if (wanted) {
        const resolved = await resolveAssignee(wanted, context, target);
        // "Open one for me" from someone the board does not know: the task matters more than its owner (the voice
        // lab saw her give up on the whole request instead).
        if ('problem' in resolved && isSpeaker(wanted)) unassignedBecause = resolved.problem;
        else if ('problem' in resolved) return { content: `Not created: ${resolved.problem}`, isError: true };
        else { assigneeId = resolved.id; assigneeName = resolved.displayName; }
      } else if (taskIndex === 0) {
        // Someone already said "I'll take it": they own it, if the board knows exactly one person by that name.
        const volunteer = findVolunteer(lines);
        const resolved = volunteer ? await resolveAssignee(volunteer, context, target).catch(() => undefined) : undefined;
        if (resolved && !('problem' in resolved)) { assigneeId = resolved.id; assigneeName = resolved.displayName; volunteered = true; }
      }
      const fullDescription = withMeetingQuotes(description, lines);
      // Index-based so a retried event maps its n-th task to the same Jira issue even if wording changes.
      const requestId = `${context.sessionId}:${context.eventId}:task:${++taskIndex}`;
      let receipt = context.completed.get(requestId);
      const fresh = !receipt;
      if (!receipt) {
        receipt = await board.createTask({ title, description: fullDescription, assigneeId, requestId, ...(target ? { board: target } : {}) });
        context.completed.set(requestId, receipt);
        context.recordAction?.('create_task');
        report.receipts.push(receipt);
        report.wroteSomething = true;
      }
      return { receipt, fresh, content: `Created ${receipt.label}${assigneeName ? `, assigned to ${assigneeName}${volunteered ? ', who said they would take it' : ''}` : ', unassigned'}${unassignedBecause ? ` (${unassignedBecause} Tell them it is unassigned.)` : ''}: ${receipt.url}` };
    };
    /** Which of status, owner and comment the updates would change although the request did not ask for it. */
    const unaskedChanges = (updates: ReadonlyArray<Record<string, unknown>>): string[] => {
      if (context.writesApproved) return [];
      const asked = requestedTaskChanges(context.request);
      const has = (field: string, max: number) => updates.some(update => str(update[field], max) !== undefined);
      return [has('status', 60) && !asked.status && 'a status change', has('assignee', 100) && !asked.assignee && 'a new owner',
        has('comment', 3000) && !asked.comment && 'a comment'].filter((item): item is string => Boolean(item));
    };
    /** One change to an existing task, keyed by its content. Permission and the write cap are the caller's. */
    const updateOne = async (input: Record<string, unknown>): Promise<ItemOutcome> => {
      const key = str(input.key, 40)?.toUpperCase();
      if (!key || !/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return { content: 'key must look like ABC-123', isError: true };
      const status = str(input.status, 60);
      const comment = str(input.comment, 3000);
      const wanted = str(input.assignee, 100);
      if (!status && !comment && !wanted) return { content: `Nothing to change on ${key}: give a status, an assignee or a comment.`, isError: true };
      let assigneeId: string | undefined;
      let assigneeName: string | undefined;
      if (wanted) {
        const resolved = await resolveAssignee(wanted, context);
        if ('problem' in resolved) return { content: `Not changed: ${resolved.problem}`, isError: true };
        assigneeId = resolved.id;
        assigneeName = resolved.displayName;
      }
      const requestId = `${context.sessionId}:${context.eventId}:update:${key}:${status ?? ''}:${assigneeId ?? ''}:${comment ?? ''}`;
      let receipt = context.completed.get(requestId);
      const fresh = !receipt;
      if (!receipt) {
        receipt = await board.updateTask!({ key, status, assigneeId, comment, requestId });
        context.completed.set(requestId, receipt);
        context.recordAction?.('update_task');
        report.receipts.push(receipt);
        report.wroteSomething = true;
      }
      const done = [status && `moved to ${status}`, assigneeName && `assigned to ${assigneeName}`, comment && 'commented'].filter(Boolean).join(', ');
      return { receipt, fresh, content: `${receipt.label} ${done}: ${receipt.url}` };
    };
    /** Writes the items one after another; a failed item never stops the rest. One chat receipt for all that was written. */
    const runBatch = async (list: ReadonlyArray<Record<string, unknown>>, one: (item: Record<string, unknown>) => Promise<ItemOutcome>,
      verb: string): Promise<ToolOutcome> => {
      const outcomes: ItemOutcome[] = [];
      for (const item of list) {
        outcomes.push(await one(item).catch(error => ({ content: `Not ${verb}: ${error instanceof Error ? error.message : String(error)}`, isError: true })));
      }
      const fresh = outcomes.flatMap(outcome => outcome.fresh && outcome.receipt ? [outcome.receipt] : []);
      if (fresh.length) await context.onReceipt(combineReceipts(fresh)).catch(() => undefined);
      const succeeded = outcomes.filter(outcome => !outcome.isError).length;
      const summary = `${succeeded} of ${list.length} ${verb}.${succeeded ? ' The links are already in the chat.' : ''}` +
        (succeeded < list.length ? ' Say which ones were not, and why.' : '');
      return { content: [...outcomes.map((outcome, index) => `${index + 1}. ${outcome.content}`), summary].join('\n'),
        ...(succeeded ? {} : { isError: true }) };
    };
    const batchItems = (value: unknown): Array<Record<string, unknown>> | string => {
      if (!Array.isArray(value) || !value.length) return 'give at least one item';
      if (value.length > MAX_BATCH_ITEMS) return `at most ${MAX_BATCH_ITEMS} items in one call; nothing was written`;
      if (value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return 'each item must be an object';
      return value as Array<Record<string, unknown>>;
    };
    const boardProperty = board.boards ? { board: { type: 'string', enum: board.boards.map(item => item.id),
      description: `Only if they named one: ${board.boards.map(item => item.name).join(', ')}. The first is the default.` } } : {};

    add({ name: 'create_task', description: `Create a ${board.name} task. Only when the person explicitly asked you to create/open/log a task. Write a clear title and a description that captures what was discussed (who asked, why, acceptance details). If they named an owner, pass it as assignee (a person's name, or "me" for the speaker); never guess an owner.`,
      input_schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, assignee: { type: 'string' },
        ...boardProperty }, required: ['title', 'description'] } },
    async input => {
      if (!context.writesApproved && !requestsTaskWrite(context.request)) {
        return { content: 'Not created: the request does not explicitly ask to create a task. Ask the person to confirm with a direct request.', isError: true };
      }
      if (writes >= MAX_WRITES_PER_TURN) return { content: 'Not created: too many writes in one request.', isError: true };
      const outcome = await createOne(input);
      if (outcome.isError) return { content: outcome.content, isError: true };
      writes++;
      if (outcome.fresh) await context.onReceipt(outcome.receipt!).catch(() => undefined);
      return { content: `${outcome.content}. The link is already in the chat.` };
    }, true);
    if (context.batchTasks) add({ name: 'create_tasks', description: `Create several ${board.name} tasks in one call (up to ${MAX_BATCH_ITEMS}), one item per task the person asked for; use it whenever they asked for more than one. Only when they explicitly asked to create/open/log tasks. Each item: a clear title, a description of what was discussed, and an assignee only if they named an owner for that task (a name, or "me"); never guess an owner.`,
      input_schema: { type: 'object', properties: { tasks: { type: 'array', maxItems: MAX_BATCH_ITEMS, items: { type: 'object',
        properties: { title: { type: 'string' }, description: { type: 'string' }, assignee: { type: 'string' }, ...boardProperty },
        required: ['title', 'description'] } } }, required: ['tasks'] } },
    async input => {
      if (!context.writesApproved && !requestsTaskWrite(context.request)) {
        return { content: 'Not created: the request does not explicitly ask to create tasks. Ask the person to confirm with a direct request.', isError: true };
      }
      const list = batchItems(input.tasks);
      if (typeof list === 'string') return { content: `tasks: ${list}`, isError: true };
      if (writes >= MAX_WRITES_PER_TURN) return { content: 'Not created: too many writes in one request.', isError: true };
      writes++;
      return runBatch(list, createOne, 'created');
    }, true);
    if (board.updateTask) add({ name: 'update_task', description: `Change an existing ${board.name} task: move it to a status, assign it to someone, and/or add a comment. Only the changes the person explicitly asked for in this request. Use the key they named or the task just discussed; if unclear which task, ask.`,
      input_schema: { type: 'object', properties: { key: { type: 'string', description: 'Task key such as KAN-12.' },
        status: { type: 'string', description: 'Target status as they said it ("In Progress", "Done").' },
        assignee: { type: 'string', description: 'New owner: a name, or "me" for the speaker.' },
        comment: { type: 'string', description: 'Comment text, ready to post.' } }, required: ['key'] } },
    async input => {
      const key = str(input.key, 40)?.toUpperCase();
      if (!key || !/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return { content: 'key must look like ABC-123', isError: true };
      if (!str(input.status, 60) && !str(input.comment, 3000) && !str(input.assignee, 100)) return { content: 'Nothing to change: give a status, an assignee or a comment.', isError: true };
      const extra = unaskedChanges([input]);
      if (extra.length) return { content: `Not changed: the request does not explicitly ask for ${extra.join(' or ')}. Ask the person to confirm with a direct request.`, isError: true };
      if (writes >= MAX_WRITES_PER_TURN) return { content: 'Not changed: too many writes in one request.', isError: true };
      const outcome = await updateOne(input);
      if (outcome.isError) return { content: outcome.content, isError: true };
      writes++;
      if (outcome.fresh) await context.onReceipt(outcome.receipt!).catch(() => undefined);
      return { content: `${outcome.content}. The link is already in the chat.` };
    }, true);
    if (board.updateTask && context.batchTasks) add({ name: 'update_tasks', description: `Change several existing ${board.name} tasks in one call (up to ${MAX_BATCH_ITEMS}): per item a key and only the changes the person explicitly asked for (status, assignee, comment). Use it whenever they asked to change more than one task.`,
      input_schema: { type: 'object', properties: { updates: { type: 'array', maxItems: MAX_BATCH_ITEMS, items: { type: 'object',
        properties: { key: { type: 'string', description: 'Task key such as KAN-12.' }, status: { type: 'string' },
          assignee: { type: 'string', description: 'A name, or "me" for the speaker.' }, comment: { type: 'string' } },
        required: ['key'] } } }, required: ['updates'] } },
    async input => {
      const list = batchItems(input.updates);
      if (typeof list === 'string') return { content: `updates: ${list}`, isError: true };
      const extra = unaskedChanges(list);
      if (extra.length) return { content: `Nothing changed: the request does not explicitly ask for ${extra.join(' or ')}. Ask the person to confirm with a direct request.`, isError: true };
      if (writes >= MAX_WRITES_PER_TURN) return { content: 'Not changed: too many writes in one request.', isError: true };
      writes++;
      return runBatch(list, updateOne, 'changed');
    }, true);
    if (chat) add({ name: 'post_message', description: `Post a message to a ${chat.name} channel. Only when the person explicitly asked you to post/send/share something there. Write the message itself, ready to send.`,
      input_schema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } },
    async input => {
      if (!context.writesApproved && !requestsChatPost(context.request)) {
        return { content: 'Not posted: the request does not explicitly ask to send a message. Ask the person to confirm with a direct request.', isError: true };
      }
      if (writes >= MAX_WRITES_PER_TURN) return { content: 'Not posted: too many writes in one request.', isError: true };
      const channel = str(input.channel, 100);
      const text = str(input.text, 3000);
      if (!channel || !text) return { content: 'channel and text are required', isError: true };
      writes++;
      const requestId = `${context.sessionId}:${context.eventId}:post:${channel}:${text}`;
      let receipt = context.completed.get(requestId);
      if (!receipt) {
        receipt = await chat.postMessage(channel, text);
        context.completed.set(requestId, receipt);
        report.receipts.push(receipt);
        report.wroteSomething = true;
        await context.onReceipt(receipt).catch(() => undefined);
      }
      return { content: `Posted to ${receipt.label}: ${receipt.url}` };
    }, true);
  }

  if (context.drafts && context.policy.mayDraftPR(context.actor)) {
    const drafts = ports.drafts ?? context.drafts;
    let prIndex = 0;
    add({ name: 'open_draft_pr', description: `Open a draft pull request on ${drafts.name}: a new branch with a note describing the change, for a developer to build on. Only when the person explicitly asked for a PR or pull request in this request. You do not write the code. Title it like a commit; in the description say what should change, why, where in the code (files you found), and how to know it works, from the conversation.`,
      input_schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' } }, required: ['title', 'description'] } },
    async input => {
      if (!context.writesApproved && !isExplicitPRRequest(context.request)) {
        return { content: 'Not opened: the request does not explicitly ask for a pull request. Ask the person to confirm with a direct request.', isError: true };
      }
      if (writes >= MAX_WRITES_PER_TURN) return { content: 'Not opened: too many writes in one request.', isError: true };
      const title = str(input.title, 200);
      const description = str(input.description, 6000);
      if (!title || !description) return { content: 'title and description are required', isError: true };
      writes++;
      const requestId = `${context.sessionId}:${context.eventId}:pr:${++prIndex}`;
      let receipt = context.completed.get(requestId);
      if (!receipt) {
        receipt = await drafts.openDraft({ title, description, requestId });
        context.completed.set(requestId, receipt);
        context.recordAction?.('draft_pr');
        report.receipts.push(receipt);
        report.wroteSomething = true;
        await context.onReceipt(receipt).catch(() => undefined);
      }
      return { content: `Opened ${receipt.label} as a draft: ${receipt.url}. It holds a note, not code; the link is already in the chat.` };
    }, true);
  }

  if (mayRead && context.missions) {
    const missions = context.missions;
    add({ name: 'delegate_mission', description: 'Start a mission when someone hands you work to own rather than a question to answer ("take care of KAN-20", "figure out what is blocking X and move it forward", "handle this"). It runs in the background, survives the meeting, and asks its owner before changing anything. After starting it, say one short line ("On it. I\x27ll check what\x27s blocking it."); do not do the work in this reply.',
      input_schema: { type: 'object', properties: { goal: { type: 'string', description: 'The outcome they want, with the task keys, people and context from the conversation.' },
        done_when: { type: 'string', description: 'What done means, if they said or it is clear.' } }, required: ['goal'] } },
    async input => {
      const goal = str(input.goal, 1_000);
      if (!goal) return { content: 'goal is required', isError: true };
      const mission = await missions.start(goal, str(input.done_when, 600));
      return { content: `Mission ${mission.id} started; it is working in the background. Acknowledge in one short sentence.` };
    });
    add({ name: 'missions_status', description: 'What your delegated missions are doing now: status, current activity, the latest finding, an action waiting for approval, or the result. Use for "how is KAN-20 going", "what are you working on".',
      input_schema: { type: 'object', properties: {} } },
    async () => {
      const list = missions.list();
      if (!list.length) return { content: 'No missions.' };
      return { content: list.map(m => `${m.id} [${m.status}] ${m.goal} (owner ${m.owner})` +
        (m.activity ? `; now: ${m.activity}` : '') + (m.lastFinding ? `; found: ${m.lastFinding}` : '') +
        (m.pending ? `; waiting for approval to ${m.pending}` : '') + (m.result ? `; result: ${m.result}` : '')).join('\n') };
    });
    if (context.missionStatus && missions.report) {
      const missionReport = missions.report.bind(missions);
      const recent = missions.recent?.bind(missions);
      const now = context.now ?? Date.now;
      add({ name: 'mission_status', description: 'What is left of a request you are working on in the background: what was done, what failed, what is still running or waiting for approval, with the sources it rests on, and what you did directly in the turn for a recent request. Use for "what\x27s left from what I asked?", "did all of it get done?", "what happened with the tasks I asked for?". Leave mission_id out for their latest one. Answer from this result only; say what failed and what is still open first.',
        input_schema: { type: 'object', properties: { mission_id: { type: 'string' } } } },
      async input => {
        const id = str(input.mission_id, 30)?.toUpperCase();
        const found = missionReport(id);
        const section = (title: string, items: string[]) => items.length ? [`${title}:`, ...items.map(item => `- ${item}`)] : [];
        // A request handled in the turn itself left no mission; without these "what's left?" found nothing for it.
        const direct = id ? [] : (recent?.() ?? []).slice(0, 3).flatMap(item => [
          `Asked directly ${Math.max(1, Math.round((now() - item.at) / 60_000))} min ago and handled in that turn: "${item.request}"`,
          ...section('Done', item.done), ...section('Not done', item.failed),
          ...(item.done.length || item.failed.length ? [] : ['Nothing was changed.'])]);
        if (!found && !direct.length) {
          return { content: id ? `No mission ${id} of yours.` : 'You have no mission I am working on or finished lately.' };
        }
        const content = (found ? [`${found.id} [${found.status}] ${found.goal}`,
          ...section('Done', found.done), ...section('Failed', found.failed), ...section('Still open', found.open),
          ...(found.done.length || found.failed.length || found.open.length ? [] : ['Nothing done or failed yet.']),
          ...section('Found', found.findings),
          ...section('Sources', found.sources.map(source => `${source.label}${source.title ? ` (${source.title.slice(0, 80)})` : ''}${source.url ? `: ${source.url}` : ''}`)),
          ...direct] : direct).join('\n');
        if (!context.postDetails) return { content };
        // Read out in full this ran long; the whole report goes to chat and the spoken reply is the gist.
        const posted = await context.postDetails(content).then(() => true, () => false);
        return { content: `${content}\n\n${posted ? 'This full report is now in the meeting chat. ' : ''}` +
          'Answer aloud in one or two short sentences: what failed or is still open first, then whether the rest is done. No lists, links or sources.' };
      });
    }
    add({ name: 'decide_mission', description: 'The mission owner approves or declines the action a mission is waiting on, resumes a blocked mission (with their guidance as note), or cancels one, including an approval asked in an earlier meeting or chat. Only when they clearly said so. mission_id may be left out when only one mission fits.',
      input_schema: { type: 'object', properties: { decision: { type: 'string', enum: ['approve', 'decline', 'resume', 'cancel'] },
        mission_id: { type: 'string' }, note: { type: 'string' } }, required: ['decision'] } },
    async input => {
      const decision = input.decision;
      if (decision !== 'approve' && decision !== 'decline' && decision !== 'resume' && decision !== 'cancel') return { content: 'decision must be approve, decline, resume or cancel', isError: true };
      const result = await missions.decide(decision, str(input.mission_id, 30)?.toUpperCase(), str(input.note, 600));
      return { content: result.message, ...(result.ok ? {} : { isError: true }) };
    });
  }

  if (mayRead && context.memory) {
    const memory = context.memory;
    add({ name: 'past_decisions', description: 'Decisions and action items from earlier meetings (only what people said plainly, with dates). Use for "what did we decide last week about X", "who was supposed to do Y". Pass the topic words; empty lists the latest meetings.',
      input_schema: { type: 'object', properties: { topic: { type: 'string' } } } },
    async input => {
      const records = await memory.search(str(input.topic, 200) ?? '', 5);
      if (!records.length) return { content: 'Nothing about that in the remembered meetings.' };
      return { content: records.map(record => [`Meeting ended ${record.endedAt.slice(0, 16).replace('T', ' ')} UTC:`,
        ...record.decisions.map(item => `- decided: ${item.text} (${item.speaker})`),
        ...record.actionItems.map(item => `- to do: ${item.text} (${item.owner ? `owner ${item.owner}` : 'nobody took it'})`)].join('\n')).join('\n\n') };
    });
  }

  if (mayRead && context.actionItems) {
    const items = context.actionItems;
    add({ name: 'meeting_action_items', description: 'The action items said in this meeting so far ("we need to...", "someone should...", "I\x27ll update the docs") and who took each one, or that nobody did. Use for "what did we agree to do", "what\x27s still open", "who\x27s doing what". Then say the ones nobody took first.',
      input_schema: { type: 'object', properties: {} } },
    async () => {
      const list = items();
      if (!list.length) return { content: 'No action items were said in this meeting yet.' };
      return { content: list.map(item => `- ${item.text} (raised by ${item.speaker}; ${item.owner ? `owner: ${item.owner}` : 'NOBODY took it yet'})`).join('\n') };
    });
  }

  if (context.leave) {
    const leave = context.leave;
    add({ name: 'leave_meeting', description: 'Leave the meeting. Use it whenever they tell you to go, in any words ("you can go", "bye Nogita", "we\x27re done, drop off", "that\x27s all, thanks, you can leave"). Not for a question about leaving or "don\x27t leave". Say a short, warm goodbye in the same reply ("Sure, bye everyone."), nothing more.',
      input_schema: { type: 'object', properties: {} } },
    async () => {
      if (!LEAVE_WORDS.test(context.request)) return { content: 'Nobody asked you to leave in this request. Stay.', isError: true };
      leave();
      return { content: 'You will leave as soon as this reply is spoken. Say only a short goodbye.' };
    });
  }

  return {
    report,
    toolbox: {
      specs,
      isWrite: name => writeTools.has(name),
      async run(name, input) {
        const handler = handlers.get(name);
        if (!handler) return { content: `Unknown or unavailable tool: ${name}`, isError: true };
        return handler(input);
      },
    },
  };
}

/** One item of a write: the text for the agent, and the receipt when it was written (fresh unless a retry found it). */
type ItemOutcome = ToolOutcome & { receipt?: ActionReceipt; fresh?: boolean };

/** One chat line for several writes: "MEM-1, MEM-2 and MEM-3" with every link. */
export function combineReceipts(receipts: readonly ActionReceipt[]): ActionReceipt {
  if (receipts.length === 1) return receipts[0]!;
  const labels = receipts.map(receipt => receipt.label);
  return { provider: receipts[0]!.provider, kind: receipts[0]!.kind,
    label: `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`, url: receipts.map(receipt => receipt.url).join(' ') };
}

/** The search filters the agent may use; jql only where the board understands it, board only with several boards. */
function taskFilterSchema(board: BoardPort): Record<string, unknown> {
  return {
    text: { type: 'string', description: 'Words in the title or description.' },
    status: { type: 'string', description: 'A status as people say it, such as "In Progress" or "Done".' },
    assignee: { type: 'string', description: 'Whose tasks: a name, or "me" for the speaker.' },
    unassigned: { type: 'boolean', description: 'Only tasks nobody owns.' },
    ...(board.boards ? { board: { type: 'string', enum: board.boards.map(item => item.id), description: 'Only this board; all when absent.' } } : {}),
    ...(board.queryLanguage === 'jql' ? { jql: { type: 'string', description: 'Jira only: a JQL condition, for what the fields above cannot say.' } } : {}),
  };
}

async function taskFilter(input: Record<string, unknown>, context: ToolboxContext): Promise<TaskSearch | { problem: string }> {
  const boardId = context.board.boards ? str(input.board, 40) : undefined;
  const filter: TaskSearch = { text: str(input.text, 300), status: str(input.status, 60), ...(input.unassigned === true ? { unassigned: true } : {}),
    ...(boardId ? { board: boardId } : {}), ...(context.board.queryLanguage === 'jql' ? { jql: str(input.jql, 600) } : {}) };
  const who = input.unassigned === true ? undefined : str(input.assignee, 100);
  if (who) {
    const resolved = await resolveAssignee(who, context, boardId);
    if ('problem' in resolved) return { problem: `Not searched: ${resolved.problem}` };
    filter.assigneeId = resolved.id;
  }
  return filter;
}

function isSpeaker(name: string): boolean { return /^(?:me|myself|i)$/i.test(name.trim()); }

async function resolveAssignee(name: string, context: ToolboxContext, board?: string):
  Promise<{ id: string; displayName: string } | { problem: string }> {
  if (isSpeaker(name)) {
    const display = context.people?.displayNameFor(context.actor.id);
    if (!display) return { problem: 'I do not have a board account mapped for the speaker.' };
    return { id: context.actor.id, displayName: display };
  }
  const known = context.people?.findByName(name) ?? [];
  if (known.length === 1) return known[0]!;
  if (known.length > 1) {
    return { problem: `more than one person matches "${name}": ${known.map(p => p.displayName).join(', ')}. Ask which one.` };
  }
  if (context.board.findAssignees) {
    const found = await context.board.findAssignees(name, board);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) {
      return { problem: `more than one person matches "${name}": ${found.slice(0, 5).map(p => p.displayName).join(', ')}. Ask which one.` };
    }
  }
  return { problem: `I could not find anyone named "${name}" who can be assigned on ${context.board.name}. Ask who should own it, or create it unassigned if they agree.` };
}
