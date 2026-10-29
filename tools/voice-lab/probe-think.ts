// Timing probe for the "thinking" stage: evidence prefetch, repository overview and the model's first text.
import { createDependencies, loadDotEnv } from '../../src/app/config.ts';
loadDotEnv();
const d = createDependencies(process.env);
if (d.code.prepare) await d.code.prepare();
for (const q of ['what is the capital of Australia?', 'which file has the main meeting engine?']) {
  let t = performance.now();
  await d.code.findEvidence(q);
  console.log('findEvidence', q, Math.round(performance.now() - t));
  t = performance.now();
  await d.code.overview?.();
  console.log('overview', Math.round(performance.now() - t));
}
const big = 'You are a helpful assistant. '.repeat(1500);
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  let first = 0;
  await d.agent!.streamChat({ stableSystem: big, turnSystem: 'Answer briefly.', messages: [{ role: 'user', content: 'What is two plus two?' }],
    tools: [], maxTokens: 50 }, () => { if (!first) first = performance.now() - t; });
  console.log('model first text', Math.round(first), 'total', Math.round(performance.now() - t));
}
