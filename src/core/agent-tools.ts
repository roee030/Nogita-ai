import type { ActionReceipt, Actor, BoardPort, ChatPort, CodePort, Evidence, ExternalAction, MeetingMemoryPort, PolicyPort, PullRequestPort, ScreenCard, TaskSearch } from './contracts.ts';
import { isExplicitPRRequest } from './policy.ts';
import { findVolunteer, withMeetingQuotes, type ActionItem } from './drafting.ts';
import type { AgentToolbox, AgentToolSpec, ToolOutcome } from './agent.ts';

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
}

/** Leaving needs words that ask for it in the request itself, never only in something she read. */
const LEAVE_WORDS = /\b(?:leave|leaving|go|bye|goodbye|drop|exit|disconnect|hang up|sign off|log off|get off|get out|head out|end (?:the|this) (?:call|meeting)|done)\b/i;

/** What a conversation may do with missions, already bound to the person speaking. */
export interface MissionPort {
  start(goal: string, doneWhen?: string): Promise<{ id: string }>;
  list(): Array<{ id: string; goal: string; status: string; activity?: string; pending?: string; lastFinding?: string; result?: string; owner: string }>;
  decide(decision: 'approve' | 'decline' | 'resume' | 'cancel', id?: string, note?: string): Promise<{ ok: boolean; message: string }>;
}

/** Things the engine needs after the turn: the best source link and the receipts that were posted. */
export interface ToolboxReport {
  codeReferences: Evidence[];
  receipts: ActionReceipt[];
  wroteSomething: boolean;
}

const MAX_WRITES_PER_TURN = 5;

/** A question about existing things ("what are the open issues?") is not a command, unless it is a polite request. */
function isInformationQuestion(t: string): boolean {
  const lead = t.replace(/^(?:(?:hey|hi|ok|okay|so|and|also|nogita)[,\s]+)+/, '');
  if (/^(?:can|could|would|will) you\b|^please\b/.test(lead)) return false;
  return /^(?:what|what's|whats|which|who|whom|when|where|why|how|did|does|do|is|are|was|were|has|have|any)\b/.test(lead);
}
const TASK_NOUN = String.raw`(?:task|tasks|ticket|tickets|issue|issues|bug|bugs|story|stories|card|cards|todo|to-do)`;

/** A direct request to make a ticket. Wider than the legacy planner check, still deterministic. */
export function requestsTaskWrite(request: string): boolean {
  const t = request.toLowerCase().replace(/\s+/g, ' ').trim();
  if (isInformationQuestion(t)) return false;
  if (/\b(?:pr|pull request)\b/.test(t) && !new RegExp(`\\b${TASK_NOUN}\\b`).test(t)) return false;
  // "open" right before a plural noun after a determiner is an adjective: "the open issues", "any open tasks".
  const cleaned = t.replace(/\b(?:the|any|all|our|their|my|your|which|what|many|more|of|are|is|for|with)\s+open\s+(?:tasks|tickets|issues|bugs|stories|items)\b/g, '');
  return new RegExp(`\\b(?:create|open|add|file|make|log|raise|write up|new)\\s+(?:[\\w'-]+\\s+){0,5}?${TASK_NOUN}\\b`).test(cleaned) ||
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
function formatEvidence(items: readonly Evidence[]): string {
  if (!items.length) return 'No matching code found. Try other words, a likely symbol name, or list_files.';
  return items.map((item, index) => `[${index + 1}] ${item.path}\n${item.url}\n${item.excerpt}`).join('\n---\n');
}

export function buildToolbox(context: ToolboxContext): { toolbox: AgentToolbox; report: ToolboxReport } {
  const report: ToolboxReport = { codeReferences: [], receipts: [], wroteSomething: false };
  const mayRead = context.policy.mayReadCode(context.actor);
  const mayWrite = context.policy.mayWriteTask(context.actor);
  const { code, board, chat } = context;
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
    if (code.recentCommits) add({ name: 'recent_commits', description: 'Recent commits (newest first), with messages and links. Omit branch to use the revision Nogita reads; pass a branch only if the person named one. Use for "what changed", "what did we push".',
      input_schema: { type: 'object', properties: { branch: { type: 'string' } } } },
    async input => {
      const commits = await code.recentCommits!(str(input.branch, 100));
      remember(commits.slice(0, 1));
      return { content: formatEvidence(commits) };
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
    add({ name: 'create_task', description: `Create a ${board.name} task. Only when the person explicitly asked you to create/open/log a task. Write a clear title and a description that captures what was discussed (who asked, why, acceptance details). If they named an owner, pass it as assignee (a person's name, or "me" for the speaker); never guess an owner.`,
      input_schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, assignee: { type: 'string' },
        ...(board.boards ? { board: { type: 'string', enum: board.boards.map(item => item.id),
          description: `Only if they named one: ${board.boards.map(item => item.name).join(', ')}. The first is the default.` } } : {}) },
        required: ['title', 'description'] } },
    async input => {
      if (!context.writesApproved && !requestsTaskWrite(context.request)) {
        return { content: 'Not created: the request does not explicitly ask to create a task. Ask the person to confirm with a direct request.', isError: true };
      }
      if (writes >= MAX_WRITES_PER_TURN) return { content: 'Not created: too many writes in one request.', isError: true };
      const title = str(input.title, 200);
      const description = str(input.description, 4000) ?? '';
      if (!title) return { content: 'title is required (at most 200 characters)', isError: true };
      let assigneeId: string | undefined;
      let assigneeName: string | undefined;
      let volunteered = false;
      const target = board.boards ? str(input.board, 40) : undefined;
      const wanted = str(input.assignee, 100);
      const lines = context.transcript?.() ?? [];
      if (wanted) {
        const resolved = await resolveAssignee(wanted, context, target);
        if ('problem' in resolved) return { content: `Not created: ${resolved.problem}`, isError: true };
        assigneeId = resolved.id;
        assigneeName = resolved.displayName;
      } else if (taskIndex === 0) {
        // Someone already said "I'll take it": they own it, if the board knows exactly one person by that name.
        const volunteer = findVolunteer(lines);
        const resolved = volunteer ? await resolveAssignee(volunteer, context, target).catch(() => undefined) : undefined;
        if (resolved && !('problem' in resolved)) { assigneeId = resolved.id; assigneeName = resolved.displayName; volunteered = true; }
      }
      const fullDescription = withMeetingQuotes(description, lines);
      writes++;
      // Index-based so a retried event maps its n-th task to the same Jira issue even if wording changes.
      const requestId = `${context.sessionId}:${context.eventId}:task:${++taskIndex}`;
      let receipt = context.completed.get(requestId);
      if (!receipt) {
        receipt = await board.createTask({ title, description: fullDescription, assigneeId, requestId, ...(target ? { board: target } : {}) });
        context.completed.set(requestId, receipt);
        context.recordAction?.('create_task');
        report.receipts.push(receipt);
        report.wroteSomething = true;
        await context.onReceipt(receipt).catch(() => undefined);
      }
      return { content: `Created ${receipt.label}${assigneeName ? `, assigned to ${assigneeName}${volunteered ? ', who said they would take it' : ''}` : ', unassigned'}: ${receipt.url}. The link is already in the chat.` };
    }, true);
    if (board.updateTask) add({ name: 'update_task', description: `Change an existing ${board.name} task: move it to a status, assign it to someone, and/or add a comment. Only the changes the person explicitly asked for in this request. Use the key they named or the task just discussed; if unclear which task, ask.`,
      input_schema: { type: 'object', properties: { key: { type: 'string', description: 'Task key such as KAN-12.' },
        status: { type: 'string', description: 'Target status as they said it ("In Progress", "Done").' },
        assignee: { type: 'string', description: 'New owner: a name, or "me" for the speaker.' },
        comment: { type: 'string', description: 'Comment text, ready to post.' } }, required: ['key'] } },
    async input => {
      const key = str(input.key, 40)?.toUpperCase();
      if (!key || !/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return { content: 'key must look like ABC-123', isError: true };
      const status = str(input.status, 60);
      const comment = str(input.comment, 3000);
      const wanted = str(input.assignee, 100);
      if (!status && !comment && !wanted) return { content: 'Nothing to change: give a status, an assignee or a comment.', isError: true };
      if (!context.writesApproved) {
        const asked = requestedTaskChanges(context.request);
        const extra = [status && !asked.status && 'a status change', wanted && !asked.assignee && 'a new owner', comment && !asked.comment && 'a comment'].filter(Boolean);
        if (extra.length) return { content: `Not changed: the request does not explicitly ask for ${extra.join(' or ')}. Ask the person to confirm with a direct request.`, isError: true };
      }
      if (writes >= MAX_WRITES_PER_TURN) return { content: 'Not changed: too many writes in one request.', isError: true };
      let assigneeId: string | undefined;
      let assigneeName: string | undefined;
      if (wanted) {
        const resolved = await resolveAssignee(wanted, context);
        if ('problem' in resolved) return { content: `Not changed: ${resolved.problem}`, isError: true };
        assigneeId = resolved.id;
        assigneeName = resolved.displayName;
      }
      writes++;
      const requestId = `${context.sessionId}:${context.eventId}:update:${key}:${status ?? ''}:${assigneeId ?? ''}:${comment ?? ''}`;
      let receipt = context.completed.get(requestId);
      if (!receipt) {
        receipt = await board.updateTask!({ key, status, assigneeId, comment, requestId });
        context.completed.set(requestId, receipt);
        context.recordAction?.('update_task');
        report.receipts.push(receipt);
        report.wroteSomething = true;
        await context.onReceipt(receipt).catch(() => undefined);
      }
      const done = [status && `moved to ${status}`, assigneeName && `assigned to ${assigneeName}`, comment && 'commented'].filter(Boolean).join(', ');
      return { content: `${receipt.label} ${done}: ${receipt.url}. The link is already in the chat.` };
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
    const drafts = context.drafts;
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
    add({ name: 'decide_mission', description: 'The mission owner approves or declines the action a mission is waiting on, resumes a blocked mission (with their guidance as note), or cancels one. Only when they clearly said so. mission_id may be left out when only one mission fits.',
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

async function resolveAssignee(name: string, context: ToolboxContext, board?: string):
  Promise<{ id: string; displayName: string } | { problem: string }> {
  if (/^(?:me|myself|i)$/i.test(name)) {
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
