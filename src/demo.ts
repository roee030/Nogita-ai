import { NogitaEngine } from './core/engine.ts';
import { AllowlistPolicy } from './core/policy.ts';
import { DemoBoard, DemoBrain, DemoCode, DemoMeeting } from './adapters/demo.ts';

const board = new DemoBoard();
const meeting = new DemoMeeting('demo-meeting');
const nogita = new NogitaEngine({ board, code: new DemoCode(), brain: new DemoBrain(),
  policy: new AllowlistPolicy(new Set(['lead'])) });
await nogita.startSession('demo', meeting);
const lead = { id: 'lead', displayName: 'Team Lead', verified: true };
const alice = { id: 'alice', displayName: 'Alice', verified: true };
const utterances = [
  { actor: alice, text: 'We want to change the authentication implementation.' },
  { actor: lead, text: 'Nogita, how is authentication implemented in the code?' },
  { actor: alice, text: 'That could be a critical security risk.' },
  { actor: lead, text: 'Nogita, create a task to investigate the refresh-token security issue.' },
];
for (const [index, u] of utterances.entries()) {
  const result = await nogita.onUtterance('demo', { ...u, eventId: `demo-event-${index}` });
  console.log(`[input ${index+1}] ${u.actor.displayName}: ${u.text}`);
  console.log(`  -> ${result}`);
  for (const e of meeting.events.splice(0)) console.log(`  -> ${e.type.toUpperCase()}: ${e.text ?? ''}`);
}
await nogita.endSession('demo');
console.log(`\nCreated ${board.tasks.length} mock task(s). No external APIs were contacted.`);
