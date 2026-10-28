import test from 'node:test';
import assert from 'node:assert/strict';
import { NogitaEngine, type NogitaEngineOptions } from '../src/core/engine.ts';
import { AllowlistPolicy, directlyAddressesNogita, isExplicitCreateRequest, removeAddress } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { CodeLookupRateLimitError, SpeechFallbackSentError, type BrainPort, type CodePort, type Plan, type UsagePort } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const engineer = { id: 'engineer', displayName: 'Engineer', verified: true };
function fixture(brain: BrainPort = new DemoBrain(), timing: NogitaEngineOptions = {}, code: CodePort = new DemoCode()) {
  const meeting = new DemoMeeting('m');
  const board = new DemoBoard();
  const engine = new NogitaEngine({ board, code, brain, policy: new AllowlistPolicy(new Set(['lead'])) }, timing);
  const utter = (text: string, eventId: string, actor = lead) => engine.onUtterance('s', { text, eventId, actor });
  return { engine, meeting, board, utter };
}

class SpeechFailingMeeting extends DemoMeeting {
  override async speak(_message: string): Promise<void> { throw new Error('tts unavailable'); }
}
class MirroredSpeechFailingMeeting extends DemoMeeting {
  override async speak(message: string): Promise<void> {
    await this.sendStatus(message);
    throw new SpeechFallbackSentError();
  }
}

test('activation: direct name address only', () => {
  for (const text of ['Nogita, hello', 'Hey Nogita, check', 'Nogita what do you think?']) assert.equal(directlyAddressesNogita(text), true);
  for (const text of ['We talked about Nogita', 'Rename Nogita today', 'NogitaBot', 'That is a great idea']) assert.equal(directlyAddressesNogita(text), false);
});
test('sentence-later and second-person vocatives wake Nogita without waking third-person mentions', () => {
  assert.equal(directlyAddressesNogita('Let’s do them both. Nogita, explain the repository.'), true);
  assert.equal(removeAddress('Let’s do them both. Nogita, explain the repository.'),
    'explain the repository.');
  assert.equal(directlyAddressesNogita('How are you Nogita today?'), true);
  assert.equal(directlyAddressesNogita('I told you Nogita was in the meeting.'), false);
  assert.equal(directlyAddressesNogita('We talked about Nogita. She helped.'), false);
  assert.equal(directlyAddressesNogita('We finished. Nogita was helpful today.'), false);
  assert.equal(directlyAddressesNogita('Nogita was helpful today.'), false);
  assert.equal(removeAddress('We finished. Nogita was helpful. Nogita, explain this.'), 'explain this.');
  assert.equal(directlyAddressesNogita('How are you, Nogita, today?'), true);
});
test('no speech without name; relevant concern only raises hand', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('The release is tomorrow.', '1'), 'ignored');
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 0);
  assert.equal(await f.utter('This seems like a critical security risk.', '2'), 'raised_hand');
  assert.equal(f.meeting.events.filter(e => e.type === 'raise_hand').length, 1);
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 0);
});
test('only explicitly addressed response may produce speech', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, hello there', '1'), 'answered');
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 1);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 0);
});
test('verified affirmative follow-up continues Nogita’s recent read-only question once', async () => {
  const calls: Array<{ current: string; context: readonly string[] }> = [];
  const brain: BrainPort = {
    plan: async (current, context): Promise<Plan> => {
      calls.push({ current, context: [...context] });
      return calls.length === 1
        ? { kind: 'answer', message: 'Would you like the detailed answer?' }
        : { kind: 'answer', message: 'The detailed answer is available now.' };
    },
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const f = fixture(brain); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, explain the plan', 'first'), 'answered');
  assert.equal(await f.utter('Yes, please.', 'reply'), 'answered');
  assert.match(f.meeting.events.filter(event => event.type === 'chat').at(-1)?.text ?? '',
    /heard your reply.*continuing/i);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.current, 'Yes, please.');
  assert.ok(calls[1]?.context.some(line => line.includes('Nogita: Would you like the detailed answer?')));
  assert.equal(await f.utter('Yes, please.', 'repeat'), 'ignored');
  assert.equal(calls.length, 2);
});
test('project-overview question searches the repository and answers without asking for permission again', async () => {
  const queries: string[] = [];
  const code: CodePort = { name: 'github', findEvidence: async query => {
    queries.push(query);
    return [{ path: 'README.md', url: 'https://github.com/example/app/blob/main/README.md', excerpt: 'Nogita is a virtual teammate.' }];
  } };
  let calls = 0;
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => {
      calls++;
      return calls === 1 ? { kind: 'answer', message: 'Should I check the repository?' }
        : { kind: 'answer', message: 'Nogita is a virtual teammate.', evidence: {
          path: 'README.md', url: 'https://github.com/example/app/blob/main/README.md', excerpt: 'Nogita is a virtual teammate.',
        }, evidenceQuote: 'Nogita is a virtual teammate.' };
    },
    answerWithEvidence: async () => 'Nogita is a virtual teammate.', suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, what is the project about?', 'repo-first'), 'completed');
  assert.equal(queries.length, 1);
  assert.equal(queries[0], 'README package.json');
  assert.match(f.meeting.events.find(event => event.type === 'speak')?.text ?? '', /virtual teammate/i);
  assert.equal(await f.utter('Yes, please.', 'repo-yes'), 'ignored');
});
test('a different speaker, stale answer, and task confirmation cannot inherit pending permission', async () => {
  let time = 1000;
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'answer', message: 'Would you like me to continue?' }),
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const f = fixture(brain, { now: () => time }); await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, explain this', 'question');
  assert.equal(await f.utter('Yes, please.', 'other-speaker', engineer), 'ignored');
  time += 90_000;
  assert.equal(await f.utter('Yes, please.', 'stale'), 'ignored');
  await f.utter('Nogita, create a task for this', 'task-question');
  assert.equal(await f.utter('Yes, please.', 'task-yes'), 'ignored');
  assert.equal(f.board.tasks.length, 0);
});
test('a same-speaker decline cancels the pending question instead of leaving a stale yes trigger', async () => {
  let calls = 0;
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => {
      calls++;
      return { kind: 'answer', message: 'Would you like me to continue?' };
    },
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const f = fixture(brain); await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, explain this', 'question');
  assert.equal(await f.utter('No, thanks.', 'decline'), 'ignored');
  assert.equal(await f.utter('Yes, please.', 'later-yes'), 'ignored');
  assert.equal(calls, 1);
});
test('speech queued before Nogita asks cannot become an answer to her later question', async () => {
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let calls = 0;
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => {
      calls++;
      if (calls === 1) { markStarted(); await gate; }
      return { kind: 'answer', message: 'Would you like me to continue?' };
    },
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const f = fixture(brain); await f.engine.startSession('s', f.meeting);
  const first = f.utter('Nogita, explain this', 'first');
  await started;
  const prematureYes = f.utter('Yes, please.', 'before-question');
  releaseFirst();
  assert.equal(await first, 'answered');
  assert.equal(await prematureYes, 'ignored');
  assert.equal(calls, 1);
});
test('verified participant named Nogita remains a user in model context', async () => {
  let roles: string[] = [];
  const brain: BrainPort = {
    plan: async (_current, _history, _usage, _evidence, conversation): Promise<Plan> => {
      roles = conversation?.map(turn => turn.role) ?? [];
      return { kind: 'answer', message: 'Okay.' };
    },
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const f = fixture(brain); await f.engine.startSession('s', f.meeting);
  const sameName = { id: 'lead', displayName: 'Nogita', verified: true };
  await f.utter('Nogita, first question', 'first', sameName);
  await f.utter('Nogita, second question', 'second', sameName);
  assert.deepEqual(roles, ['user', 'assistant']);
});
test('spoken answer falls back to meeting chat when TTS fails', async () => {
  const meeting = new SpeechFailingMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['lead'])) });
  await engine.startSession('s', meeting);
  assert.equal(await engine.onUtterance('s', { text: 'Nogita, what time is it?', eventId: 'answer-fallback', actor: lead }), 'answered');
  assert.deepEqual(meeting.events.filter(e => e.type === 'chat').map(e => e.text),
    ["I'm here. You asked: what time is it?"]);
});
test('engine does not duplicate a chat fallback already sent before asynchronous TTS failed', async () => {
  const meeting = new MirroredSpeechFailingMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['lead'])) });
  await engine.startSession('s', meeting);
  await engine.onUtterance('s', { text: 'Nogita, what time is it?', eventId: 'mirrored-fallback', actor: lead });
  assert.equal(meeting.events.filter(e => e.type === 'chat').length, 1);
});
test('task acknowledgement falls back to chat and task is still created once', async () => {
  const meeting = new SpeechFailingMeeting('m'); const board = new DemoBoard();
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['lead'])) });
  await engine.startSession('s', meeting);
  assert.equal(await engine.onUtterance('s', { text: 'Nogita, create a task to fix voice', eventId: 'task-fallback', actor: lead }), 'completed');
  assert.equal(board.tasks.length, 1);
  assert.match(meeting.events.filter(e => e.type === 'chat')[0]?.text ?? '', /I will create the task/);
  assert.match(meeting.events.filter(e => e.type === 'chat')[1]?.text ?? '', /DEMO-1/);
});
test('engine reports TTS failures and completed external actions to usage accounting', async () => {
  const meeting = new SpeechFailingMeeting('m'); const board = new DemoBoard();
  const events: Array<{ kind: string; success?: boolean; action?: string }> = [];
  const usage: UsagePort = {
    recordTts: (_sessionId, success) => { events.push({ kind: 'tts', success }); },
    recordExternalAction: (_sessionId, action) => { events.push({ kind: 'action', action }); },
  };
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(), usage,
    policy: new AllowlistPolicy(new Set(['lead'])) });
  await engine.startSession('s', meeting);
  await engine.onUtterance('s', { text: 'Nogita, create a task to track usage', eventId: 'usage-task', actor: lead });
  assert.deepEqual(events, [
    { kind: 'tts', success: false },
    { kind: 'action', action: 'create_task' },
  ]);
});
test('create task -> short spoken acknowledgement and completed chat receipt', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, create a task to check authentication refresh tokens', '1'), 'completed');
  assert.equal(f.board.tasks.length, 1);
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 1);
  const receipt = f.meeting.events.find(e => e.type === 'chat');
  assert.match(receipt?.text ?? '', /DEMO-1/);
});
test('guard prohibits model-initiated writes despite plan', async () => {
  const malicious: BrainPort = { plan: async (): Promise<Plan> => ({ kind: 'create_task', title: 'wrong', description: 'wrong' }),
    answerWithEvidence: async () => '', suggestContribution: async () => false };
  const f = fixture(malicious); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, what is our timeline?', '1'), 'denied');
  assert.equal(f.board.tasks.length, 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 0);
});
test('unverified and unauthorized actor can never create task', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, create a task for security review', '1', engineer), 'denied');
  assert.equal(await f.utter('Nogita, create a task for security review', '2', { ...lead, verified: false }), 'ignored');
  assert.equal(f.board.tasks.length, 0);
});
test('replayed event does not duplicate external task', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, create a task for tests', '1');
  assert.equal(await f.utter('Nogita, create a task for tests', '1'), 'ignored');
  assert.equal(f.board.tasks.length, 1);
});
test('code evidence returns spoken grounded answer plus reference receipt', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, how is auth implemented in the repo?', '1'), 'completed');
  assert.equal(f.board.tasks.length, 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'speak').length, 1);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 1);
});
test('repository evidence is supplied before planning so grounded code answers use one model call', async () => {
  const order: string[] = [];
  const evidence = [{ path: 'src/session.ts', url: 'https://github.com/example/app/blob/main/src/session.ts',
    excerpt: 'session.refresh() runs before expiration.' }];
  const code: CodePort = { name: 'github', findEvidence: async () => { order.push('lookup'); return evidence; } };
  const brain: BrainPort = {
    plan: async (_current, _history, _usageContext, suppliedEvidence): Promise<Plan> => {
      order.push('plan');
      assert.deepEqual(suppliedEvidence, evidence);
      return { kind: 'answer', message: 'src/session.ts refreshes the session before expiration.',
        evidence: evidence[0], evidenceQuote: 'session.refresh() runs before expiration.' };
    },
    answerWithEvidence: async () => { throw new Error('grounded answer should not need a second model call'); },
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, when does the session refresh in the repo?', 'one-call-repo-answer'), 'completed');
  assert.deepEqual(order, ['lookup', 'plan']);
  assert.equal(f.meeting.events.filter(event => event.type === 'speak').at(-1)?.text,
    'src/session.ts refreshes the session before expiration.');
  assert.match(f.meeting.events.filter(event => event.type === 'chat').at(-1)?.text ?? '', /Code reference/);
});
test('a repository answer without cited evidence is not spoken as a verified code fact', async () => {
  const code: CodePort = { name: 'github', findEvidence: async () => [] };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'answer', message: 'The repository definitely uses Salesforce.' }),
    answerWithEvidence: async () => { throw new Error('no evidence to answer from'); },
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, does our repository integrate with Salesforce?', 'uncited-repo');
  const spoken = f.meeting.events.filter(event => event.type === 'speak').map(event => event.text);
  assert.equal(spoken.some(line => line?.includes('definitely uses Salesforce')), false);
  assert.match(spoken.at(-1) ?? '', /could not find enough code evidence/i);
});
test('a repository miss discloses when large source files were not searched', async () => {
  const code: CodePort = { name: 'github', findEvidence: async () => [],
    getCoverage: () => ({ indexedFiles: 3, skippedLargeFiles: 2 }) };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'answer', message: 'I searched the whole repository and found nothing.' }),
    answerWithEvidence: async () => { throw new Error('no evidence to answer from'); },
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, is the billing handler in our repository?', 'incomplete-index');
  const spoken = f.meeting.events.filter(event => event.type === 'speak').at(-1)?.text ?? '';
  assert.match(spoken, /could not find enough code evidence/i);
  assert.match(spoken, /2 large files were not searched/i);
  assert.doesNotMatch(spoken, /whole repository/i);
});
test('a grounded repository answer discloses large files outside its indexed evidence', async () => {
  const evidence = { path: 'src/small.ts', url: 'https://github.com/example/app/blob/main/src/small.ts',
    excerpt: 'The small module calls runTask() after authorization.' };
  const code: CodePort = { name: 'github', findEvidence: async () => [evidence],
    getCoverage: () => ({ indexedFiles: 3, skippedLargeFiles: 2 }) };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'answer', message: 'The small module runs tasks after authorization.',
      evidence, evidenceQuote: 'calls runTask() after authorization' }),
    answerWithEvidence: async () => { throw new Error('grounded answer should be direct'); },
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code);
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, how do tasks run in our repository?', 'partial-grounded'), 'completed');
  assert.match(f.meeting.events.filter(event => event.type === 'speak').at(-1)?.text ?? '',
    /2 large files were not searched/i);
});
test('a GitHub rate limit gets a clear spoken status without asking the model to guess', async () => {
  let plans = 0;
  const code: CodePort = { name: 'github', findEvidence: async () => {
    throw new CodeLookupRateLimitError();
  } };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => { plans++; return { kind: 'answer', message: 'I know the whole repository.' }; },
    answerWithEvidence: async () => { throw new Error('no evidence to answer from'); },
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, how does authentication work in our repository?', 'rate-limited-code');
  assert.equal(plans, 0);
  assert.match(f.meeting.events.filter(event => event.type === 'speak').at(-1)?.text ?? '', /GitHub.*rate limit/i);
});
test('a planner-requested code lookup reports a rate limit instead of failing silently', async () => {
  const code: CodePort = { name: 'github', findEvidence: async () => {
    throw new CodeLookupRateLimitError();
  } };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'inspect_code', query: 'session refresh' }),
    answerWithEvidence: async () => { throw new Error('no evidence to answer from'); },
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code);
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, when does my session refresh?', 'rate-limited-inspection'), 'answered');
  assert.match(f.meeting.events.filter(event => event.type === 'speak').at(-1)?.text ?? '', /GitHub.*rate limit/i);
});
test('a planner-requested code lookup reports an unexpected provider failure safely', async () => {
  const code: CodePort = { name: 'github', findEvidence: async () => {
    throw new Error('PRIVATE-RESPONSE-BODY-EXAMPLE');
  } };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'inspect_code', query: 'session refresh' }),
    answerWithEvidence: async () => { throw new Error('no evidence to answer from'); },
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code);
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, when does my session refresh?', 'provider-lookup-error'), 'answered');
  const spoken = f.meeting.events.filter(event => event.type === 'speak').at(-1)?.text ?? '';
  assert.match(spoken, /could not check the repository/i);
  assert.doesNotMatch(spoken, /PRIVATE-RESPONSE-BODY/);
});
test('an unrelated citation cannot turn a fabricated repository answer into a verified fact', async () => {
  const evidence = [{ path: 'src/auth.ts', url: 'https://github.com/example/app/blob/main/src/auth.ts',
    excerpt: 'export const authenticationEnabled = true;' }];
  const code: CodePort = { name: 'github', findEvidence: async () => evidence };
  let evidenceAnswers = 0;
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'answer', message: 'The repository uses Salesforce.',
      evidence: evidence[0], evidenceQuote: 'not present in source' }),
    answerWithEvidence: async () => { evidenceAnswers++; return 'I could not verify Salesforce from src/auth.ts.'; },
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, does the repository use Salesforce?', 'wrong-citation');
  const spoken = f.meeting.events.filter(event => event.type === 'speak').map(event => event.text);
  assert.equal(spoken.includes('The repository uses Salesforce.'), false);
  assert.equal(evidenceAnswers, 1);
});
test('repository prefetch never reads code for a speaker without repository permission', async () => {
  let lookups = 0;
  const code: CodePort = { name: 'github', findEvidence: async () => { lookups++; return []; } };
  const f = fixture(new DemoBrain(), {}, code);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, how does authentication work in the repo?', 'unauthorized-read', engineer);
  assert.equal(lookups, 0);
});
test('implicit project questions require code evidence and permission', async () => {
  let lookups = 0;
  let plans = 0;
  const code: CodePort = { name: 'github', findEvidence: async () => { lookups++; return []; } };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => { plans++; return { kind: 'answer', message: 'Authentication uses Salesforce.' }; },
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code);
  await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, how does authentication work?', 'implicit-authorized'), 'answered');
  assert.equal(lookups, 1);
  assert.equal(f.meeting.events.some(event => event.text?.includes('uses Salesforce')), false);
  assert.equal(await f.utter('Nogita, how does authentication work?', 'implicit-unauthorized', engineer), 'denied');
  assert.equal(await f.utter('Nogita, how does login work?', 'implicit-login-unauthorized', engineer), 'denied');
  assert.equal(lookups, 1);
  assert.equal(plans, 1);
});
test('ordinary questions do not wait for a GitHub repository lookup', async () => {
  let lookups = 0;
  const code: CodePort = { name: 'github', findEvidence: async () => { lookups++; return []; } };
  const f = fixture(new DemoBrain(), {}, code);
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, what time is it?', 'ordinary-question');
  assert.equal(lookups, 0);
});
test('repository lookup combines the speaker question with planner-selected search terms', async () => {
  let searched = '';
  const code = { name: 'github', findEvidence: async (query: string) => {
    searched = query;
    return [{ path: 'src/auth.ts', url: 'https://github.com/example/app/src/auth.ts', excerpt: 'session.refresh()' }];
  } };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'inspect_code', query: 'session renewal token expiry' }),
    answerWithEvidence: async () => 'The session refreshes before it expires.',
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code); await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, when does account access refresh?', 'combined-code-query');
  assert.match(searched, /when does account access refresh/i);
  assert.match(searched, /session renewal token expiry/i);
});
test('fast code answers cancel the progress timer and only speak the answer', async () => {
  const scheduled: Array<{ work: () => void | Promise<void>; delay: number; canceled: boolean }> = [];
  const timing = {
    progressDelayMs: 4_500,
    schedule: (work: () => void | Promise<void>, delay: number) => {
      const timer = { work, delay, canceled: false };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer: unknown) => { (timer as { canceled: boolean }).canceled = true; },
    random: () => 0,
  };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'inspect_code', query: 'refresh session' }),
    answerWithEvidence: async () => 'The session refreshes before it expires.',
    suggestContribution: async () => false,
  };
  const f = fixture(brain, timing); await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, how does the repo refresh a session?', 'fast-code');
  assert.equal(scheduled[0]?.delay, 4_500);
  assert.equal(scheduled[0]?.canceled, true);
  assert.deepEqual(f.meeting.events.filter(event => event.type === 'speak').map(event => event.text),
    ['The session refreshes before it expires.']);
});
test('default spoken progress starts after one second of verified slow work', async () => {
  const scheduled: number[] = [];
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'answer', message: 'Hello.' }),
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const f = fixture(brain, { schedule: (work: () => void | Promise<void>, delay: number) => {
    scheduled.push(delay); return work;
  }, cancel: () => {} });
  await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, hello', 'default-progress-delay');
  assert.equal(scheduled[0], 1_000);
});
test('engine reports model roundtrip and first speech start as distinct durations', async () => {
  const stages: string[] = [];
  const usage: UsagePort = {
    recordTts: () => {}, recordExternalAction: () => {},
    recordResponseStage: (_sessionId, stage, durationMs) => {
      assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
      stages.push(stage);
    },
  };
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'answer', message: 'Hello.' }),
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const meeting = new DemoMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain,
    policy: new AllowlistPolicy(new Set(['lead'])), usage });
  await engine.startSession('s', meeting);
  await engine.onUtterance('s', { text: 'Nogita, hello', eventId: 'measured', actor: lead });
  assert.deepEqual(stages, ['model_roundtrip', 'turn_to_first_speech_attempt']);
});
test('engine retains brain usage accounting only while its meeting is active', async () => {
  const events: string[] = [];
  const brain: BrainPort = {
    beginUsageSession: sessionId => { events.push(`start:${sessionId}`); },
    endUsageSession: sessionId => { events.push(`end:${sessionId}`); },
    plan: async (): Promise<Plan> => ({ kind: 'answer', message: 'Hello.' }),
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain,
    policy: new AllowlistPolicy(new Set(['lead'])) });
  await engine.startSession('s', new DemoMeeting('m'));
  await engine.endSession('s');
  assert.deepEqual(events, ['start:s', 'end:s']);
});
test('resumed human speech cancels a pending progress phrase for the old turn', async () => {
  const scheduled: Array<{ work: () => void | Promise<void>; canceled: boolean }> = [];
  let finishPlan!: (plan: Plan) => void;
  const brain: BrainPort = {
    plan: async () => new Promise<Plan>(resolve => { finishPlan = resolve; }),
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const meeting = new DemoMeeting('m');
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new DemoCode(), brain,
    policy: new AllowlistPolicy(new Set(['lead'])) }, {
    schedule: work => { const timer = { work, canceled: false }; scheduled.push(timer); return timer; },
    cancel: handle => { (handle as { canceled: boolean }).canceled = true; },
  });
  await engine.startSession('s', meeting);
  const pending = engine.onUtterance('s', { text: 'Nogita, hello', eventId: 'resumed', actor: lead });
  while (!finishPlan) await Promise.resolve();
  engine.cancelProgressForSpeechActivity('s');
  assert.equal(scheduled[0]?.canceled, true);
  assert.equal(scheduled.length, 1);
  finishPlan({ kind: 'answer', message: 'Hello.' });
  await pending;
  assert.deepEqual(meeting.events.filter(event => event.type === 'speak').map(event => event.text), ['Hello.']);
});
test('slow code lookup says one varied progress phrase before its final answer', async () => {
  const scheduled: Array<{ work: () => void | Promise<void>; delay: number; canceled: boolean }> = [];
  const timing = {
    progressDelayMs: 4_500,
    schedule: (work: () => void | Promise<void>, delay: number) => {
      const timer = { work, delay, canceled: false };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer: unknown) => { (timer as { canceled: boolean }).canceled = true; },
    random: () => 0,
  };
  let releaseAnswer!: (answer: string) => void;
  let answerStarted!: () => void;
  const started = new Promise<void>(resolve => { answerStarted = resolve; });
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'inspect_code', query: 'refresh session' }),
    answerWithEvidence: async () => new Promise<string>(resolve => {
      releaseAnswer = resolve;
      answerStarted();
    }),
    suggestContribution: async () => false,
  };
  const f = fixture(brain, timing); await f.engine.startSession('s', f.meeting);
  const pending = f.utter('Nogita, how does the repo refresh a session?', 'slow-code');
  await started;
  assert.equal(scheduled[0]?.delay, 4_500);
  await scheduled[0]!.work();
  releaseAnswer('The session refreshes before it expires.');
  await pending;
  const spoken = f.meeting.events.filter(event => event.type === 'speak').map(event => event.text ?? '');
  assert.equal(spoken.length, 2);
  assert.match(spoken[0]!, /^(Let me|One second|Hmm|Give me|I’m|Just a sec)/);
  assert.equal(spoken[1], 'The session refreshes before it expires.');
});
test('consecutive slow requests in one meeting do not repeat the same progress phrase', async () => {
  const scheduled: Array<{ work: () => void | Promise<void>; delay: number; canceled: boolean }> = [];
  const timing = {
    progressDelayMs: 4_500,
    schedule: (work: () => void | Promise<void>, delay: number) => {
      const timer = { work, delay, canceled: false };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer: unknown) => { (timer as { canceled: boolean }).canceled = true; },
    random: () => 0,
  };
  let releaseAnswer!: (answer: string) => void;
  let answerStarted!: () => void;
  let started = new Promise<void>(resolve => { answerStarted = resolve; });
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'inspect_code', query: 'refresh session' }),
    answerWithEvidence: async () => new Promise<string>(resolve => {
      releaseAnswer = resolve;
      answerStarted();
    }),
    suggestContribution: async () => false,
  };
  const f = fixture(brain, timing); await f.engine.startSession('s', f.meeting);
  const progressLines: string[] = [];
  for (const eventId of ['slow-one', 'slow-two']) {
    const pending = f.utter('Nogita, how does the repo refresh a session?', eventId);
    await started;
    await scheduled.at(-1)!.work();
    progressLines.push(f.meeting.events.filter(event => event.type === 'speak').at(-1)?.text ?? '');
    releaseAnswer('The session refreshes before it expires.');
    await pending;
    started = new Promise<void>(resolve => { answerStarted = resolve; });
  }
  assert.notEqual(progressLines[0], progressLines[1]);
});
test('progress speech mirrored to chat by the provider is not duplicated on TTS failure', async () => {
  const scheduled: Array<{ work: () => void | Promise<void>; delay: number; canceled: boolean }> = [];
  const timing = {
    schedule: (work: () => void | Promise<void>, delay: number) => {
      const timer = { work, delay, canceled: false };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer: unknown) => { (timer as { canceled: boolean }).canceled = true; },
    random: () => 0,
  };
  const meeting = new MirroredSpeechFailingMeeting('m');
  const board = new DemoBoard();
  let releaseAnswer!: (answer: string) => void;
  let answerStarted!: () => void;
  const started = new Promise<void>(resolve => { answerStarted = resolve; });
  const brain: BrainPort = {
    plan: async (): Promise<Plan> => ({ kind: 'inspect_code', query: 'refresh session' }),
    answerWithEvidence: async () => new Promise<string>(resolve => {
      releaseAnswer = resolve;
      answerStarted();
    }),
    suggestContribution: async () => false,
  };
  const engine = new NogitaEngine({ board, code: new DemoCode(), brain,
    policy: new AllowlistPolicy(new Set(['lead'])) }, timing);
  await engine.startSession('s', meeting);
  const pending = engine.onUtterance('s', { text: 'Nogita, how does the repo refresh a session?', eventId: 'progress-fallback', actor: lead });
  await started;
  await scheduled[0]!.work();
  const progressLine = meeting.events.filter(event => event.type === 'chat').at(-1)?.text ?? '';
  releaseAnswer('The session refreshes before it expires.');
  await pending;
  const chatLines = meeting.events.filter(event => event.type === 'chat').map(event => event.text ?? '');
  assert.equal(chatLines.filter(line => line === progressLine).length, 1);
  assert.equal(new Set(chatLines).size, chatLines.length);
});
test('repository connection question performs a live code lookup instead of letting the model guess', async () => {
  const brain: BrainPort = {
    plan: async () => { throw new Error('planner must not answer repository connectivity'); },
    answerWithEvidence: async () => '', suggestContribution: async () => false,
  };
  const f = fixture(brain); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, are you connected to our repository?', 'repo-status'), 'completed');
  assert.match(f.meeting.events.find(event => event.type === 'speak')?.text ?? '', /read-only access/i);
  assert.match(f.meeting.events.find(event => event.type === 'chat')?.text ?? '', /Code reference/i);
});
test('asking what a connected repository builds is treated as a content question, not a connection check', async () => {
  let planned = false;
  const queries: string[] = [];
  const code: CodePort = { name: 'github', findEvidence: async query => {
    queries.push(query);
    return [
      { path: 'package.json', url: 'https://github.com/example/app/blob/main/package.json', excerpt: '"name":"nogita"' },
      { path: 'README.md', url: 'https://github.com/example/app/blob/main/README.md',
        excerpt: 'Nogita joins meetings and answers questions from project code.' },
      { path: 'docs/superpowers/plans/old-plan.md', url: 'https://github.com/example/app/blob/main/docs/superpowers/plans/old-plan.md',
        excerpt: 'Outdated future idea.' },
    ];
  } };
  const brain: BrainPort = {
    plan: async (_current, _history, _id, evidence) => {
      planned = true;
      assert.deepEqual(evidence?.map(item => item.path), ['README.md', 'package.json']);
      return { kind: 'answer', message: 'Nogita joins meetings and answers from project code.' };
    },
    answerWithEvidence: async () => 'Nogita joins meetings and answers from project code.',
    suggestContribution: async () => false,
  };
  const f = fixture(brain, {}, code); await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, what is the project that you connected to our repository working on?', 'project-intent');
  assert.equal(planned, true);
  assert.deepEqual(queries, ['README package.json']);
  assert.doesNotMatch(f.meeting.events.find(event => event.type === 'speak')?.text ?? '', /read-only access/i);
});
test('draft PR has an explicit not-supported response; never modifies repo', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  assert.equal(await f.utter('Nogita, create a draft PR for that bug', '1'), 'not_supported');
  assert.equal(f.board.tasks.length, 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'chat').length, 0);
});
test('meeting state purged on end, cannot accept more utterances', async () => {
  const f = fixture(); await f.engine.startSession('s', f.meeting);
  await f.utter('Nogita, hello', '1');
  await f.engine.endSession('s');
  assert.equal(f.engine.sessionCount(), 0);
  await assert.rejects(() => f.utter('Nogita, hello', '2'), /unknown session/);
});

test('provider-ended meeting purges state without sending a redundant leave command', async () => {
  const f = fixture();
  await f.engine.startSession('provider-ended', f.meeting);
  await f.engine.endSession('provider-ended', false);
  assert.equal(f.engine.sessionCount(), 0);
  assert.equal(f.meeting.events.filter(e => e.type === 'leave').length, 0);
});

test('failed provider leave keeps the session available for a later leave retry', async () => {
  const f = fixture();
  await f.engine.startSession('leave-retry', f.meeting);
  const originalLeave = f.meeting.leave.bind(f.meeting);
  let attempts = 0;
  f.meeting.leave = async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary provider failure');
    await originalLeave();
  };
  await assert.rejects(() => f.engine.endSession('leave-retry'), /temporary provider failure/);
  assert.equal(f.engine.hasSession('leave-retry'), true);
  await f.engine.endSession('leave-retry');
  assert.equal(f.engine.hasSession('leave-retry'), false);
  assert.equal(attempts, 2);
});

test('restored session accepts events without joining the provider again', async () => {
  const f = fixture();
  f.engine.restoreSession('s', f.meeting);
  assert.equal(f.engine.hasSession('s'), true);
  assert.equal(f.meeting.events.some(event => event.type === 'join'), false);
  assert.equal(await f.utter('Nogita, hello again', 'restored-event'), 'answered');
  assert.throws(() => f.engine.restoreSession('s', f.meeting), /already exists/);
});

test('concurrent starts reserve a session before provider join completes', async () => {
  const f = fixture();
  const second = new DemoMeeting('second');
  let releaseJoin!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseJoin = resolve; });
  const originalJoin = f.meeting.join.bind(f.meeting);
  f.meeting.join = async () => {
    markStarted();
    await gate;
    await originalJoin();
  };
  const first = f.engine.startSession('same-session', f.meeting);
  await started;
  await assert.rejects(() => f.engine.startSession('same-session', second), /already exists/);
  assert.equal(second.events.some(event => event.type === 'join'), false);
  releaseJoin();
  await first;
  assert.equal(f.engine.sessionCount(), 1);
});

test('failed provider join releases the session reservation for retry', async () => {
  const f = fixture();
  f.meeting.join = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(() => f.engine.startSession('retry-start', f.meeting), /provider unavailable/);
  const replacement = new DemoMeeting('replacement');
  await f.engine.startSession('retry-start', replacement);
  assert.equal(f.engine.sessionCount(), 1);
});

test('failed event processing can be retried instead of being silently discarded', async () => {
  const f = fixture();
  await f.engine.startSession('retryable', f.meeting);
  const originalSpeak = f.meeting.speak.bind(f.meeting);
  let attempts = 0;
  f.meeting.speak = async text => {
    attempts++;
    if (attempts === 1) throw new Error('temporary speech failure');
    return originalSpeak(text);
  };
  f.meeting.sendStatus = async () => { throw new Error('temporary speech failure'); };
  await assert.rejects(() => f.engine.onUtterance('retryable', {
    eventId: 'retry-event', actor: { id: 'lead', displayName: 'Lead', verified: true }, text: 'Nogita, hello',
  }), /temporary speech failure/);
  assert.equal(await f.engine.onUtterance('retryable', {
    eventId: 'retry-event', actor: { id: 'lead', displayName: 'Lead', verified: true }, text: 'Nogita, hello',
  }), 'answered');
});

test('utterances in one session are serialized so a failed rollback cannot erase a concurrent event', async () => {
  const histories: string[][] = [];
  const brain: BrainPort = {
    plan: async (_current, history): Promise<Plan> => {
      histories.push([...history]);
      return { kind: 'answer', message: 'ok' };
    },
    answerWithEvidence: async () => '',
    suggestContribution: async () => false,
  };
  const f = fixture(brain);
  await f.engine.startSession('serialized', f.meeting);
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const originalSpeak = f.meeting.speak.bind(f.meeting);
  let attempts = 0;
  f.meeting.speak = async text => {
    attempts++;
    if (attempts === 1) {
      markStarted();
      await firstGate;
      throw new Error('first event failed');
    }
    return originalSpeak(text);
  };
  f.meeting.sendStatus = async () => { throw new Error('first event failed'); };
  const first = f.engine.onUtterance('serialized', {
    eventId: 'first', actor: lead, text: 'Nogita, first',
  });
  await firstStarted;
  const second = f.engine.onUtterance('serialized', {
    eventId: 'second', actor: lead, text: 'Nogita, second',
  });
  await Promise.resolve();
  assert.equal(attempts, 1);
  releaseFirst();
  await assert.rejects(first, /first event failed/);
  assert.equal(await second, 'answered');
  assert.deepEqual(histories, [[], []]);
});

test('ending a session drains in-flight speech and refuses new utterances', async () => {
  const f = fixture();
  await f.engine.startSession('ending', f.meeting);
  let releaseSpeak!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseSpeak = resolve; });
  const originalSpeak = f.meeting.speak.bind(f.meeting);
  f.meeting.speak = async text => {
    markStarted();
    await gate;
    await originalSpeak(text);
  };
  const active = f.engine.onUtterance('ending', { eventId: 'active', actor: lead, text: 'Nogita, hello' });
  await started;
  const ending = f.engine.endSession('ending');
  await assert.rejects(() => f.engine.onUtterance('ending', {
    eventId: 'late', actor: lead, text: 'Nogita, too late',
  }), /unknown session/);
  assert.equal(f.meeting.events.some(event => event.type === 'leave'), false);
  releaseSpeak();
  assert.equal(await active, 'answered');
  await ending;
  assert.equal(f.meeting.events.at(-1)?.type, 'leave');
});
test('create task request is recognized, question not treated as request', () => {
  assert.equal(isExplicitCreateRequest('create a jira task'), true);
  assert.equal(isExplicitCreateRequest('Do we have a task about auth?'), false);
});
