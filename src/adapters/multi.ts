/**
 * A company's several boards and repositories behind the ordinary ports, so the engine and the agent work the same
 * with one connection or many. Each connection has a short id ("web", "mobile-jira") chosen when it was connected.
 */
import type { ActionReceipt, AssigneeCandidate, BoardPort, CodeFile, CodePort, CreateTask, Evidence, TaskDetail, TaskSearch,
  TaskSummary, UpdateTask } from '../core/contracts.ts';

export interface BoardEntry { id: string; board: BoardPort }

/** Assignee ids from `findAssignees` carry their board, so a person is never assigned on a board they were not found on. */
const SEPARATOR = '::';

export class MultiBoard implements BoardPort {
  readonly name: string;
  readonly queryLanguage?: 'jql';
  readonly boards: ReadonlyArray<{ id: string; name: string }>;
  private readonly defaultId: string;

  constructor(private readonly entries: readonly BoardEntry[], defaultId?: string) {
    if (entries.length < 2) throw new Error('MultiBoard needs at least two boards');
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('board ids must be unique');
    this.defaultId = defaultId ?? entries[0]!.id;
    if (!entries.some(entry => entry.id === this.defaultId)) throw new Error(`no board ${this.defaultId}`);
    this.name = [...new Set(entries.map(entry => entry.board.name))].join(' and ');
    if (entries.some(entry => entry.board.queryLanguage === 'jql')) this.queryLanguage = 'jql';
    this.boards = entries.map(entry => ({ id: entry.id, name: `${entry.id} (${entry.board.name})` }));
  }

  private entry(id: string | undefined): BoardEntry {
    const wanted = id ?? this.defaultId;
    const found = this.entries.find(entry => entry.id === wanted);
    if (!found) throw new Error(`No board "${wanted}". Connected boards: ${this.entries.map(entry => entry.id).join(', ')}`);
    return found;
  }

  /** Splits "<board>::<id>"; an unprefixed id (an internal person id) is for any board to map. */
  private assignee(id: string | undefined): { board?: string; id?: string } {
    if (!id) return {};
    const at = id.indexOf(SEPARATOR);
    return at < 0 ? { id } : { board: id.slice(0, at), id: id.slice(at + SEPARATOR.length) };
  }

  async createTask(input: CreateTask): Promise<ActionReceipt> {
    const target = this.entry(input.board);
    const who = this.assignee(input.assigneeId);
    if (who.board && who.board !== target.id) throw new Error(`That person was found on ${who.board}, not on ${target.id}`);
    const { board: _board, ...rest } = input;
    return target.board.createTask({ ...rest, ...(who.id ? { assigneeId: who.id } : { assigneeId: undefined }) });
  }

  /** The board that holds the task makes the change; a person found on another board cannot be assigned there. */
  async updateTask(input: UpdateTask): Promise<ActionReceipt> {
    const who = this.assignee(input.assigneeId);
    for (const entry of this.entries) {
      if (!entry.board.updateTask || !await entry.board.getTask?.(input.key)) continue;
      if (who.board && who.board !== entry.id) throw new Error(`That person was found on ${who.board}, not on ${entry.id}`);
      return entry.board.updateTask({ ...input, assigneeId: who.id });
    }
    throw new Error(`${input.key} is not on a board Nogita can change`);
  }

  async searchTasks(query: TaskSearch): Promise<TaskSummary[]> {
    // An empty answer would read as "no tasks"; say the query cannot be run instead.
    if (query.jql && !this.queryLanguage) throw new Error('None of the connected boards understands JQL; use text, status and assignee');
    const who = this.assignee(query.assigneeId);
    const named = query.board ? this.entries.find(entry => entry.id === query.board) : undefined;
    let targets = named ? [named] : who.board ? [this.entry(who.board)] : this.entries.slice();
    targets = targets.filter(entry => entry.board.searchTasks && (!query.jql || entry.board.queryLanguage === 'jql'));
    if (!targets.length) return [];
    const forward: TaskSearch = { ...query, board: named ? undefined : query.board, assigneeId: who.id };
    const settled = await Promise.allSettled(targets.map(entry => entry.board.searchTasks!(forward)));
    const found = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    // One board that cannot answer (it does not know the person, it is down) must not hide the others' results.
    if (failed && settled.every(result => result.status === 'rejected')) throw failed.reason;
    return found.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')).slice(0, Math.min(query.limit ?? 15, 30));
  }

  async getTask(key: string): Promise<TaskDetail | undefined> {
    for (const entry of this.entries) {
      const task = await entry.board.getTask?.(key);
      if (task) return task;
    }
    return undefined;
  }

  async findAssignees(name: string, board?: string): Promise<AssigneeCandidate[]> {
    const target = this.entry(board);
    const found = await target.board.findAssignees?.(name) ?? [];
    return found.map(person => ({ id: `${target.id}${SEPARATOR}${person.id}`, displayName: person.displayName }));
  }
}

export interface CodeEntry { id: string; code: CodePort }

/** Several repositories as one: every path starts with the repository's id ("web/src/app.ts"). */
export class MultiCode implements CodePort {
  readonly name: string;

  constructor(private readonly entries: readonly CodeEntry[]) {
    if (entries.length < 2) throw new Error('MultiCode needs at least two repositories');
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('repository ids must be unique');
    this.name = entries.map(entry => entry.id).join(' and ');
  }

  private split(path: string): { entry: CodeEntry; rest: string } | undefined {
    const clean = path.replace(/^\/+/, '');
    const entry = this.entries.find(item => clean === item.id || clean.startsWith(`${item.id}/`));
    return entry && { entry, rest: clean.slice(entry.id.length + 1) };
  }

  async prepare(): Promise<void> {
    await Promise.all(this.entries.map(entry => entry.code.prepare?.()));
  }

  getCoverage(): { indexedFiles: number; skippedLargeFiles: number } | undefined {
    const all = this.entries.map(entry => entry.code.getCoverage?.()).filter(item => item !== undefined);
    if (!all.length) return undefined;
    return { indexedFiles: all.reduce((sum, item) => sum + item.indexedFiles, 0),
      skippedLargeFiles: all.reduce((sum, item) => sum + item.skippedLargeFiles, 0) };
  }

  async findEvidence(query: string): Promise<Evidence[]> {
    const settled = await Promise.allSettled(this.entries.map(async entry =>
      (await entry.code.findEvidence(query)).map(item => ({ ...item, path: `${entry.id}/${item.path}` }))));
    if (settled.every(result => result.status === 'rejected')) throw (settled[0] as PromiseRejectedResult).reason;
    const lists = settled.map(result => result.status === 'fulfilled' ? result.value : []);
    // Best of each repository first, so one large repository cannot crowd out the others.
    const merged: Evidence[] = [];
    for (let i = 0; lists.some(list => i < list.length); i++) for (const list of lists) if (list[i]) merged.push(list[i]!);
    return merged;
  }

  async readFile(path: string, startLine?: number, endLine?: number): Promise<CodeFile | undefined> {
    const target = this.split(path);
    if (!target?.rest || !target.entry.code.readFile) return undefined;
    const file = await target.entry.code.readFile(target.rest, startLine, endLine);
    return file && { ...file, path: `${target.entry.id}/${file.path}` };
  }

  async listFiles(prefix?: string): Promise<string[]> {
    const target = prefix ? this.split(prefix) : undefined;
    const entries = target ? [target.entry] : this.entries;
    const lists = await Promise.all(entries.map(async entry =>
      (await entry.code.listFiles?.(target?.rest || undefined) ?? []).map(path => `${entry.id}/${path}`)));
    return lists.flat().filter(path => !prefix || target || path.startsWith(prefix));
  }

  async recentCommits(ref?: string): Promise<Evidence[]> {
    const lists = await Promise.all(this.entries.map(async entry =>
      (await entry.code.recentCommits?.(ref).catch(() => [] as Evidence[]) ?? [])
        .map(item => ({ ...item, excerpt: `[${entry.id}] ${item.excerpt}` }))));
    return lists.flat();
  }

  async overview(): Promise<{ paths: string[]; readme?: string }> {
    const views = await Promise.all(this.entries.map(async entry => ({ id: entry.id, view: await entry.code.overview?.() })));
    const readme = views.find(item => item.view?.readme);
    return { paths: views.flatMap(item => (item.view?.paths ?? []).map(path => `${item.id}/${path}`)),
      ...(readme ? { readme: `(${readme.id}) ${readme.view!.readme}` } : {}) };
  }
}
