import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContent, ChatModel, ChatModelRequest, ChatModelResponse } from '../src/core/agent.ts';
import { NogitaEngine, type ResearchFeatures } from '../src/core/engine.ts';
import { AllowlistPolicy } from '../src/core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from '../src/adapters/demo.ts';
import { ALL_RESEARCH_FEATURES, researchFeatures } from '../src/app/config.ts';
import type { Capability, CiStatus } from '../src/core/contracts.ts';

const lead = { id: 'lead', displayName: 'Lead', verified: true };
const RUN_URL = 'https://github.com/acme/app/actions/runs/2';

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };
class ScriptedModel implements ChatModel {
  readonly agentModel = 'scripted';
  readonly requests: ChatModelRequest[] = [];
  private index = 0;
  constructor(private readonly steps: Step[]) {}
  async streamChat(request: ChatModelRequest, onText: (delta: string) => void): Promise<ChatModelResponse> {
    this.requests.push(structuredClone(request));
    const step = this.steps[this.index++] ?? { text: '' };
    const content: AgentContent[] = [];
    if (step.text) { onText(step.text); content.push({ type: 'text', text: step.text }); }
    for (const [n, tool] of (step.tools ?? []).entries()) content.push({ type: 'tool_use', id: `t${this.index}-${n}`, name: tool.name, input: tool.input });
    return { content, stopReason: step.tools?.length ? 'tool_use' : 'end_turn' };
  }
}

class CiCode extends DemoCode {
  async ciStatus(): Promise<CiStatus | undefined> {
    return { repository: 'acme/app', target: { branch: 'main' },
      runs: [{ workflow: 'CI', status: 'completed', conclusion: 'failure', sha: 'b'.repeat(40), branch: 'main', event: 'push',
        url: RUN_URL, failedJobs: [{ name: 'test', url: `${RUN_URL}/job/7`, step: 'npm test' }] }] };
  }
}

class ChatMeeting extends DemoMeeting {
  override readonly capabilities: ReadonlySet<Capability> = new Set(['chat_receipt']);
}

async function ask(research: ResearchFeatures | undefined, request: string, steps: Step[], meeting: DemoMeeting = new ChatMeeting('m')) {
  const model = new ScriptedModel(steps);
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new CiCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['lead'])), agent: model },
  { schedule: () => 0, cancel: () => undefined, agentCacheWarmup: false, floor: { resumeAfterMs: 20, talkingMs: 20 },
    ...(research ? { research } : {}) });
  await engine.startSession('s', meeting);
  await engine.onUtterance('s', { text: `Nogita, ${request}`, eventId: '1', actor: lead });
  await engine.endSession('s');
  const posts = meeting.events.filter(event => event.type === 'chat' || event.type === 'speak').map(event => event.text ?? '');
  return { model, posts };
}
const tools = (request: ChatModelRequest) => request.tools.map(spec => spec.name);

test('every research feature is off by default: no ci_status, no paging tool, no plan, no proof rule, no citations', async () => {
  const { model, posts } = await ask(undefined, 'what tasks are still open about checkout?', [{ text: 'Two commits landed.' }]);
  const first = model.requests[0]!;
  assert.equal(tools(first).includes('ci_status'), false);
  assert.equal(tools(first).includes('more_of_result'), false);
  assert.doesNotMatch(first.turnSystem, /Research plan/);
  assert.doesNotMatch(first.stableSystem, /deployed in production unless/);
  assert.deepEqual(posts, ['Two commits landed.']);
});

test('the flags reach every turn: ci_status and paging are offered, a research question gets its plan, the prompt has the proof rule', async () => {
  const { model } = await ask(ALL_RESEARCH_FEATURES, 'what tasks are still open about checkout?', [{ text: 'Two are open.' }]);
  const first = model.requests[0]!;
  assert.ok(tools(first).includes('ci_status'));
  assert.ok(tools(first).includes('more_of_result'));
  assert.match(first.turnSystem, /Research plan for this question \(open tasks\)/);
  assert.match(first.stableSystem, /deployed in production unless a tool result showed that deployment/);
});

test('one flag turns on one feature only', async () => {
  const { model } = await ask({ ciStatus: true }, 'what tasks are still open about checkout?', [{ text: 'Two commits landed.' }]);
  const first = model.requests[0]!;
  assert.ok(tools(first).includes('ci_status'));
  assert.equal(tools(first).includes('more_of_result'), false);
  assert.doesNotMatch(first.turnSystem, /Research plan/);
});

test('with the ledger on, a chat answer about CI cites the run it rests on', async () => {
  const { model, posts } = await ask(ALL_RESEARCH_FEATURES, 'did CI pass on main?', [
    { tools: [{ name: 'ci_status', input: { branch: 'main' } }] },
    { text: 'No, CI failed on main: the test job broke at npm test [S1].' },
  ]);
  assert.match(model.requests[1]!.turnSystem, /\[S1\]/);
  assert.equal(posts.length, 1);
  assert.ok(posts[0]!.includes(RUN_URL), posts[0]);
});

test('in voice the ledger is kept but nothing is cited or read aloud', async () => {
  const { model, posts } = await ask(ALL_RESEARCH_FEATURES, 'did CI pass on main?', [
    { tools: [{ name: 'ci_status', input: { branch: 'main' } }] },
    { text: 'Nope, the test job failed on main.' },
  ], new DemoMeeting('v'));
  assert.doesNotMatch(model.requests[1]!.turnSystem, /\[S1\]/);
  assert.match(model.requests[0]!.stableSystem, /Do not list proof levels out loud\./);
  assert.ok(posts.every(post => !/\[S\d+\]/.test(post)), posts.join(' | '));
});

test('a guest gets no research plan, even with the templates on', async () => {
  const model = new ScriptedModel([{ text: 'I can only help with general questions.' }]);
  const engine = new NogitaEngine({ board: new DemoBoard(), code: new CiCode(), brain: new DemoBrain(),
    policy: new AllowlistPolicy(new Set(['lead'])), agent: model },
  { schedule: () => 0, cancel: () => undefined, agentCacheWarmup: false, research: { researchTemplates: true } });
  await engine.startSession('s', new ChatMeeting('m'));
  await engine.onUtterance('s', { text: 'Nogita, what tasks are still open about checkout?', eventId: '1', actor: { id: 'guest', displayName: 'Guest', verified: true } });
  await engine.endSession('s');
  assert.doesNotMatch(model.requests[0]!.turnSystem, /Research plan/);
});

test('NOGITA_* flags: true turns a feature on, blank or false leaves it off, anything else is a mistake', () => {
  assert.deepEqual(researchFeatures({}), {});
  assert.deepEqual(researchFeatures({ NOGITA_CI_STATUS: 'true', NOGITA_RESULT_DIGEST: 'false', NOGITA_EVIDENCE_LEDGER: '',
    NOGITA_PROOF_LEVELS: ' true ', NOGITA_RESEARCH_TEMPLATES: 'true' }), { ciStatus: true, proofLevels: true, researchTemplates: true });
  assert.throws(() => researchFeatures({ NOGITA_EVIDENCE_LEDGER: 'yes' }), /NOGITA_EVIDENCE_LEDGER must be true or false/);
});
