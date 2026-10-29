/**
 * Missions from the terminal, on the same store as the server (NOGITA_STATE_DIR/missions):
 *
 *   npm run mission -- start "Take care of KAN-20: find what blocks it" [--done "..."] [--wait]
 *   npm run mission -- list | show M-XXXX | resume [M-XXXX "guidance"] | approve M-XXXX | decline M-XXXX | cancel M-XXXX
 *
 * The owner is NOGITA_MISSION_OWNER, else the first AUTHORIZED_ACTOR_IDS entry. Writes still wait for approval.
 * Slack's live connection is not opened here; only the tools a mission uses are.
 */
import { loadDotEnv, createDependencies } from '../src/app/config.ts';
import { FileMissionStore } from '../src/app/mission-store.ts';
import { MissionRunner, type Mission } from '../src/core/missions.ts';
import { buildToolbox } from '../src/core/agent-tools.ts';
import type { ActionReceipt } from '../src/core/contracts.ts';

loadDotEnv();
const env = process.env;
const deps = createDependencies(env);
if (!deps.agent) { console.error('No agent model: set ANTHROPIC_API_KEY (and leave NOGITA_AGENT on).'); process.exit(1); }
const ownerId = env.NOGITA_MISSION_OWNER ?? (env.AUTHORIZED_ACTOR_IDS ?? '').split(',')[0]?.trim();
if (!ownerId) { console.error('Set NOGITA_MISSION_OWNER or AUTHORIZED_ACTOR_IDS.'); process.exit(1); }
const owner = { id: ownerId, displayName: deps.identities.displayNameFor(ownerId) ?? ownerId };
const completed = new Map<string, ActionReceipt>();

const runner = new MissionRunner({ model: deps.agent, store: new FileMissionStore(env.NOGITA_STATE_DIR ?? '.nogita-state'),
  toolbox: (mission, callId) => buildToolbox({ actor: { ...mission.owner, verified: true }, request: mission.goal,
    sessionId: `mission-${mission.id}`, eventId: callId ?? `${mission.id}:${mission.rounds}`, policy: deps.policy, code: deps.code,
    board: deps.board, chat: deps.chat, people: deps.people, completed, writesApproved: true,
    onReceipt: async receipt => { console.log(`  ↳ ${receipt.label}: ${receipt.url}`); } }).toolbox,
  notify: (mission, text) => { console.log(`» ${text}`); },
  onChange: mission => { if (mission.activity) process.stdout.write(`  · ${mission.id} ${mission.status}: ${mission.activity}\n`); } });

function show(mission: Mission, steps = 40): void {
  console.log(`${mission.id} [${mission.status}] ${mission.goal}`);
  console.log(`  owner ${mission.owner.displayName} · done when: ${mission.doneWhen} · rounds ${mission.rounds}`);
  for (const step of mission.steps.slice(-steps)) console.log(`  ${new Date(step.at).toISOString().slice(11, 19)} ${step.kind.padEnd(19)} ${step.text}`);
  if (mission.pending) console.log(`  WAITING FOR APPROVAL: ${mission.pending.summary}`);
  if (mission.result) console.log(`  RESULT (${mission.result.verified ? 'verified' : 'unverified'}): ${mission.result.summary}\n  evidence: ${mission.result.evidence.join(', ')}`);
  if (mission.blockedReason) console.log(`  BLOCKED: ${mission.blockedReason}`);
}

const [command = 'list', ...args] = process.argv.slice(2);
const wait = args.includes('--wait') || command === 'resume' || ['approve', 'decline'].includes(command);
const doneIndex = args.indexOf('--done');
// Looking (list, show) never starts work; every other command continues what a stopped process left.
if (['list', 'show'].includes(command)) await runner.loadAll(); else await runner.resumeAll();
let result: { ok: boolean; message: string } | undefined;
if (command === 'start') {
  const goal = args.filter((a, i) => !a.startsWith('--') && (doneIndex < 0 || i !== doneIndex + 1)).join(' ');
  const mission = await runner.start({ goal, ...(doneIndex >= 0 ? { doneWhen: args[doneIndex + 1] } : {}), owner });
  console.log(`Started ${mission.id}`);
} else if (command === 'list') {
  for (const m of runner.list()) console.log(`${m.id} [${m.status}] ${m.goal.slice(0, 90)}${m.activity ? ` · ${m.activity}` : ''}`);
} else if (command === 'show') {
  const mission = runner.get(args[0] ?? '');
  if (mission) show(mission); else console.log('Unknown mission.');
} else if (command === 'approve') result = await runner.approve(args[0] ?? '', owner.id);
else if (command === 'decline') result = await runner.reject(args[0] ?? '', owner.id, args.slice(1).join(' ') || undefined);
else if (command === 'cancel') result = await runner.cancel(args[0] ?? '', owner.id);
else if (command === 'resume' && args[0]) result = await runner.resume(args[0], owner.id, args.slice(1).join(' ') || undefined);
if (result) console.log(result.message);
if (wait || command === 'start') {
  // Runs until every mission this process is working on is done, blocked, waiting, failed or cancelled.
  await new Promise(resolve => setTimeout(resolve, 50));
  await runner.idle();
  for (const m of runner.list().filter(m => m.updatedAt > Date.now() - 10 * 60_000)) { console.log(''); show(m, 25); }
}
