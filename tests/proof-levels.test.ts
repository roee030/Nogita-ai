import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type AgentContent, type AgentToolbox, type ChatModel, type ChatModelRequest,
  type ChatModelResponse, type ToolOutcome } from '../src/core/agent.ts';
import { stableAgentPrompt } from '../src/core/agent-prompt.ts';
import { checkProofLevels, EvidenceLedger, proofCeiling } from '../src/core/evidence.ts';

/** Results in the shapes the toolbox returns them. */
const RESULTS: Record<string, string> = {
  get_task: 'KAN-12: Retry worker drops jobs\nStatus: In Progress\nLink: https://acme.atlassian.net/browse/KAN-12',
  read_plan: 'docs/WORK_PLAN.md (lines 80-90 of 200)\nhttps://github.com/acme/app/blob/main/docs/WORK_PLAN.md\n87: retry backoff',
  read_code: 'src/core/retry.ts (lines 10-40 of 300)\nhttps://github.com/acme/app/blob/main/src/core/retry.ts\n10: export function backoff() {',
  read_test: 'tests/retry.test.ts (lines 1-30 of 60)\nhttps://github.com/acme/app/blob/main/tests/retry.test.ts\n1: import test',
  read_lab: 'docs/VOICE_LAB.md (lines 1-20 of 90)\nhttps://github.com/acme/app/blob/main/docs/VOICE_LAB.md\n1: # Voice lab',
  read_meeting: 'docs/MEETING_READINESS.md (lines 1-20 of 90)\nhttps://github.com/acme/app/blob/main/docs/MEETING_READINESS.md\n1: # Meeting',
  ci_green: ['acme/app, CI for branch main, read live.', '', 'Runs (newest first):',
    '- CI: success on abc1234 (main), push https://github.com/acme/app/actions/runs/9001', '',
    'Deployed: abc1234 to production (success, 2026-10-31T12:00:00Z) https://app.acme.dev.',
    'The deployment is the head of main.'].join('\n'),
  ci_red: ['acme/app, CI for branch main, read live.', '', 'Runs (newest first):',
    '- CI: failure on def5678 (main), push https://github.com/acme/app/actions/runs/9002', '',
    'No deployment is recorded on GitHub, so what is deployed is unknown.'].join('\n'),
  ci_failed_deploy: ['acme/app, CI for branch main, read live.', '',
    'Deployed: abc1234 to production (failure, 2026-10-31T12:00:00Z).'].join('\n'),
};

function ledgerOf(...tools: string[]): EvidenceLedger {
  const ledger = new EvidenceLedger();
  for (const [step, tool] of tools.entries()) ledger.record(tool, {}, RESULTS[tool]!, step);
  return ledger;
}

test('each kind of source reaches its own level', () => {
  const ledger = ledgerOf(...Object.keys(RESULTS));
  assert.deepEqual(ledger.list().map(source => `${source.label}: ${proofCeiling(source) ?? 'none'}`), [
    'KAN-12: planned',
    'docs/WORK_PLAN.md:80-90: planned',
    'src/core/retry.ts:10-40: in_code',
    'tests/retry.test.ts:1-30: tested',
    'docs/VOICE_LAB.md:1-20: voice_lab',
    'docs/MEETING_READINESS.md:1-20: meeting',
    'CI run 9001: tested',
    'deployment abc1234 to production: production',
    'CI run 9002: in_code',
    // The same commit and environment, so the failed deployment is the source already recorded.
  ]);
  const failed = new EvidenceLedger().record('ci_status', {}, RESULTS.ci_failed_deploy!, 0);
  assert.deepEqual(failed.map(source => [source.kind, proofCeiling(source)]), [['deployment', undefined]]);
});

test('a claimed level its sources reach is spelled out with what is not shown yet', () => {
  const ledger = ledgerOf('read_code', 'ci_green');
  const { text, proof } = checkProofLevels('Backoff is in and CI is green [S2].\nProof: tested [S1, S2]', ledger);
  assert.equal(text, 'Backoff is in and CI is green [S2].\nProof level: passed tests [S1, S2]. ' +
    'Not shown yet: passed the voice lab, tried in a meeting, works in production.');
  assert.deepEqual(proof, { claimed: 'tested', shown: 'tested', unsupportedProduction: false });
});

test('a claim above what the cited sources reach is lowered to it', () => {
  const ledger = ledgerOf('read_plan', 'read_code', 'ci_red');
  const { text, proof } = checkProofLevels('The backoff fix is done.\n**Proof:** production [S2, S3]', ledger);
  assert.match(text, /Proof level: exists in code \[S2, S3\]\. Not shown yet: passed tests, /);
  assert.deepEqual(proof, { claimed: 'production', shown: 'in_code', unsupportedProduction: false });
  // Production needs the deployment itself cited, even when another source in the ledger reaches it.
  const deployed = ledgerOf('read_code', 'ci_green');
  assert.equal(checkProofLevels('Proof: works in production [S1]', deployed).proof.shown, 'in_code');
  assert.equal(checkProofLevels('Proof: works in production [S3]', deployed).text, 'Proof level: works in production [S3].');
  // Marks the ledger does not know show nothing.
  assert.equal(checkProofLevels('Proof: tested [S9]', deployed).text, 'Proof level: not shown by any source I found.');
});

test('a production claim in the prose without a deployment is marked; negations and shown deployments are left', () => {
  const none = ledgerOf('read_code', 'ci_red');
  const marked = checkProofLevels('The retry fix works in production now. It lives in retry.ts [S1].', none);
  assert.equal(marked.text, 'The retry fix works in production now (not shown: no deployment was found). It lives in retry.ts [S1].');
  assert.equal(marked.proof.unsupportedProduction, true);
  for (const honest of ['It is not deployed to production yet.', "It isn't live in prod.", 'I could not tell whether it runs in production.']) {
    assert.deepEqual(checkProofLevels(honest, none), { text: honest, proof: { unsupportedProduction: false } });
  }
  const shown = ledgerOf('ci_green');
  assert.equal(checkProofLevels('The fix is live in production [S3].', shown).text, 'The fix is live in production [S3].');
});

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  private index = 0;
  constructor(private readonly steps: Step[]) {}
  async streamChat(request: ChatModelRequest): Promise<ChatModelResponse> {
    this.requests.push({ ...request, messages: request.messages.slice() });
    const step = this.steps[this.index++] ?? { text: '' };
    const content: AgentContent[] = step.text ? [{ type: 'text', text: step.text }] : [];
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}
const toolbox: AgentToolbox = {
  specs: Object.keys(RESULTS).map(name => ({ name, description: '', input_schema: { type: 'object' } })),
  isWrite: () => false,
  run: async (name): Promise<ToolOutcome> => ({ content: RESULTS[name] ?? '' }),
};
const steps = (answer: string): Step[] => [
  { tools: [{ name: 'read_code', input: {} }, { name: 'ci_red', input: {} }] },
  { text: answer },
];
const ANSWER = 'Backoff is in retry.ts [S1] and works in production.\nProof: production [S1, S2]';

test('on, in chat: the model is told to name the level, and the answer is checked before its sources are linked', async () => {
  const model = new ScriptedModel(steps(ANSWER));
  const result = await runAgent(model, { stableSystem: '', turnSystem: 'turn', stream: false, toolbox,
    evidenceLedger: true, proofLevels: true, messages: [{ role: 'user', content: 'does the backoff work?' }] });
  assert.match(model.requests[1]!.turnSystem, /end the answer with one line "Proof: <level> \[S1\]"/);
  assert.equal(result.answer, 'Backoff is in retry.ts [1] and works in production (not shown: no deployment was found).\n' +
    'Proof level: exists in code [1, 2]. Not shown yet: passed tests, passed the voice lab, tried in a meeting, works in production.' +
    '\n\nSources:\n[1] src/core/retry.ts:10-40 https://github.com/acme/app/blob/main/src/core/retry.ts\n' +
    '[2] CI run 9002 https://github.com/acme/app/actions/runs/9002');
  assert.deepEqual(result.evidence!.proof, { claimed: 'production', shown: 'in_code', unsupportedProduction: true });
});

test('off, or in a voice turn: the answer is not checked and the model is not told to name a level', async () => {
  const off = new ScriptedModel(steps(ANSWER));
  const plain = await runAgent(off, { stableSystem: '', turnSystem: 'turn', stream: false, toolbox, evidenceLedger: true,
    messages: [{ role: 'user', content: 'does the backoff work?' }] });
  assert.doesNotMatch(off.requests[1]!.turnSystem, /Proof:/);
  assert.match(plain.answer, /^Backoff is in retry\.ts \[1\] and works in production\.\nProof: production \[1, 2\]/);
  assert.equal(plain.evidence!.proof, undefined);

  const voice = new ScriptedModel(steps('Yep, the backoff is in.'));
  const spoken: string[] = [];
  const said = await runAgent(voice, { stableSystem: '', turnSystem: 'turn', stream: false, toolbox, evidenceLedger: true,
    proofLevels: true, onSpeech: text => spoken.push(text), messages: [{ role: 'user', content: 'does the backoff work?' }] });
  assert.equal(voice.requests[1]!.turnSystem, 'turn');
  assert.equal(said.answer, 'Yep, the backoff is in.');
  assert.deepEqual(spoken, ['Yep, the backoff is in.']);
  assert.equal(said.evidence!.proof, undefined);
});

test('the stable prompt forbids an unshown production claim only when on, and keeps levels out of speech', () => {
  assert.doesNotMatch(stableAgentPrompt({ voice: false }), /in production unless a tool result/);
  const chat = stableAgentPrompt({ voice: false, proofLevels: true });
  assert.match(chat, /Never say something works, is live or is deployed in production unless a tool result showed/);
  assert.doesNotMatch(chat, /out loud/);
  assert.match(stableAgentPrompt({ voice: true, proofLevels: true }), /Do not list proof levels out loud\./);
});
