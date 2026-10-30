/**
 * Conformance kits: the behaviour every adapter behind a port must have, written once. A new board or repository
 * (Linear, Azure DevOps, GitLab...) passes the same kit against its stub before it is wired in, so adding tools does
 * not mean re-learning what the agent relies on. Each check runs only when the adapter offers that capability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { BoardPort, CodePort } from '../../src/core/contracts.ts';

export interface BoardSubject {
  board: BoardPort;
  /** Someone the board can assign: the internal person id and their display name. */
  person: { id: string; name: string };
  /** Status a new task starts in. */
  initialStatus: string;
}

export function boardConformance(label: string, make: () => BoardSubject, options: { idempotent: boolean }): void {
  let n = 0;
  const create = (board: BoardPort, title: string, extra: { assigneeId?: string; requestId?: string } = {}) =>
    board.createTask({ title, description: `Details about ${title}`, requestId: extra.requestId ?? `conformance-${++n}`,
      ...(extra.assigneeId ? { assigneeId: extra.assigneeId } : {}) });

  test(`${label}: a created task comes back as a receipt with a link`, async () => {
    const { board } = make();
    const receipt = await create(board, 'Fix the login timeout');
    assert.equal(receipt.kind, 'task');
    assert.ok(receipt.label.trim());
    assert.match(receipt.url, /^https:\/\//);
  });

  if (options.idempotent) test(`${label}: a retried request does not create a second task`, async () => {
    const { board } = make();
    const first = await create(board, 'Rotate the API keys', { requestId: 'retry-1' });
    const again = await create(board, 'Rotate the API keys', { requestId: 'retry-1' });
    assert.equal(again.label, first.label);
  });

  test(`${label}: a task can be assigned to a person it knows`, async () => {
    const { board, person } = make();
    const receipt = await create(board, 'Review the billing page', { assigneeId: person.id });
    assert.ok(receipt.label);
    await assert.rejects(() => create(board, 'Nobody', { assigneeId: 'not-a-person' }));
  });

  test(`${label}: searching finds what was created, by words, status and owner`, async t => {
    const { board, person, initialStatus } = make();
    if (!board.searchTasks) return t.skip('no search');
    const owned = await create(board, 'Cache the GitHub file reads', { assigneeId: person.id });
    const loose = await create(board, 'Cache the avatar images');
    const byWords = await board.searchTasks({ text: 'cache github' });
    assert.ok(byWords.some(task => task.key === owned.label), 'words');
    assert.ok(!byWords.some(task => task.key === loose.label), 'every word must match');
    for (const task of byWords) assert.ok(task.title && task.url, 'summary has a title and a link');
    const byStatus = await board.searchTasks({ status: initialStatus.toUpperCase() });
    assert.ok(byStatus.some(task => task.key === owned.label), 'status, any case');
    assert.ok(byStatus.every(task => task.status?.toLowerCase() === initialStatus.toLowerCase()));
    const mine = await board.searchTasks({ assigneeId: person.id });
    assert.ok(mine.some(task => task.key === owned.label) && !mine.some(task => task.key === loose.label), 'owner');
    const nobody = await board.searchTasks({ unassigned: true });
    assert.ok(nobody.some(task => task.key === loose.label) && !nobody.some(task => task.key === owned.label), 'unassigned');
    assert.ok((await board.searchTasks({ limit: 1 })).length <= 1, 'limit');
  });

  test(`${label}: raw JQL only where the board says it understands it`, async t => {
    const { board, initialStatus } = make();
    if (!board.searchTasks) return t.skip('no search');
    if (board.queryLanguage === 'jql') {
      assert.ok(Array.isArray(await board.searchTasks({ jql: `status = "${initialStatus}"` })));
    } else {
      await assert.rejects(() => board.searchTasks!({ jql: 'status = "Done"' }));
    }
  });

  test(`${label}: one task reads back with its description; an unknown key is undefined`, async t => {
    const { board } = make();
    if (!board.getTask) return t.skip('no read');
    const receipt = await create(board, 'Document the retry policy');
    const task = await board.getTask(receipt.label);
    assert.equal(task?.title, 'Document the retry policy');
    assert.match(task?.description ?? '', /retry policy/);
    assert.equal(await board.getTask('ZZZ-999999'), undefined);
  });

  test(`${label}: a task moves, changes owner and takes a comment, and a repeated change does nothing twice`, async t => {
    const { board, person } = make();
    if (!board.updateTask || !board.getTask) return t.skip('no updates');
    const receipt = await create(board, 'Ship the invoice export');
    const change = { key: receipt.label, status: 'in progress', assigneeId: person.id, comment: 'Picked up in planning.', requestId: 'u-1' };
    assert.equal((await board.updateTask(change)).label, receipt.label);
    await board.updateTask(change);
    const task = await board.getTask(receipt.label);
    assert.equal(task?.status?.toLowerCase(), 'in progress');
    assert.equal(task?.assignee, person.name);
    assert.equal(task?.comments.filter(comment => comment.text === 'Picked up in planning.').length, 1);
    await assert.rejects(() => board.updateTask!({ key: receipt.label, assigneeId: 'not-a-person', requestId: 'u-2' }));
  });

  test(`${label}: a person found by name can be assigned`, async t => {
    const { board, person } = make();
    if (!board.findAssignees) return t.skip('no people search');
    const first = person.name.split(' ')[0]!;
    const found = await board.findAssignees(first);
    assert.ok(found.length >= 1);
    assert.ok((await create(board, 'Pair on the release', { assigneeId: found[0]!.id })).label);
  });
}

export interface CodeSubject {
  code: CodePort;
  /** A path that exists, and a word that appears in it. */
  path: string;
  word: string;
}

export function codeConformance(label: string, make: () => CodeSubject): void {
  test(`${label}: evidence for a word has a path, a link and an excerpt`, async () => {
    const { code, word } = make();
    const found = await code.findEvidence(word);
    assert.ok(found.length >= 1);
    for (const item of found) assert.ok(item.path && /^https:\/\//.test(item.url) && item.excerpt);
  });

  test(`${label}: a file reads back with numbered lines and honours a range`, async t => {
    const { code, path } = make();
    if (!code.readFile) return t.skip('no file reads');
    const whole = await code.readFile(path);
    assert.equal(whole?.path, path);
    assert.equal(whole?.startLine, 1);
    assert.match(whole?.text ?? '', /^1: /);
    const part = await code.readFile(path, 2, 2);
    assert.equal(part?.startLine, 2);
    assert.equal(part?.text.split('\n').length, 1);
    assert.equal(await code.readFile('no/such/file.ts'), undefined);
  });

  test(`${label}: listing honours a prefix and includes known files`, async t => {
    const { code, path } = make();
    if (!code.listFiles) return t.skip('no listing');
    assert.ok((await code.listFiles()).includes(path));
    const folder = path.split('/').slice(0, -1).join('/');
    if (folder) for (const item of await code.listFiles(folder)) assert.ok(item.startsWith(folder));
  });

  test(`${label}: the overview names the files the agent can ask for`, async t => {
    const { code, path } = make();
    if (!code.overview) return t.skip('no overview');
    assert.ok((await code.overview()).paths.includes(path));
  });
}
