/** The control plane's pages: plain server-rendered HTML, one form per step, nothing to install. */
import type { Company } from './store.ts';

export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function layout(title: string, body: string, notice?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e4df;--accent:#2f5bd3;--ok:#1f7a4d;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ecece8;--muted:#a0a09a;--line:#33332f;--accent:#7d9cf0;--ok:#5fc08e;--bad:#f08a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 24px}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:0 0 16px}
label{display:block;margin:10px 0 4px;font-weight:600;font-size:14px}input[type=text],input[type=email],input[type=password],select{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit}
button,.button{display:inline-block;margin-top:12px;padding:8px 14px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
button.quiet{background:transparent;color:var(--accent);border:1px solid var(--line)}button.danger{background:var(--bad)}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}
.ok{color:var(--ok);font-weight:600}.muted{color:var(--muted)}.notice{background:var(--card);border-left:4px solid var(--accent);padding:10px 14px;margin:0 0 16px;border-radius:6px}
table{width:100%;border-collapse:collapse}td{padding:6px 4px;border-top:1px solid var(--line)}code{font-size:13px}
</style></head><body><main>${notice ? `<div class="notice">${escape(notice)}</div>` : ''}${body}</main></body></html>`;
}

export function signInPage(providers: { google: boolean; microsoft: boolean }, notice?: string): string {
  const buttons = [providers.google ? '<a class="button" href="/login/google">Sign in with Google</a>' : '',
    providers.microsoft ? '<a class="button" href="/login/microsoft">Sign in with Microsoft</a>' : ''].join(' ');
  return layout('Nogita', `<h1>Nogita</h1><p class="sub">Your team's AI engineer in meetings. Sign in with your work account to set her up.</p>
<section>${buttons || '<p class="muted">No sign-in provider is set up on this control plane.</p>'}</section>`, notice);
}

export function createCompanyPage(csrf: string, email: string, notice?: string): string {
  return layout('Set up Nogita', `<h1>Set up Nogita</h1><p class="sub">Signed in as ${escape(email)}. Your company gets its own Nogita, separate from every other company.</p>
<section><form method="post" action="/app/company"><input type="hidden" name="csrf" value="${csrf}">
<label for="name">Company name</label><input id="name" name="name" type="text" required maxlength="80">
<button>Create</button></form></section><p><a href="/logout">Sign out</a></p>`, notice);
}

export interface DashboardExtras {
  jiraProjects: Record<string, Array<{ key: string; name: string }> | string>;
  githubRepositories: Record<string, Array<{ owner: string; repo: string; defaultBranch: string }> | string>;
  apps: { slack: boolean; atlassian: boolean; github: boolean };
  isAdmin: boolean;
}

export function dashboardPage(company: Company, csrf: string, extras: DashboardExtras, notice?: string): string {
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
  const saved = (value: unknown) => value ? '<span class="ok">saved</span>' : '<span class="muted">not set</span>';
  const keys = `<section><h2>1. Your vendor accounts</h2>
<p class="muted">Nogita runs on your own accounts: you pay Anthropic, Deepgram and Attendee directly, and your data goes only through them. Leave a field empty to keep what is saved.</p>
<form method="post" action="/app/keys">${hidden}
<label>Anthropic API key ${saved(company.keys.anthropic)}</label><input type="password" name="anthropic" autocomplete="off">
<label>Deepgram API key (her voice and hearing) ${saved(company.keys.deepgram)}</label><input type="password" name="deepgram" autocomplete="off">
<label>Attendee API key (joins the meetings) ${saved(company.keys.attendee)}</label><input type="password" name="attendee" autocomplete="off">
<label>Attendee webhook secret ${saved(company.keys.attendeeWebhookSecret)}</label><input type="password" name="attendeeWebhookSecret" autocomplete="off">
<label><input type="checkbox" name="privacy" ${company.meetingPrivacyReviewed ? 'checked' : ''}> We reviewed recording and transcribing our meetings, and tell participants Nogita is there</label>
<button>Save</button></form></section>`;

  const slack = company.connections.find(c => c.kind === 'slack');
  const jira = company.connections.filter(c => c.kind === 'jira');
  const github = company.connections.filter(c => c.kind === 'github');
  const disconnect = (id: string) => `<form method="post" action="/app/disconnect" style="display:inline">${hidden}<input type="hidden" name="connection" value="${escape(id)}"><button class="quiet">Disconnect</button></form>`;
  const jiraRows = jira.map(c => {
    if (c.kind !== 'jira') return '';
    const projects = extras.jiraProjects[c.id];
    const picker = typeof projects === 'string' ? `<span class="muted">${escape(projects)}</span>`
      : `<form method="post" action="/app/jira">${hidden}<input type="hidden" name="connection" value="${escape(c.id)}">
<label>New tasks go to</label><select name="project">${(projects ?? []).map(p => `<option value="${escape(p.key)}" ${p.key === c.projectKey ? 'selected' : ''}>${escape(p.name)} (${escape(p.key)})</option>`).join('')}</select>
<label>She can also read</label>${(projects ?? []).map(p => `<label class="muted" style="font-weight:400"><input type="checkbox" name="read" value="${escape(p.key)}" ${c.readProjectKeys?.includes(p.key) ? 'checked' : ''}> ${escape(p.name)}</label>`).join('')}
<button>Save</button></form>`;
    return `<div class="row"><div><b>Jira</b> · ${escape(c.siteName)} ${c.projectKey ? `<span class="ok">→ ${escape(c.projectKey)}</span>` : '<span class="muted">pick a project</span>'}</div>${disconnect(c.id)}</div>${picker}`;
  }).join('');
  const githubRows = github.map(c => {
    if (c.kind !== 'github') return '';
    const repos = extras.githubRepositories[c.id];
    const chosen = new Set(c.repositories.map(r => `${r.owner}/${r.repo}`));
    const picker = typeof repos === 'string' ? `<span class="muted">${escape(repos)}</span>`
      : `<form method="post" action="/app/repos">${hidden}<input type="hidden" name="connection" value="${escape(c.id)}">
${(repos ?? []).map(r => `<label class="muted" style="font-weight:400"><input type="checkbox" name="repo" value="${escape(`${r.owner}/${r.repo}@${r.defaultBranch}`)}" ${chosen.has(`${r.owner}/${r.repo}`) ? 'checked' : ''}> ${escape(r.owner)}/${escape(r.repo)}</label>`).join('')}
<button>Save</button></form>`;
    return `<div class="row"><div><b>GitHub</b> · ${escape(c.account)} <span class="muted">${c.repositories.length} repositories</span></div>${disconnect(c.id)}</div>${picker}`;
  }).join('');
  const tools = `<section><h2>2. Your tools</h2>
<div class="row"><div><b>Slack</b> ${slack?.kind === 'slack' ? `· <span class="ok">${escape(slack.teamName)}</span>` : ''}</div>${slack ? disconnect(slack.id)
    : extras.apps.slack ? '<a class="button" href="/connect/slack">Add to Slack</a>' : '<span class="muted">not available</span>'}</div>
${jiraRows}<div class="row"><div><b>Jira</b> <span class="muted">${jira.length ? 'add another site' : ''}</span></div>${extras.apps.atlassian ? '<a class="button" href="/connect/atlassian">Connect Jira</a>' : '<span class="muted">not available</span>'}</div>
${githubRows}<div class="row"><div><b>GitHub</b> <span class="muted">read-only, the repositories you pick</span></div>${extras.apps.github ? '<a class="button" href="/connect/github">Install GitHub App</a>' : '<span class="muted">not available</span>'}</div>
</section>`;

  const people = `<section><h2>3. People</h2>
<p class="muted">Matched by email across your tools. Only the people you tick may ask Nogita to change things (create tasks, read code); everyone can talk to her.</p>
${slack ? `<form method="post" action="/app/people/sync">${hidden}<button class="quiet">Import from Slack</button></form>` : '<p class="muted">Connect Slack to import your team.</p>'}
<form method="post" action="/app/people">${hidden}<table>${company.people.map(p => `<tr><td><label style="margin:0;font-weight:400"><input type="checkbox" name="authorized" value="${escape(p.id)}" ${p.authorized ? 'checked' : ''}> ${escape(p.displayName)}</label></td><td class="muted">${escape(p.email)}</td><td class="muted">${p.slack ? 'Slack' : ''}</td></tr>`).join('')}</table>
<button>Save</button></form></section>`;

  const cell = company.cell;
  const run = `<section><h2>4. Start Nogita</h2>
${cell ? `<p>Status: <b class="${cell.status === 'live' ? 'ok' : ''}">${escape(cell.status)}</b> · <a href="${escape(cell.url)}/health">${escape(cell.url)}</a></p>
<p class="muted">After changing anything above, send it to her.</p>` : '<p class="muted">She runs on her own server with her own disk and keys, apart from every other company. It takes a few minutes.</p>'}
<form method="post" action="/app/cell">${hidden}<button>${cell ? 'Update Nogita' : 'Start Nogita'}</button></form>
${company.keys.attendee ? `<p class="muted">In your Attendee project, set the webhook secret above; Nogita sets the webhook address for each meeting herself.</p>` : ''}
</section>`;

  const members = extras.isAdmin ? `<section><h2>Admins and members</h2><table>${company.members.map(m => `<tr><td>${escape(m.email)}</td><td class="muted">${m.role}</td></tr>`).join('')}</table>
<form method="post" action="/app/members">${hidden}<label>Add someone who can open this page</label><input type="email" name="email" required>
<label><input type="checkbox" name="admin"> Admin (can change settings)</label><button class="quiet">Add</button></form></section>
<section><h2>Delete</h2><p class="muted">Removes her server and disk, disconnects Slack and GitHub, and deletes every key and token we hold. It cannot be undone.</p>
<form method="post" action="/app/delete" onsubmit="return confirm('Delete ${escape(company.name)} and everything Nogita holds for it?')">${hidden}<button class="danger">Delete ${escape(company.name)}</button></form></section>` : '';

  return layout(`Nogita · ${company.name}`, `<h1>${escape(company.name)}</h1><p class="sub">Your own Nogita. <a href="/logout">Sign out</a></p>
${extras.isAdmin ? keys + tools + people + run : `${run.replace(/<form[\s\S]*?<\/form>/, '')}<p class="muted">Ask an admin to change settings.</p>`}${members}`, notice);
}
