import test from 'node:test';
import assert from 'node:assert/strict';
import { turnAgentPrompt } from '../src/core/agent-prompt.ts';
import { matchResearchTemplate, researchPlan } from '../src/core/research-templates.ts';

const ALL_TOOLS = ['search_code', 'read_file', 'list_files', 'recent_commits', 'repo_activity', 'get_change', 'ci_status',
  'search_tasks', 'get_task', 'create_task', 'list_channels', 'read_channel', 'search_messages', 'post_message'];
const CODE_ONLY = ['search_code', 'read_file', 'recent_commits', 'repo_activity', 'get_change'];

test('recurring questions find their template, the narrower kinds first', () => {
  const cases: Array<[string, string | undefined]> = [
    ['What went in today?', 'changes'],
    ['what did we merge this week', 'changes'],
    ["What's changed since yesterday?", 'changes'],
    ['What did Dana push yesterday?', 'changes'],
    ['Where are we with the retry worker?', 'feature_status'],
    ["What's the status of the billing migration?", 'feature_status'],
    ['Is the new login flow done?', 'feature_status'],
    ["How's the search rewrite going?", 'feature_status'],
    ['Why did the deploy fail last night?', 'incident_cause'],
    ['Why is CI red on main?', 'incident_cause'],
    ['What caused the outage on Tuesday?', 'incident_cause'],
    ['Which tasks are still open on payments?', 'open_tasks'],
    ['What open bugs do we have about the importer?', 'open_tasks'],
    ["What's left on the onboarding epic?", 'open_tasks'],
    ['What changed between 1.4 and 1.5?', 'version_diff'],
    ['Compare v2.0 with v2.1', 'version_diff'],
    ['What is new since the last release?', 'version_diff'],
    // Actions and general questions are not research.
    ['Open a task for the importer bug', undefined],
    ['Create tasks for the PRs we merged today', undefined],
    ['What does a 429 mean?', undefined],
    ['Queue or cron for reminder emails?', undefined],
  ];
  for (const [question, kind] of cases) assert.equal(matchResearchTemplate(question)?.kind, kind, question);
});

test('the period and the sources the person named come with the match', () => {
  assert.deepEqual(matchResearchTemplate('What went in today?'), { kind: 'changes', period: 'today', named: [] });
  assert.equal(matchResearchTemplate('what did we merge last week')?.period, 'last_week');
  assert.equal(matchResearchTemplate('what changed in the past 7 days')?.period, 'last_7_days');
  assert.deepEqual(matchResearchTemplate('Where are we with SSO, in Jira and on Slack?')?.named, ['board', 'chat']);
  assert.deepEqual(matchResearchTemplate('Why did the build break? Check the PRs and what was said in #dev')?.named, ['code', 'chat']);
});

test('a plan names only the tools this turn has, and crosses every connected source', () => {
  const full = researchPlan('Where are we with the retry worker?', ALL_TOOLS)!;
  assert.match(full, /^Research plan for this question \(feature status\)\. Run the independent lookups in parallel:/);
  assert.match(full, /search_tasks/);
  assert.match(full, /ci_status/);
  assert.match(full, /search_messages/);
  assert.match(full, /Answer from the repository, the board and the chat together; say which source each fact came from\./);
  assert.match(full, /When sources disagree/);

  const code = researchPlan('Where are we with the retry worker?', CODE_ONLY)!;
  assert.doesNotMatch(code, /search_tasks|search_messages|ci_status/);
  assert.doesNotMatch(code, /Answer from/);
  assert.match(code, /^1\. search_code and recent_commits/m);
});

test('the changes plan asks for one repo_activity call with the team period, and coverage of every change', () => {
  const plan = researchPlan('What went in today?', CODE_ONLY)!;
  assert.match(plan, /1\. repo_activity with period "today": one call returns every commit and merged pull request/);
  assert.match(plan, /Cover every merged pull request and every commit outside one/);
  assert.match(researchPlan('what changed recently on main', CODE_ONLY) ?? '', /the period they named/);
});

test('a source they asked about that is not connected is admitted, not skipped silently', () => {
  const plan = researchPlan('Which tasks are still open on payments, and what did Slack say?', ['search_tasks', 'get_task'])!;
  assert.match(plan, /They asked about the chat, which you cannot read here: say so in one short clause\./);
  assert.equal(researchPlan('Which tasks are still open on payments?', CODE_ONLY.filter(tool => tool !== 'search_code' && tool !== 'recent_commits')), undefined);
});

test('a voice plan stays within two rounds and keeps the full answer for chat', () => {
  const plan = researchPlan('Why did the deploy fail?', ALL_TOOLS, { voice: true })!;
  assert.match(plan, /in parallel, in at most two rounds:/);
  assert.match(plan, /Say the gist out loud; the full answer goes to chat\. Name the cause/);
});

test('the turn prompt carries the plan only when research is on and the question fits', () => {
  const base = { speaker: 'Dana', authorized: true, nowIso: '2026-11-01T09:00:00.000Z', followUp: false };
  const off = turnAgentPrompt(base);
  assert.doesNotMatch(off, /Research plan/);
  assert.equal(turnAgentPrompt({ ...base, research: { request: 'What does a 429 mean?', tools: ALL_TOOLS } }), off);
  const on = turnAgentPrompt({ ...base, research: { request: 'What changed between 1.4 and 1.5?', tools: ALL_TOOLS } });
  assert.ok(on.startsWith(off));
  assert.match(on, /Research plan for this question \(version diff\)/);
  assert.match(on, /Pin both versions to a commit or a date first/);
});
