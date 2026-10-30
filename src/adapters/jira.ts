import { createHash } from 'node:crypto';
import type { ActionReceipt, AssigneeCandidate, BoardPort, CreateTask, TaskDetail, TaskSearch, TaskSummary } from '../core/contracts.ts';

const REQUEST_PROPERTY = 'com.nogita.request.v1';

export function jiraRequestDigest(requestId: string): string {
  return createHash('sha256').update('nogita:jira-request:v1\0').update(requestId).digest('hex');
}

export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
  projectKey: string;
  issueType: string;
  /** Trusted mapping from user identity to Jira account IDs must happen outside the model. */
  allowedAssigneeIds?: ReadonlySet<string>;
  resolveAssigneeId?: (internalId: string) => string | undefined;
  /** Extra project keys the agent may read (search/get). Writes always go to `projectKey`. */
  readProjectKeys?: readonly string[];
}

/** Plain text from Atlassian Document Format, enough for a model to read a description or comment. */
export function adfToText(node: unknown, depth = 0): string {
  if (!node || typeof node !== 'object' || depth > 40) return '';
  const value = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
  if (value.type === 'text') return value.text ?? '';
  if (value.type === 'hardBreak') return '\n';
  if (value.type === 'mention') return String(value.attrs?.text ?? '@someone');
  const inner = (value.content ?? []).map(child => adfToText(child, depth + 1)).join('');
  if (value.type === 'paragraph' || value.type === 'heading') return `${inner}\n`;
  if (value.type === 'listItem') return `- ${inner.trim()}\n`;
  if (value.type === 'codeBlock') return `${inner}\n`;
  return inner;
}
const KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;
const SEARCH_FIELDS = ['summary', 'status', 'assignee', 'issuetype', 'priority', 'updated'];
interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string; status?: { name?: string }; assignee?: { displayName?: string } | null;
    issuetype?: { name?: string }; priority?: { name?: string } | null; updated?: string; created?: string;
    reporter?: { displayName?: string } | null; description?: unknown;
    comment?: { comments?: Array<{ author?: { displayName?: string }; created?: string; body?: unknown }> };
  };
}
export function adfParagraph(text: string): object {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: text || 'No description provided.' }] }] };
}
export class JiraBoard implements BoardPort {
  readonly name = 'jira';
  readonly queryLanguage = 'jql' as const;
  constructor(private readonly config: JiraConfig, private readonly http: typeof fetch = fetch) {
    const u = new URL(config.baseUrl);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.atlassian.net')) {
      throw new Error('Jira base URL must be an HTTPS Atlassian Cloud host');
    }
    if (!config.email || !config.token || !/^[A-Za-z][A-Za-z0-9_-]+$/.test(config.projectKey)) {
      throw new Error('Jira credentials or project key missing/invalid');
    }
  }
  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64')}`,
      Accept: 'application/json', 'Content-Type': 'application/json',
    };
  }
  private readonly verifiedAssignees = new Map<string, string>();
  private get readProjects(): string[] {
    return [...new Set([this.config.projectKey, ...(this.config.readProjectKeys ?? [])])]
      .filter(key => /^[A-Za-z][A-Za-z0-9_-]+$/.test(key));
  }
  private summary(issue: JiraIssue): TaskSummary | undefined {
    if (typeof issue.key !== 'string' || !KEY_PATTERN.test(issue.key)) return undefined;
    const fields = issue.fields ?? {};
    return { key: issue.key, title: fields.summary ?? '(no title)', status: fields.status?.name,
      assignee: fields.assignee?.displayName ?? undefined, type: fields.issuetype?.name,
      priority: fields.priority?.name ?? undefined, updated: fields.updated?.slice(0, 10),
      url: this.receipt(issue.key).url };
  }
  async searchTasks(query: TaskSearch): Promise<TaskSummary[]> {
    const only = query.board && this.readProjects.find(key => key.toUpperCase() === query.board!.toUpperCase());
    const projects = (only ? [only] : this.readProjects).map(key => `"${key}"`).join(', ');
    let condition = query.jql?.trim() ?? '';
    let order = 'ORDER BY updated DESC';
    const orderAt = condition.search(/\border\s+by\b/i);
    if (orderAt >= 0) { order = condition.slice(orderAt); condition = condition.slice(0, orderAt).trim(); }
    // Keep the agent inside the configured projects: no project clause of its own, no way to close our parenthesis.
    let depth = 0;
    for (const char of condition.replace(/"(?:[^"\\]|\\.)*"/g, '""')) {
      depth += char === '(' ? 1 : char === ')' ? -1 : 0;
      if (depth < 0) break;
    }
    if (depth !== 0 || /\bproject\b/i.test(condition.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) {
      throw new Error('Jira search condition must not set the project or use unbalanced parentheses');
    }
    const clauses = [`project in (${projects})`];
    if (condition) clauses.push(`(${condition})`);
    if (query.text?.trim()) clauses.push(`text ~ "${query.text.trim().replace(/["\\]/g, ' ').slice(0, 200)}"`);
    if (query.status?.trim()) clauses.push(`status = "${query.status.trim().replace(/["\\]/g, ' ').slice(0, 60)}"`);
    if (query.unassigned) clauses.push('assignee is EMPTY');
    else if (query.assigneeId) {
      const accountId = this.accountIdFor(query.assigneeId);
      if (!accountId) throw new Error('That person has no Jira account Nogita knows about');
      clauses.push(`assignee = "${accountId.replace(/["\\]/g, '')}"`);
    }
    const response = await this.http(new URL('/rest/api/3/search/jql', this.config.baseUrl), {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ jql: `${clauses.join(' AND ')} ${order}`, maxResults: Math.min(query.limit ?? 15, 30), fields: SEARCH_FIELDS }),
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 400) {
      let detail = '';
      try { detail = ((await response.json()) as { errorMessages?: string[] }).errorMessages?.join(' ') ?? ''; } catch { /* keep generic */ }
      throw new Error(`Jira rejected the search${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    if (!response.ok) throw new Error(`Jira search failed: HTTP ${response.status}`);
    const result = await response.json() as { issues?: JiraIssue[] };
    return (result.issues ?? []).map(issue => this.summary(issue)).filter((item): item is TaskSummary => item !== undefined);
  }
  async getTask(key: string): Promise<TaskDetail | undefined> {
    if (!KEY_PATTERN.test(key) || !this.readProjects.some(project => key.startsWith(`${project.toUpperCase()}-`))) return undefined;
    const response = await this.http(new URL(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${[...SEARCH_FIELDS, 'description', 'comment', 'reporter', 'created'].join(',')}`, this.config.baseUrl), {
      method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(12000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Jira read failed: HTTP ${response.status}`);
    const issue = await response.json() as JiraIssue;
    const summary = this.summary(issue);
    if (!summary) return undefined;
    const comments = issue.fields?.comment?.comments ?? [];
    return { ...summary, description: adfToText(issue.fields?.description).trim().slice(0, 6000),
      reporter: issue.fields?.reporter?.displayName ?? undefined, created: issue.fields?.created?.slice(0, 10),
      comments: comments.slice(-8).map(comment => ({ author: comment.author?.displayName, created: comment.created?.slice(0, 10),
        text: adfToText(comment.body).trim().slice(0, 1200) })) };
  }
  /** People who can be assigned in the write project, matched by name. Returned IDs are accepted by createTask. */
  async findAssignees(name: string): Promise<AssigneeCandidate[]> {
    const query = name.trim().slice(0, 100);
    if (!query) return [];
    const url = new URL('/rest/api/3/user/assignable/search', this.config.baseUrl);
    url.searchParams.set('project', this.config.projectKey);
    url.searchParams.set('query', query);
    url.searchParams.set('maxResults', '20');
    const response = await this.http(url, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Jira user search failed: HTTP ${response.status}`);
    const users = await response.json() as Array<{ accountId?: string; displayName?: string; active?: boolean; accountType?: string }>;
    const wanted = query.toLocaleLowerCase();
    const people = (Array.isArray(users) ? users : []).filter(user => user.active !== false && user.accountType !== 'app' &&
      typeof user.accountId === 'string' && typeof user.displayName === 'string');
    // Prefer an exact full-name match, then people whose first or last name is the spoken name.
    const exact = people.filter(user => user.displayName!.toLocaleLowerCase() === wanted);
    const byWord = people.filter(user => user.displayName!.toLocaleLowerCase().split(/\s+/).includes(wanted));
    const chosen = exact.length ? exact : byWord.length ? byWord : people;
    return chosen.map(user => {
      const id = `jira:${user.accountId}`;
      this.verifiedAssignees.set(id, user.accountId!);
      return { id, displayName: user.displayName! };
    });
  }
  private receipt(key: string): ActionReceipt {
    return { provider: 'jira', kind: 'task', label: key,
      url: `${this.config.baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}` };
  }
  private async findExisting(requestDigest: string): Promise<ActionReceipt | undefined> {
    const response = await this.http(new URL('/rest/api/3/search/jql', this.config.baseUrl), {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({
        jql: `project = "${this.config.projectKey}" AND creator = currentUser() ORDER BY created DESC`,
        maxResults: 100, fields: ['key'], properties: [REQUEST_PROPERTY],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Jira recovery search failed: HTTP ${response.status}`);
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new Error('Jira recovery search returned invalid data'); }
    if (!result || typeof result !== 'object' ||
        !Array.isArray((result as Record<string, unknown>).issues)) {
      throw new Error('Jira recovery search returned invalid data');
    }
    for (const value of (result as { issues: unknown[] }).issues) {
      if (!value || typeof value !== 'object') throw new Error('Jira recovery search returned invalid data');
      const issue = value as Record<string, unknown>;
      const properties = issue.properties;
      if (properties !== undefined && (!properties || typeof properties !== 'object')) {
        throw new Error('Jira recovery search returned invalid data');
      }
      const marker = (properties as Record<string, unknown> | undefined)?.[REQUEST_PROPERTY];
      if (marker !== undefined && (!marker || typeof marker !== 'object' ||
          typeof (marker as Record<string, unknown>).digest !== 'string' ||
          !/^[0-9a-f]{64}$/.test((marker as Record<string, unknown>).digest as string))) {
        throw new Error('Jira recovery search returned invalid data');
      }
      if (marker && (marker as Record<string, unknown>).digest === requestDigest) {
        if (typeof issue.key !== 'string' || !/^[A-Z][A-Z0-9_]+-\d+$/.test(issue.key)) {
          throw new Error('Jira recovery search returned invalid data');
        }
        return this.receipt(issue.key);
      }
    }
    return undefined;
  }
  /** A Jira account id for an internal person id, a verified `jira:` candidate, or an allowlisted account id. */
  private accountIdFor(id: string): string | undefined {
    return this.config.resolveAssigneeId?.(id) ?? this.verifiedAssignees.get(id)
      ?? (this.config.allowedAssigneeIds?.has(id) ? id : undefined);
  }
  async createTask(task: CreateTask): Promise<ActionReceipt> {
    let providerAssigneeId: string | undefined;
    if (task.assigneeId) {
      providerAssigneeId = this.accountIdFor(task.assigneeId);
      if (!providerAssigneeId) throw new Error('Assignee not in explicitly configured Jira allowlist');
    }
    const requestDigest = jiraRequestDigest(task.requestId);
    const existing = await this.findExisting(requestDigest);
    if (existing) return existing;
    const fields: Record<string, unknown> = {
      project: { key: this.config.projectKey },
      issuetype: { name: this.config.issueType },
      summary: task.title,
      description: adfParagraph(task.description),
    };
    if (providerAssigneeId) fields.assignee = { accountId: providerAssigneeId };
    const response = await this.http(new URL('/rest/api/3/issue', this.config.baseUrl), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ fields, properties: [{ key: REQUEST_PROPERTY, value: { digest: requestDigest } }] }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Jira create failed: HTTP ${response.status}`);
    const result = await response.json() as { key?: string };
    if (!result.key || !/^[A-Z][A-Z0-9_]+-\d+$/.test(result.key)) throw new Error('Jira returned no valid issue key');
    return this.receipt(result.key);
  }
}
