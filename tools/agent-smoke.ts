/**
 * Live, read-only smoke test of the conversational agent against the providers configured in .env.
 * Writes are blocked: task creation and Slack posts throw before reaching any provider.
 *
 *   node --experimental-transform-types tools/agent-smoke.ts ["question" ...]
 *
 * Prints, per question: time to first spoken text, total time, what was spoken and what went to chat.
 */
import { loadDotEnv, createDependencies } from '../src/app/config.ts';
import { NogitaEngine } from '../src/core/engine.ts';
import { DemoMeeting } from '../src/adapters/demo.ts';
import type { ActionReceipt, ChatPort, SpeakOptions } from '../src/core/contracts.ts';

loadDotEnv();
const dependencies = createDependencies(process.env);
if (!dependencies.agent) throw new Error('Set NOGITA_MODE=live and ANTHROPIC_API_KEY to run the agent smoke test');
const actorId = (process.env.AUTHORIZED_ACTOR_IDS ?? '').split(',').map(s => s.trim()).find(Boolean);
if (!actorId) throw new Error('AUTHORIZED_ACTOR_IDS must name the internal ID to test as');

const blocked = async (): Promise<ActionReceipt> => { throw new Error('writes are disabled in the smoke test'); };
dependencies.board.createTask = blocked;
const chat: ChatPort | undefined = dependencies.chat && { ...dependencies.chat, name: dependencies.chat.name,
  listChannels: () => dependencies.chat!.listChannels(), readChannel: (c, l) => dependencies.chat!.readChannel(c, l),
  searchMessages: dependencies.chat.searchMessages && ((q, l) => dependencies.chat!.searchMessages!(q, l)),
  postMessage: blocked };

class TimedMeeting extends DemoMeeting {
  startedAt = 0;
  firstSpeechAt = 0;
  readonly log: string[] = [];
  override async speak(message: string, options: SpeakOptions = {}): Promise<void> {
    if (!this.firstSpeechAt) this.firstSpeechAt = performance.now();
    this.log.push(`  [${Math.round(performance.now() - this.startedAt)} ms] speak${options.chatMirror === false ? '' : '+chat'}: ${message}`);
  }
  override async sendStatus(message: string): Promise<void> {
    this.log.push(`  [${Math.round(performance.now() - this.startedAt)} ms] chat: ${message}`);
  }
}

const questions = process.argv.slice(2).length ? process.argv.slice(2) : [
  'Nogita, what is this project about?',
  'Nogita, how does Nogita verify who is speaking in a meeting?',
  'Nogita, what are the open tasks on our Jira board?',
  'Nogita, what changed in the last few commits?',
  'Nogita, what do you think is the biggest security risk in how we handle webhooks?',
];

if (dependencies.code.prepare) await dependencies.code.prepare();
const engine = new NogitaEngine({ ...dependencies, chat }, { progressDelayMs: 60_000, agentProgressDelayMs: 60_000 });
const meeting = new TimedMeeting('smoke');
await engine.startSession('smoke', meeting);
let n = 0;
for (const question of questions) {
  meeting.log.length = 0;
  meeting.firstSpeechAt = 0;
  meeting.startedAt = performance.now();
  const result = await engine.onUtterance('smoke', { eventId: `q${++n}`, text: question,
    actor: { id: actorId, displayName: dependencies.identities.fromId(actorId)?.displayName ?? 'Tester', verified: true } });
  const total = performance.now() - meeting.startedAt;
  const first = meeting.firstSpeechAt ? meeting.firstSpeechAt - meeting.startedAt : NaN;
  console.log(`\n${question}\n  result=${result} first_speech=${Math.round(first)} ms total=${Math.round(total)} ms`);
  console.log(meeting.log.join('\n'));
}
const usage = (dependencies.brain as { usageFor?: (id: string) => unknown }).usageFor?.('smoke');
console.log('\nusage', JSON.stringify(usage));
await engine.endSession('smoke');
