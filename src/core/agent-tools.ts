import type { ActionReceipt, Actor, BoardPort, ChatPort, CodePort, Evidence, PolicyPort } from './contracts.ts';
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
  people?: PeopleDirectory;
  /** Called after a successful write so the meeting chat gets the link immediately. */
  onReceipt: (receipt: ActionReceipt) => Promise<void>;
  /** Idempotency memory shared across retries of the same event. */
  completed: Map<string, ActionReceipt>;
  recordAction?: (action: 'create_task' | 'code_lookup') => void;
}

/** Things the engine needs after the turn: the best source link and the receipts that were posted. */
export interface ToolboxReport {
  codeReferences: Evidence[];
  receipts: ActionReceipt[];
  wroteSomething: boolean;
}

const MAX_WRITES_PER_TURN = 5;

/** A direct request to make a ticket. Wider than the legacy planner check, still deterministic. */
export function requestsTaskWrite(request: string): boolean {
  const t = request.toLowerCase();
  if (/\b(?:pr|pull request)\b/.test(t) && !/\b(?:task|ticket|issue|story|bug)\b/.test(t)) return false;
  return /\b(?:create|open|add|file|make|log|raise|put|write up|track|assign|new)\b/.test(t) &&
    /\b(?:task|tasks|ticket|tickets|issue|issues|bug|bugs|story|stories|jira|card|todo|to-do|backlog)\b/.test(t);
}
/** A direct request to send something to a Slack channel. */
export function requestsChatPost(request: string): boolean {
  const t = request.toLowerCase();
  return /\b(?:post|send|share|tell|message|notify|announce|ping|let)\b/.test(t) &&
    /(?:\bslack\b|\bchannel\b|#[\w-]+|\bthread\b|\beveryone\b|\bthe team\b)/.test(t);
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
    if (board.searchTasks) add({ name: 'search_tasks', description: `Search ${board.name} tasks. Give free text, or a JQL condition such as 'assignee = currentUser()' or 'status = "In Progress"' (the project filter is added for you).`,
      input_schema: { type: 'object', properties: { text: { type: 'string' }, jql: { type: 'string' }, limit: { type: 'integer' } } } },
    async input => {
      const tasks = await board.searchTasks!({ text: str(input.text, 300), jql: str(input.jql, 600), limit: int(input.limit, 1, 30) });
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
      input_schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, assignee: { type: 'string' } }, required: ['title', 'description'] } },
    async input => {
      if (!requestsTaskWrite(context.request)) {
        return { content: 'Not created: the request does not explicitly ask to create a task. Ask the person to confirm with a direct request.', isError: true };
      }
      if (writes >= MAX_WRITES_PER_TURN) return { content: 'Not created: too many writes in one request.', isError: true };
      const title = str(input.title, 200);
      const description = str(input.description, 4000) ?? '';
      if (!title) return { content: 'title is required (at most 200 characters)', isError: true };
      let assigneeId: string | undefined;
      let assigneeName: string | undefined;
      const wanted = str(input.assignee, 100);
      if (wanted) {
        const resolved = await resolveAssignee(wanted, context);
        if ('problem' in resolved) return { content: `Not created: ${resolved.problem}`, isError: true };
        assigneeId = resolved.id;
        assigneeName = resolved.displayName;
      }
      writes++;
      // Index-based so a retried event maps its n-th task to the same Jira issue even if wording changes.
      const requestId = `${context.sessionId}:${context.eventId}:task:${++taskIndex}`;
      let receipt = context.completed.get(requestId);
      if (!receipt) {
        receipt = await board.createTask({ title, description, assigneeId, requestId });
        context.completed.set(requestId, receipt);
        context.recordAction?.('create_task');
        report.receipts.push(receipt);
        report.wroteSomething = true;
        await context.onReceipt(receipt).catch(() => undefined);
      }
      return { content: `Created ${receipt.label}${assigneeName ? `, assigned to ${assigneeName}` : ', unassigned'}: ${receipt.url}. The link is already in the chat.` };
    }, true);
    if (chat) add({ name: 'post_message', description: `Post a message to a ${chat.name} channel. Only when the person explicitly asked you to post/send/share something there. Write the message itself, ready to send.`,
      input_schema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } },
    async input => {
      if (!requestsChatPost(context.request)) {
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

async function resolveAssignee(name: string, context: ToolboxContext):
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
    const found = await context.board.findAssignees(name);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) {
      return { problem: `more than one person matches "${name}": ${found.slice(0, 5).map(p => p.displayName).join(', ')}. Ask which one.` };
    }
  }
  return { problem: `I could not find anyone named "${name}" who can be assigned on ${context.board.name}. Ask who should own it, or create it unassigned if they agree.` };
}
