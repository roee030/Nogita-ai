export async function probeConnections(env: NodeJS.ProcessEnv, http: typeof fetch = fetch) {
  const checks = await Promise.all(['github', 'jira', 'attendee'].map(async provider => {
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
      const base = new URL(env.JIRA_BASE_URL);
      if (base.protocol !== 'https:' || !base.hostname.endsWith('.atlassian.net'))
        return { provider, status: 'invalid_configuration' };
      url = `${base.origin}/rest/api/3/project/${encodeURIComponent(env.JIRA_PROJECT_KEY)}`;
      headers.Authorization = `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}`;
    } else {
      if (!env.ATTENDEE_API_KEY) return { provider, status: 'unconfigured' };
      url = 'https://app.attendee.dev/api/v1/bots';
      headers.Authorization = `Token ${env.ATTENDEE_API_KEY}`;
    }
    const started = performance.now();
    try {
      const response = await http(url, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
      await response.body?.cancel();
      return { provider, status: response.ok ? 'connected' : 'failed', httpStatus: response.status,
        durationMs: Math.round(performance.now() - started) };
    } catch {
      return { provider, status: 'unreachable', durationMs: Math.round(performance.now() - started) };
    }
  }));
  return { ok: checks.every(check => check.status === 'connected'), checks };
}
