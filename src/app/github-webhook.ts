import { createHmac, timingSafeEqual } from 'node:crypto';

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
