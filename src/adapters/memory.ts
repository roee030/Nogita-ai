/**
 * Complete in-memory board and repository. They implement every optional method of their port the way a real
 * adapter should, so they are the reference the conformance kits are written against, and stand-ins in tests.
 */
import type { ActionReceipt, AssigneeCandidate, BoardPort, CodeFile, CodePort, CreateTask, Evidence, TaskDetail, TaskSearch,
  TaskSummary, UpdateTask } from '../core/contracts.ts';

interface MemoryTask { key: string; title: string; description: string; status: string; assigneeId?: string; updated: number;
  comments: Array<{ author?: string; text: string }> }

export class MemoryBoard implements BoardPort {
  readonly tasks: MemoryTask[] = [];
  private readonly byRequest = new Map<string, string>();
  private clock = 0;
  /** `people`: internal person id -> display name, the people this board can assign. */
  constructor(readonly name = 'memory', private readonly prefix = 'MEM',
    private readonly people: ReadonlyMap<string, string> = new Map(), private readonly initialStatus = 'To Do') {}

  private receipt(key: string): ActionReceipt {
    return { provider: this.name, kind: 'task', label: key, url: `https://board.invalid/${this.name}/${key}` };
  }
  private personFor(id: string): string | undefined {
    const internal = id.startsWith(`${this.name}:`) ? id.slice(this.name.length + 1) : id;
    return this.people.has(internal) ? internal : undefined;
  }
  private summary(task: MemoryTask): TaskSummary {
    return { key: task.key, title: task.title, status: task.status, assignee: task.assigneeId && this.people.get(task.assigneeId),
      updated: new Date(task.updated * 1000).toISOString().slice(0, 10), url: this.receipt(task.key).url };
  }

  async createTask(input: CreateTask): Promise<ActionReceipt> {
    // A retried request returns the task it already created.
    const existing = this.byRequest.get(input.requestId);
    if (existing) return this.receipt(existing);
    let assigneeId: string | undefined;
    if (input.assigneeId) {
      assigneeId = this.personFor(input.assigneeId);
      if (!assigneeId) throw new Error(`${this.name} cannot assign that person`);
    }
    const key = `${this.prefix}-${this.tasks.length + 1}`;
    this.tasks.push({ key, title: input.title, description: input.description, status: this.initialStatus, assigneeId,
      updated: ++this.clock, comments: [] });
    this.byRequest.set(input.requestId, key);
    return this.receipt(key);
  }

  async updateTask(input: UpdateTask): Promise<ActionReceipt> {
    const task = this.tasks.find(item => item.key === input.key.toUpperCase());
    if (!task) throw new Error(`${input.key} was not found`);
    let assigneeId: string | undefined;
    if (input.assigneeId) {
      assigneeId = this.personFor(input.assigneeId);
      if (!assigneeId) throw new Error(`${this.name} cannot assign that person`);
    }
    if (input.status?.trim()) task.status = input.status.trim();
    if (assigneeId) task.assigneeId = assigneeId;
    const comment = input.comment?.trim();
    if (comment && !task.comments.some(existing => existing.text === comment)) task.comments.push({ author: 'Nogita', text: comment });
    task.updated = ++this.clock;
    return this.receipt(task.key);
  }

  async searchTasks(query: TaskSearch): Promise<TaskSummary[]> {
    if (query.jql) throw new Error(`${this.name} does not understand JQL; use text, status and assignee`);
    if (query.board && query.board.toUpperCase() !== this.prefix && query.board !== this.name) return [];
    let assigneeId: string | undefined;
    if (query.assigneeId && !query.unassigned) {
      assigneeId = this.personFor(query.assigneeId);
      if (!assigneeId) throw new Error(`${this.name} does not know that person`);
    }
    const words = (query.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return this.tasks
      .filter(task => words.every(word => `${task.title} ${task.description}`.toLowerCase().includes(word)))
      .filter(task => !query.status || task.status.toLowerCase() === query.status.trim().toLowerCase())
      .filter(task => query.unassigned ? !task.assigneeId : !assigneeId || task.assigneeId === assigneeId)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, Math.min(query.limit ?? 15, 30))
      .map(task => this.summary(task));
  }

  async getTask(key: string): Promise<TaskDetail | undefined> {
    const task = this.tasks.find(item => item.key === key.toUpperCase());
    return task && { ...this.summary(task), description: task.description, comments: task.comments.slice() };
  }

  async findAssignees(name: string): Promise<AssigneeCandidate[]> {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return [];
    return [...this.people].filter(([, display]) =>
      display.toLowerCase() === wanted || display.toLowerCase().split(/\s+/).includes(wanted))
      .map(([id, displayName]) => ({ id: `${this.name}:${id}`, displayName }));
  }

  /** Test helper: what a person does on the board itself. */
  move(key: string, status: string): void {
    const task = this.tasks.find(item => item.key === key);
    if (!task) throw new Error(`no task ${key}`);
    task.status = status;
    task.updated = ++this.clock;
  }
}

export class MemoryCode implements CodePort {
  /** `files`: path -> text. `commits`: newest first. */
  constructor(readonly name: string, private readonly files: Readonly<Record<string, string>>,
    private readonly commits: ReadonlyArray<{ hash: string; message: string }> = []) {}

  private url(path: string, line = 1): string { return `https://code.invalid/${this.name}/${path}#L${line}`; }

  async findEvidence(query: string): Promise<Evidence[]> {
    const words = query.toLowerCase().split(/[^\p{L}\p{N}_.]+/u).filter(word => word.length > 2);
    const scored = Object.entries(this.files).map(([path, text]) => {
      const haystack = `${path}\n${text}`.toLowerCase();
      return { path, text, score: words.filter(word => haystack.includes(word)).length };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored.slice(0, 8).map(({ path, text }) => {
      const lines = text.split('\n');
      const index = Math.max(0, lines.findIndex(line => words.some(word => line.toLowerCase().includes(word))));
      return { path, url: this.url(path, index + 1), excerpt: lines.slice(index, index + 6).join('\n') };
    });
  }

  async readFile(path: string, startLine?: number, endLine?: number): Promise<CodeFile | undefined> {
    const text = this.files[path.replace(/^\/+/, '')];
    if (text === undefined) return undefined;
    const lines = text.split('\n');
    const start = Math.max(1, Math.min(startLine ?? 1, lines.length));
    const end = Math.max(start, Math.min(endLine ?? lines.length, lines.length));
    return { path, url: this.url(path, start), startLine: start, endLine: end, totalLines: lines.length,
      text: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n') };
  }

  async listFiles(prefix?: string): Promise<string[]> {
    return Object.keys(this.files).filter(path => !prefix || path.startsWith(prefix.replace(/^\/+/, ''))).sort();
  }

  async recentCommits(): Promise<Evidence[]> {
    return this.commits.map(commit => ({ path: commit.hash, url: `https://code.invalid/${this.name}/commit/${commit.hash}`,
      excerpt: commit.message }));
  }

  async overview(): Promise<{ paths: string[]; readme?: string }> {
    const readme = Object.keys(this.files).find(path => /^readme(?:\.\w+)?$/i.test(path));
    return { paths: Object.keys(this.files).sort(), ...(readme ? { readme: this.files[readme] } : {}) };
  }
}
