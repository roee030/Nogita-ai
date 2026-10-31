import { createHmac, timingSafeEqual } from 'node:crypto';

export function githubWebhookConfigured(enabled: boolean, secret: string | undefined): boolean {
  return !enabled || Boolean(secret && secret.length >= 20);
}

export class GitHubRefreshQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly refresh: (sha: string) => Promise<void>,
    private readonly onError: (error: unknown, sha: string) => void = () => undefined,
    private readonly options: { maxAttempts?: number; retryDelayMs?: number } = {},
  ) {}

  enqueue(sha: string): Promise<void> {
    const job = this.tail.then(() => this.run(sha));
    this.tail = job.catch(() => undefined);
    return job;
  }

  private async run(sha: string): Promise<void> {
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? 3);
    const retryDelayMs = Math.max(0, this.options.retryDelayMs ?? 1_000);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try { await this.refresh(sha); return; } catch (error) { lastError = error; }
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
    this.onError(lastError, sha);
  }
}

export function verifyGitHubWebhookSignature(secret: string, raw: string, signature: string | undefined): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const supplied = signature.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest();
  const received = Buffer.from(supplied, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function parseGitHubPush(
  raw: string,
  event: string | undefined,
  expected: { owner: string; repo: string; ref: string },
): { sha: string } | null {
  if (event !== 'push') return null;
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  const push = payload as { ref?: unknown; after?: unknown; repository?: { full_name?: unknown } };
  const fullName = push.repository?.full_name;
  if (push.ref !== `refs/heads/${expected.ref}` || typeof fullName !== 'string' ||
      fullName.toLocaleLowerCase() !== `${expected.owner}/${expected.repo}`.toLocaleLowerCase() ||
      typeof push.after !== 'string' || !/^[a-f0-9]{40}$/i.test(push.after) || /^0+$/.test(push.after)) return null;
  return { sha: push.after.toLowerCase() };
}

export function acceptGitHubWebhook(options: {
  secret: string;
  raw: string;
  signature: string | undefined;
  event: string | undefined;
  expected: { owner: string; repo: string; ref: string };
  refresh: (sha: string) => Promise<void>;
  onError?: (error: unknown) => void;
}): { status: number; response: Record<string, unknown> } {
  if (!verifyGitHubWebhookSignature(options.secret, options.raw, options.signature)) {
    return { status: 401, response: { error: 'invalid GitHub signature' } };
  }
  const push = parseGitHubPush(options.raw, options.event, options.expected);
  if (!push) return { status: 202, response: { ok: true, ignored: true } };
  void options.refresh(push.sha).catch(options.onError ?? (() => undefined));
  return { status: 202, response: { ok: true, acceptedSha: push.sha } };
}
