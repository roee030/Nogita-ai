/**
 * Listener-side Meet probe.
 *
 *   node --experimental-transform-types tools/listener-probe/run.ts record [--port 4317]
 *   node --experimental-transform-types tools/listener-probe/run.ts report session.json [...] [--out comparison.md]
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { analyseSession, renderComparison, type ProbeSession } from './analyse.ts';

function usage(): never {
  throw new Error('usage: listener-probe record [--port 4317] | report <session.json...> [--out comparison.md]');
}

async function report(args: string[]): Promise<void> {
  const outAt = args.indexOf('--out');
  const output = outAt < 0 ? undefined : args[outAt + 1];
  if (outAt >= 0 && !output) usage();
  const inputs = args.filter((_, index) => index !== outAt && index !== outAt + 1);
  if (!inputs.length) usage();
  const sessions = await Promise.all(inputs.map(async path => JSON.parse(await readFile(path, 'utf8')) as ProbeSession));
  const markdown = renderComparison(sessions.map(analyseSession));
  if (output) { await writeFile(output, markdown); process.stdout.write(`${output}\n`); }
  else process.stdout.write(markdown);
}

async function record(args: string[]): Promise<void> {
  const portAt = args.indexOf('--port');
  if (args.some((arg, index) => index !== portAt && index !== portAt + 1)) usage();
  const port = portAt < 0 ? 4317 : Number(args[portAt + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) usage();
  const html = await readFile(fileURLToPath(new URL('./recorder.html', import.meta.url)));
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !['/', '/recorder.html'].includes(request.url ?? '')) {
      response.writeHead(404).end('not found'); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:;" });
    response.end(html);
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Listener probe: http://127.0.0.1:${port}\nPress Ctrl+C after exporting the recording.\n`);
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === 'report') await report(args);
else if (command === 'record') await record(args);
else usage();
