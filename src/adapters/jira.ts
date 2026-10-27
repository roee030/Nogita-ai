import { createHash } from 'node:crypto';
import type { ActionReceipt, BoardPort, CreateTask } from '../core/contracts.ts';

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
}
export function adfParagraph(text: string): object {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: text || 'No description provided.' }] }] };
}
export class JiraBoard implements BoardPort {
  readonly name = 'jira';
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
  async createTask(task: CreateTask): Promise<ActionReceipt> {
    let providerAssigneeId: string | undefined;
    if (task.assigneeId) {
      providerAssigneeId = this.config.resolveAssigneeId?.(task.assigneeId)
        ?? (this.config.allowedAssigneeIds?.has(task.assigneeId) ? task.assigneeId : undefined);
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
