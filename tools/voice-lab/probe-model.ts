/**
 * Time to first text with Nogita's real agent prompt and tools, under different model settings.
 * Usage: node --experimental-transform-types tools/voice-lab/probe-model.ts [rounds]
 */
import { createDependencies, loadDotEnv } from '../../src/app/config.ts';
import { buildToolbox } from '../../src/core/agent-tools.ts';
import { agentUserMessage, stableAgentPrompt, turnAgentPrompt } from '../../src/core/agent-prompt.ts';

loadDotEnv();
const d = createDependencies(process.env);
if (d.code.prepare) await d.code.prepare();
const overview = await d.code.overview!();
const actorId = (process.env.AUTHORIZED_ACTOR_IDS ?? '').split(',')[0]!.trim();
const { toolbox } = buildToolbox({ actor: { id: actorId, displayName: 'Roee', verified: true }, request: 'x', sessionId: 's',
  eventId: 'e', policy: d.policy, code: d.code, board: d.board, chat: d.chat, people: d.people,
  onReceipt: async () => {}, completed: new Map() });
const stable = stableAgentPrompt({ voice: true, repository: { name: 'Nogita-ai', paths: overview.paths, readme: overview.readme,
  revision: overview.revision }, boardName: d.board.name, chatName: d.chat?.name });
const questions = ["what's the capital of Australia?", 'which file has the main meeting engine?', 'what is this project about?'];
const settings: Record<string, Record<string, unknown>> = {
  'haiku default (adaptive thinking)': { model: 'claude-haiku-5-5' },
  'haiku effort low': { model: 'claude-haiku-5-5', output_config: { effort: 'low' } },
  'haiku thinking disabled': { model: 'claude-haiku-5-5', thinking: { type: 'disabled' } },
  'sonnet default': { model: 'claude-sonnet-5-5' },
  'sonnet between_tools (thinking off)': { model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' } },
};
const rounds = Number(process.argv[2] ?? 2);
const tools = toolbox.specs.map((tool, i) => ({ ...tool, ...(i === toolbox.specs.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }));
for (const [name, extra] of Object.entries(settings)) {
  const firsts: number[] = [];
  const kinds = new Set<string>();
  for (let round = 0; round < rounds; round++) {
    for (const question of questions) {
      const started = performance.now();
      const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ max_tokens: 600, stream: true, ...extra,
          system: [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: turnAgentPrompt({ speaker: 'Roee', authorized: true, nowIso: new Date().toISOString(), followUp: false }) }],
          tools, messages: [{ role: 'user', content: agentUserMessage([], 'Roee', question) }] }) });
      if (!res.ok) { console.log(name, 'HTTP', res.status, (await res.text()).slice(0, 200)); break; }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let first = 0;
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6)) as { type: string; content_block?: { type: string }; delta?: { type: string } };
          if (event.type === 'content_block_start') kinds.add(event.content_block!.type);
          if (!first && event.type === 'content_block_delta' && event.delta?.type === 'text_delta') first = performance.now() - started;
          if (!first && event.type === 'content_block_start' && event.content_block?.type === 'tool_use') first = performance.now() - started;
        }
      }
      firsts.push(Math.round(first));
    }
  }
  firsts.sort((a, b) => a - b);
  console.log(`${name.padEnd(38)} first text/tool p50 ${firsts[Math.floor(firsts.length / 2)]} ms  all ${firsts.join(' ')}  blocks ${[...kinds].join(',')}`);
}
