/**
 * A small stateful Jira Cloud for conformance tests: create, the JQL search shapes JiraBoard sends, read one issue, and
 * assignable-user search. It answers from what was created, so search and read are checked against real writes.
 */
interface Issue { key: string; project: string; summary: string; description: string; status: string; assignee?: string;
  updated: number; digest?: string }

export function jiraFake(people: Array<{ accountId: string; displayName: string }>, initialStatus = 'To Do'): typeof fetch {
  const issues: Issue[] = [];
  let clock = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const view = (issue: Issue) => ({ key: issue.key, fields: {
    summary: issue.summary, status: { name: issue.status }, issuetype: { name: 'Task' }, priority: null,
    assignee: issue.assignee ? { displayName: people.find(p => p.accountId === issue.assignee)?.displayName ?? issue.assignee } : null,
    updated: new Date(issue.updated * 1000).toISOString(), created: new Date(issue.updated * 1000).toISOString(), reporter: null,
    description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: issue.description }] }] },
    comment: { comments: [] } },
    properties: issue.digest ? { 'com.nogita.request.v1': { digest: issue.digest } } : {} });

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname === '/rest/api/3/issue' && init?.method === 'POST') {
      const fields = body.fields as { project: { key: string }; summary: string; description: { content?: Array<{ content?: Array<{ text?: string }> }> };
        assignee?: { accountId: string } };
      const project = fields.project.key;
      const key = `${project}-${issues.filter(issue => issue.project === project).length + 1}`;
      const digest = (body.properties as Array<{ value: { digest: string } }> | undefined)?.[0]?.value.digest;
      issues.push({ key, project, summary: fields.summary, description: fields.description.content?.[0]?.content?.[0]?.text ?? '',
        status: initialStatus, assignee: fields.assignee?.accountId, updated: ++clock, digest });
      return json({ key }, 201);
    }
    if (url.pathname === '/rest/api/3/search/jql') {
      const jql = String(body.jql);
      const projects = [...(jql.match(/project (?:in \(([^)]*)\)|= "([^"]+)")/) ?? [])].slice(1).filter(Boolean).join(',')
        .split(',').map(item => item.trim().replace(/"/g, '')).filter(Boolean);
      const text = jql.match(/text ~ "([^"]*)"/)?.[1]?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const status = jql.match(/status = "([^"]*)"/)?.[1]?.toLowerCase();
      const assignee = jql.match(/assignee = "([^"]*)"/)?.[1];
      const empty = /assignee is EMPTY/.test(jql);
      const found = issues.filter(issue => !projects.length || projects.includes(issue.project))
        .filter(issue => text.every(word => `${issue.summary} ${issue.description}`.toLowerCase().includes(word)))
        .filter(issue => !status || issue.status.toLowerCase() === status)
        .filter(issue => empty ? !issue.assignee : !assignee || issue.assignee === assignee)
        .sort((a, b) => b.updated - a.updated).slice(0, Number(body.maxResults ?? 50));
      return json({ issues: found.map(view) });
    }
    const one = url.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)$/);
    if (one && (init?.method ?? 'GET') === 'GET') {
      const issue = issues.find(item => item.key === decodeURIComponent(one[1]!));
      return issue ? json(view(issue)) : json({ errorMessages: ['Issue does not exist'] }, 404);
    }
    if (url.pathname === '/rest/api/3/user/assignable/search') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      return json(people.filter(person => person.displayName.toLowerCase().includes(query))
        .map(person => ({ ...person, active: true, accountType: 'atlassian' })));
    }
    return json({ errorMessages: [`fake has no ${init?.method ?? 'GET'} ${url.pathname}`] }, 404);
  }) as typeof fetch;
}
