/**
 * Draft pull requests on GitHub, asked for out loud ("Nogita, open a draft PR for the retry fix"). Deliberately narrow:
 * a new branch from the configured ref, one note file that says what was asked and why, and a pull request in draft
 * state for a person to build on. It never writes to an existing branch, never merges, never force-pushes, never deletes.
 *
 * Crash-safe like Jira task creation: the branch name comes from a hash of the request id, so a retried request finds
 * the branch (and its pull request) it already made instead of opening a second one.
 */
import { createHash } from 'node:crypto';
import { readToken, type TokenSource } from './token-source.ts';
import type { ActionReceipt, DraftPullRequest, PullRequestPort } from '../core/contracts.ts';

export function draftBranchName(title: string, requestId: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const digest = createHash('sha256').update('nogita:draft-pr:v1\0').update(requestId).digest('hex').slice(0, 10);
  return `nogita/${slug || 'change'}-${digest}`;
}

export class GitHubDrafts implements PullRequestPort {
  readonly name = 'github';
  private readonly api = 'https://api.github.com';
  constructor(private readonly config: { token: TokenSource; owner: string; repo: string; ref: string; notesDir?: string },
              private readonly http: typeof fetch = fetch) {
    if (!config.token || !/^[a-zA-Z0-9_-]+$/.test(config.owner) || !/^[\w.-]+$/.test(config.repo) || !/^[\w./-]+$/.test(config.ref)) {
      throw new Error('GitHub draft pull requests need a token, an owner, a repository and a base branch');
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.http(`${this.api}/repos/${this.config.owner}/${this.config.repo}${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Nogita-V1',
        Authorization: `Bearer ${await readToken(this.config.token)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    let json: unknown;
    try { json = res.status === 204 ? undefined : await res.json(); } catch { json = undefined; }
    if (res.status === 401) throw new Error('GitHub did not accept the token');
    if (res.status === 403 || res.status === 404) throw new Error(`GitHub refused (HTTP ${res.status}): the token needs Contents and Pull requests write access to ${this.config.owner}/${this.config.repo}`);
    if (res.status >= 500) throw new Error(`GitHub failed: HTTP ${res.status}`);
    return { status: res.status, json };
  }

  private receipt(pr: { number?: unknown; html_url?: unknown }): ActionReceipt {
    if (typeof pr.number !== 'number' || typeof pr.html_url !== 'string' || !pr.html_url.startsWith('https://github.com/')) {
      throw new Error('GitHub returned no valid pull request');
    }
    return { provider: 'github', kind: 'draft_pr', label: `PR #${pr.number}`, url: pr.html_url };
  }

  async openDraft(input: DraftPullRequest): Promise<ActionReceipt> {
    const { owner, ref } = this.config;
    const branch = draftBranchName(input.title, input.requestId);
    const existing = await this.call('GET', `/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    if (existing.status === 200 && Array.isArray(existing.json) && existing.json.length) return this.receipt(existing.json[0] as Record<string, unknown>);

    const base = await this.call('GET', `/git/ref/heads/${ref.split('/').map(encodeURIComponent).join('/')}`);
    const sha = (base.json as { object?: { sha?: unknown } } | undefined)?.object?.sha;
    if (base.status !== 200 || typeof sha !== 'string') throw new Error(`GitHub has no branch ${ref} to start from`);
    // 422 means the branch is there already: an earlier attempt of this same request got this far.
    const branchMade = await this.call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
    if (branchMade.status !== 201 && branchMade.status !== 422) throw new Error(`GitHub branch create failed: HTTP ${branchMade.status}`);

    const notePath = `${(this.config.notesDir ?? '.nogita').replace(/^\/+|\/+$/g, '')}/${branch.slice('nogita/'.length)}.md`;
    const note = `# ${input.title}\n\n${input.description}\n\nOpened by Nogita on request. A person builds on this branch and reviews it before anything is merged.\n`;
    const noted = await this.call('PUT', `/contents/${notePath.split('/').map(encodeURIComponent).join('/')}`, {
      message: `Start: ${input.title}`.slice(0, 200), content: Buffer.from(note, 'utf8').toString('base64'), branch });
    if (noted.status !== 201 && noted.status !== 200 && noted.status !== 422) throw new Error(`GitHub note commit failed: HTTP ${noted.status}`);

    const pr = await this.call('POST', '/pulls', { title: input.title.replace(/\s+/g, ' ').trim().slice(0, 250), head: branch, base: ref,
      body: `${input.description}\n\n_Opened as a draft by Nogita on request._`, draft: true });
    if (pr.status !== 201) {
      const message = (pr.json as { message?: unknown } | undefined)?.message;
      throw new Error(`GitHub pull request failed: HTTP ${pr.status}${typeof message === 'string' ? ` (${message.slice(0, 160)})` : ''}`);
    }
    if ((pr.json as { draft?: unknown }).draft === false) throw new Error('GitHub opened the pull request but not as a draft');
    return this.receipt(pr.json as Record<string, unknown>);
  }
}
