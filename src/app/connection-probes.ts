import { DEFAULT_ANTHROPIC_AGENT_MODEL, DEFAULT_ANTHROPIC_MODEL } from '../adapters/anthropic.ts';
import type { ConnectionCheck, ConnectionProvider, ConnectionReadinessReport } from './readiness.ts';

const PROVIDERS: readonly ConnectionProvider[] =
  ['github', 'jira', 'slack', 'anthropic', 'deepgram', 'attendee'];

export async function probeConnections(
  env: NodeJS.ProcessEnv,
  http: typeof fetch = fetch,
): Promise<ConnectionReadinessReport> {
  const checks = await Promise.all(PROVIDERS.map(async (provider): Promise<ConnectionCheck> => {
    let url: string;
    const headers: Record<string, string> = {};
    if (provider === 'github') {
      if (!env.GITHUB_OWNER || !env.GITHUB_REPO) return { provider, status: 'unconfigured' };
      url = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/git/trees/${encodeURIComponent(env.GITHUB_REF ?? 'main')}`;
      headers['User-Agent'] = 'Nogita';
      if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    } else if (provider === 'jira') {
      if (!env.JIRA_BASE_URL || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN || !env.JIRA_PROJECT_KEY)
        return { provider, status: 'unconfigured' };
      let base: URL;
      try { base = new URL(env.JIRA_BASE_URL); }
      catch { return { provider, status: 'invalid_configuration' }; }
      if (base.protocol !== 'https:' || !base.hostname.endsWith('.atlassian.net') ||
          base.username || base.password || base.pathname !== '/' || base.search || base.hash)
        return { provider, status: 'invalid_configuration' };
      url = `${base.origin}/rest/api/3/project/${encodeURIComponent(env.JIRA_PROJECT_KEY)}`;
      headers.Authorization = `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}`;
    } else if (provider === 'slack') {
      if (!env.SLACK_BOT_TOKEN) return { provider, status: 'unconfigured' };
      url = 'https://slack.com/api/auth.test';
      headers.Authorization = `Bearer ${env.SLACK_BOT_TOKEN}`;
    } else if (provider === 'anthropic') {
      if (!env.ANTHROPIC_API_KEY) return { provider, status: 'unconfigured' };
      url = 'https://api.anthropic.com/v1/models?limit=100';
      headers['x-api-key'] = env.ANTHROPIC_API_KEY;
      headers['anthropic-version'] = '2023-06-01';
    } else if (provider === 'deepgram') {
      if (!env.DEEPGRAM_API_KEY) return { provider,
        status: env.NOGITA_REALTIME_AUDIO_ENABLED === 'true' ? 'unconfigured' : 'not_required' };
      url = 'https://api.deepgram.com/v1/auth/token';
      headers.Authorization = `Token ${env.DEEPGRAM_API_KEY}`;
    } else {
      if (!env.ATTENDEE_API_KEY) return { provider, status: 'unconfigured' };
      url = 'https://app.attendee.dev/api/v1/bots';
      headers.Authorization = `Token ${env.ATTENDEE_API_KEY}`;
    }
    const started = performance.now();
    try {
      const response = await http(url, { method: provider === 'slack' ? 'POST' : 'GET', headers,
        redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (provider === 'slack' && response.ok) {
        let authenticated = false;
        try {
          const payload = await response.json() as unknown;
          authenticated = Boolean(payload && typeof payload === 'object' &&
            (payload as Record<string, unknown>).ok === true);
        } catch { /* Malformed provider data is a failed probe; do not expose it. */ }
        return { provider, status: authenticated ? 'connected' : 'failed', httpStatus: response.status,
          durationMs: Math.round(performance.now() - started) };
      }
      if (provider === 'anthropic' && response.ok) {
        let modelAvailable = false;
        try {
          const payload = await response.json() as unknown;
          const data = payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data)
            ? (payload as { data: unknown[] }).data : [];
          const models = [env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL];
          // The conversational agent model must be available too whenever live mode uses it.
          if (env.NOGITA_MODE === 'live' && env.NOGITA_AGENT !== 'off') {
            models.push(env.ANTHROPIC_AGENT_MODEL?.trim() || DEFAULT_ANTHROPIC_AGENT_MODEL);
            if (env.NOGITA_MODEL_ROUTING === 'true') {
              models.push(env.ANTHROPIC_ROUTING_MODEL?.trim() || '');
            }
          }
          modelAvailable = models.every(model => data.some(item => item && typeof item === 'object' &&
            (item as Record<string, unknown>).id === model));
        } catch { /* Malformed provider data is a failed probe; do not expose it. */ }
        return { provider, status: modelAvailable ? 'connected' : 'failed', httpStatus: response.status,
          durationMs: Math.round(performance.now() - started) };
      }
      await response.body?.cancel();
      return { provider, status: response.ok ? 'connected' : 'failed', httpStatus: response.status,
        durationMs: Math.round(performance.now() - started) };
    } catch {
      return { provider, status: 'unreachable', durationMs: Math.round(performance.now() - started) };
    }
  }));
  return { ok: checks.every(check => check.status === 'connected' || check.status === 'not_required'), checks };
}
