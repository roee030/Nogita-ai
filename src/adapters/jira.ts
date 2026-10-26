import type { ActionReceipt, BoardPort, CreateTask } from '../core/contracts.ts';

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
  async createTask(task: CreateTask): Promise<ActionReceipt> {
    let providerAssigneeId: string | undefined;
    if (task.assigneeId) {
      providerAssigneeId = this.config.resolveAssigneeId?.(task.assigneeId)
        ?? (this.config.allowedAssigneeIds?.has(task.assigneeId) ? task.assigneeId : undefined);
      if (!providerAssigneeId) throw new Error('Assignee not in explicitly configured Jira allowlist');
    }
    const fields: Record<string, unknown> = {
      project: { key: this.config.projectKey },
      issuetype: { name: this.config.issueType },
      summary: task.title,
      description: adfParagraph(task.description),
    };
    if (providerAssigneeId) fields.assignee = { accountId: providerAssigneeId };
    const response = await this.http(new URL('/rest/api/3/issue', this.config.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64')}`,
        Accept: 'application/json', 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Jira create failed: HTTP ${response.status}`);
    const result = await response.json() as { key?: string };
    if (!result.key || !/^[A-Z][A-Z0-9_]+-\d+$/.test(result.key)) throw new Error('Jira returned no valid issue key');
    return { provider: 'jira', kind: 'task', label: result.key,
      url: `${this.config.baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(result.key)}` };
  }
}
