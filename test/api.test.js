import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `atlas-test-${process.pid}`);
const { app } = await import('../server.js');

let server, base;
before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(() => new Promise(r => server.close(r)));
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health endpoint responds', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});
test('source files and config are not served statically', async () => {
  for (const f of ['/server.js', '/package.json', '/.env']) assert.equal((await fetch(base + f)).status, 404, f);
  assert.equal((await fetch(base + '/')).status, 200);
});
test('unknown API routes return JSON 404', async () => {
  const res = await fetch(base + '/api/nope');
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});
test('rejects short prompts', async () => {
  assert.equal((await post('/api/tasks', { prompt: 'hi' })).status, 400);
});
test('safe task plans, runs, and verifies end to end', async () => {
  const { task } = await (await post('/api/tasks', { prompt: 'Prepare a weekly operations brief from company policy' })).json();
  assert.equal(task.status, 'queued');
  const run = await (await post(`/api/tasks/${task.id}/run`, {})).json();
  assert.equal(run.task.status, 'completed');
  assert.ok(run.task.evidence.some(e => e.type === 'verification' && e.passed));
});
test('sensitive task is blocked until approved', async () => {
  const { task } = await (await post('/api/tasks', { prompt: 'Send an email to the customer about renewal' })).json();
  assert.equal(task.status, 'approval');
  assert.equal((await post(`/api/tasks/${task.id}/run`, {})).status, 409);
  assert.equal((await post(`/api/tasks/${task.id}/approval`, { decision: 'approve' })).status, 200);
  assert.equal((await (await post(`/api/tasks/${task.id}/run`, {})).json()).task.status, 'completed');
});
