import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolbox, requestsTaskWrite } from '../src/core/agent-tools.ts';
import { requestedTaskCount } from '../src/core/completion-gate.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoCode } from '../src/adapters/demo.ts';

/** What meeting transcripts actually gave (the 100-case eval), and close variants. */
const NOISY_ASKS = [
  'Nogita open three tusks one for cash invalidation one for jira retries and one for the voice lab read me',
  'Nogita, um, can you open, uh, two tasks, one for the, the cache headers and one for, um, the retry backoff.',
  'Nogita, תפתחי משימה about the Slack token refresh.',
  'נוגיטה, תפתחי שתי משימות על הקאש',
  'open a tusk for the retry worker',
  'can you, uh, log a, a bug for the crash',
  'please create a tiket for the export',
];

/** Must stay refused: questions, talk about tasks, other work, and a misheard noun with no ask. */
const NOT_ASKS = [
  'what are the open, uh, issues?',
  'um, any open tasks for Dana?',
  'did Dana open a, a ticket for that?',
  'what are the tusks on the board?',
  'add tests for the parser',
  'open the, uh, the door please',
  'כמה משימות פתוחות יש?',
  'the tusks are in the backlog',
  'prepare a PR',
];

test('with noisy on, task requests through fillers, a misheard noun or Hebrew pass the explicit-request check', () => {
  for (const text of NOISY_ASKS) {
    assert.equal(requestsTaskWrite(text, { noisy: true }), true, text);
    assert.equal(requestsTaskWrite(text), false, `strict as before: ${text}`);
  }
});

test('with noisy on, questions and other words still do not pass', () => {
  for (const text of NOT_ASKS) assert.equal(requestsTaskWrite(text, { noisy: true }), false, text);
});

test('noisy changes nothing that already passed', () => {
  for (const text of ['open a task for Moshe', 'can you log a bug for this', 'add it to the backlog', 'create tickets for both',
    'and open one for me to write tests for the Slack socket reconnect.', 'write that up'])
    assert.equal(requestsTaskWrite(text, { noisy: true }), true, text);
  // The completion gate's count is untouched (it reads requests itself, strictly).
  assert.equal(requestedTaskCount('open three tusks one for cash'), undefined);
  assert.equal(requestedTaskCount('פתחי חמש משימות'), 5);
});

test('the toolbox lets the "tusks" request create tasks only with the flag', async () => {
  for (const noisyTaskRequests of [true, false]) {
    const board = new DemoBoard();
    const { toolbox } = buildToolbox({ actor: { id: 'roee', displayName: 'Roee', verified: true }, request: NOISY_ASKS[0]!,
      sessionId: 's', eventId: `e-${noisyTaskRequests}`, policy: new AllowlistPolicy(new Set(['roee'])), code: new DemoCode(), board,
      completed: new Map(), onReceipt: async () => undefined, noisyTaskRequests });
    const outcome = await toolbox.run('create_task', { title: 'Cache invalidation', description: 'Asked in the meeting.' });
    assert.equal(board.tasks.length, noisyTaskRequests ? 1 : 0, `noisy=${noisyTaskRequests}: ${outcome.content}`);
  }
});
