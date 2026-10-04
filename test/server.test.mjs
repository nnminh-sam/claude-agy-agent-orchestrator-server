import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agy-server-'));
const PLUGIN_CLI = path.resolve(ROOT, '..', 'claude-agy-plugin', 'scripts', 'claude-agy.mjs');
const PLUGIN_FAKE_AGY = path.resolve(ROOT, '..', 'claude-agy-plugin', 'test', 'fixtures', 'fake-agy.mjs');

Object.assign(process.env, {
  CLAUDE_AGY_HOME: path.join(TMP, 'home'),
  AGY_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-agy.mjs'),
  AGY_STATE_DIR: path.join(TMP, 'agy'),
  AGY_PROJECTS_DIR: path.join(TMP, 'projects'),
  CLAUDE_AGY_CLI: PLUGIN_CLI,
  CLAUDE_AGY_PLAYGROUND: path.join(TMP, 'playground'),
});

function seedRun(id, meta, events = []) {
  const dir = path.join(TMP, 'home', 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, ...meta }));
  fs.writeFileSync(path.join(dir, 'events.ndjson'), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

const check = (dimension, title, passed, weight = 1) => ({ dimension, title, weight, passed, detail: passed ? 'ok' : 'nope', seconds: 0.1 });
function summary(run, { passed, outside = [], model = 'gemini-fast' }) {
  const checks = [check('correctness', 'Same results', passed), check('clean_code', 'Short functions', true, 2), check('performance', 'Fast', passed, 3)];
  return {
    run, testcase: 'tc-easy', title: 'Easy level: do the thing', graded_at: `2026-10-0${run}T10:05:00+00:00`,
    agent: {
      run_id: `run-${run}`, status: passed ? 'succeeded' : 'blocked', model, started_at: `2026-10-0${run}T10:00:00.000Z`, duration_seconds: 60 * run,
      usage: { total_tokens: 1000 * run }, denied_actions: passed ? [] : [{ action: 'command', display_name: 'RunCommand' }], error: null, response: passed ? 'Done.' : '',
    },
    tools: { calls: { view_file: 2 }, errors: [], outside_workspace: outside },
    changes: { files: [{ path: 'app.py', added: 3, deleted: 1 }], added: 3, deleted: 1 },
    grade: {
      passed, gate_passed: passed, pass_mark: 0.7, checks, verdict: passed ? 'PASS' : 'FAIL',
      scores: { correctness: passed ? 1 : 0, clean_code: 1, performance: passed ? 1 : 0 },
    },
  };
}

// A sample testcase with a failed run, a passed run that reached outside its workspace, and a run in progress.
function seedPlayground() {
  const samples = path.join(TMP, 'playground', 'samples');
  write(path.join(samples, 'README.md'), [
    '| No | Sample directory | Testcase description | Status | Difficulty | Notes |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 1 | [tc-easy](./tc-easy/) | Do the `thing` \\| well. | Self-test passes | Easy (junior) | about 2 s |',
  ].join('\n'));
  write(path.join(samples, 'tc-easy', 'README.md'), '# Easy one\n\nMore.\n');
  write(path.join(samples, 'tc-easy', 'TASK.md'), '# Do the thing\n');
  write(path.join(samples, 'tc-easy', 'evaluate.py'), 'suite = harness.Suite("tc-easy", "Easy level: do the thing")\n');
  write(path.join(samples, '_grading', 'evaluate.py'), '');
  write(path.join(TMP, 'playground', 'archives', 'old', 'TASK.md'), '# Old\n');
  const runs = path.join(samples, 'outputs', 'tc-easy');
  write(path.join(runs, '1', 'summary.json'), summary(1, { passed: false }));
  write(path.join(runs, '1', 'grade.txt'), 'Result: FAIL\n');
  write(path.join(runs, '1', 'agent', 'events.ndjson'), '{"event":"init"}\n{"event":"result","status":"SUCCESS"}\n');
  write(path.join(runs, '1', 'workspace', 'secret.py'), 'x = 1\n');
  write(path.join(runs, '2', 'summary.json'), summary(2, { passed: true, outside: [{ tool: 'view_file', path: '../../reference/app.py' }] }));
  fs.mkdirSync(path.join(runs, '3', 'workspace'), { recursive: true });
  write(path.join(runs, '3', 'delegate.log'), 'working...\n');
  write(path.join(samples, 'outputs', 'reports', 'tc-easy', 'REPORT.md'), '# report\n');
  return path.join(runs, '3', 'workspace');
}

let server;
let base;
before(async () => {
  const today = new Date().toISOString();
  seedRun('20260101-000000-aaaaaa', {
    status: 'succeeded', createdAt: today, model: 'gemini-fast', source: 'claude-code', prompt: 'a', cwd: TMP, conversationId: 'conv-1',
    usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 16 },
  }, [{ event: 'init' }, { event: 'result', status: 'SUCCESS' }]);
  seedRun('20260101-000001-bbbbbb', { status: 'running', pid: 999999, createdAt: today, prompt: 'b', cwd: TMP });
  // The agent of test run 3, still working.
  seedRun('20260101-000002-cccccc', { status: 'running', pid: process.pid, createdAt: today, startedAt: today, prompt: 'c', cwd: seedPlayground(), model: 'gemini-fast' },
    [{ event: 'init' }]);

  fs.mkdirSync(path.join(TMP, 'agy'), { recursive: true });
  const db = new DatabaseSync(path.join(TMP, 'agy', 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, step_count integer, last_modified_time datetime,
    last_user_input_time datetime, workspace_uris text, status text, source text, project_id text, agent_name text,
    parent_conversation_id text, nesting_depth integer, not_fully_idle numeric, killed numeric)`);
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('conv-1', 'Fix bug', 12, '2026-10-03 10:00:00+00:00', '2026-10-03 10:00:00+00:00', '["file:///w/app"]', 'CASCADE_RUN_STATUS_RUNNING', '', 'p1', '', '', 0, 1, 0);
  db.close();
  fs.mkdirSync(path.join(TMP, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'projects', 'p1.json'), JSON.stringify({ id: 'p1', name: 'Claude-AGY', projectResources: { resources: [{ gitFolder: { folderUri: 'file:///w/app' } }] } }));

  const { createServer } = await import('../src/server.mjs');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};

test('lists runs and reports a run whose supervisor died as lost', async () => {
  const { body } = await get('/api/runs');
  assert.equal(body.length, 3);
  assert.equal(body.find((r) => r.id.endsWith('bbbbbb')).status, 'lost');
});

test('events are served incrementally and partial lines are held back', async () => {
  const id = '20260101-000000-aaaaaa';
  const first = (await get(`/api/runs/${id}/events`)).body;
  assert.equal(first.events.length, 2);
  fs.appendFileSync(path.join(TMP, 'home', 'runs', id, 'events.ndjson'), '{"event":"step_update"}\n{"event":"par');
  const next = (await get(`/api/runs/${id}/events?offset=${first.nextOffset}`)).body;
  assert.deepEqual(next.events, [{ event: 'step_update' }]);
});

test('overview aggregates counts and tokens', async () => {
  const { body } = await get('/api/overview');
  assert.equal(body.counts.total, 3);
  assert.equal(body.counts.active, 1);
  assert.equal(body.counts.failed, 1); // the lost run
  assert.equal(body.usage.totals.total_tokens, 16);
  assert.equal(body.usage.byModel['gemini-fast'].runs, 1);
});

test('quota, models and agents come from read-only agy commands', async () => {
  const quota = (await get('/api/quota')).body;
  assert.equal(quota.groups[0].buckets[0].remaining_fraction, 0.08);
  assert.equal(quota.credits.remaining_credits, 3);
  assert.deepEqual((await get('/api/models')).body, [{ id: 'gemini-fast', name: 'Gemini Fast' }]);
  const agents = (await get('/api/agents')).body;
  assert.equal(agents.antigravity[0].id, 'conv-1');
  assert.deepEqual(agents.definitions, []);
});

test('conversations are linked to runs and projects', async () => {
  const { body } = await get('/api/conversations');
  assert.equal(body.available, true);
  assert.deepEqual(
    { id: body.conversations[0].id, active: body.conversations[0].active, runId: body.conversations[0].runId, project: body.conversations[0].projectName, ws: body.conversations[0].workspaces },
    { id: 'conv-1', active: true, runId: '20260101-000000-aaaaaa', project: 'Claude-AGY', ws: ['/w/app'] },
  );
});

test('lists testcases from the playground with their reference-table entry and run counts', async () => {
  const { body } = await get('/api/testcases');
  assert.equal(body.available, true);
  assert.deepEqual(body.collections.map((c) => c.id), ['testcases', 'samples']);
  assert.equal(body.testcases.length, 1); // _grading/ and archives/ are not testcases
  const [tc] = body.testcases;
  assert.deepEqual(
    { name: tc.name, collection: tc.collection, title: tc.title, suite: tc.suiteTitle, description: tc.description, difficulty: tc.difficulty, status: tc.status },
    { name: 'tc-easy', collection: 'samples', title: 'Easy one', suite: 'Easy level: do the thing', description: 'Do the `thing` | well.', difficulty: 'Easy (junior)', status: 'Self-test passes' },
  );
  assert.deepEqual({ ...tc.stats, last: tc.stats.last.number }, { total: 3, graded: 2, passed: 1, running: 1, last: 3 });
});

test('a testcase lists graded and in-progress runs, results by model and checks across runs', async () => {
  const { body } = await get('/api/testcases/samples/tc-easy');
  assert.deepEqual(body.runs.map((r) => [r.number, r.state, r.verdict]), [[3, 'running', null], [2, 'graded', 'PASS'], [1, 'graded', 'FAIL']]);
  assert.equal(body.runs[0].agentRunId, '20260101-000002-cccccc');
  assert.deepEqual(body.runs[1].gate, { passed: 1, total: 1 });
  assert.equal(body.runs[1].outsideWorkspace, true);
  assert.equal(body.runs[2].blocked, true);
  assert.deepEqual(body.byModel, [{ model: 'gemini-fast', runs: 2, passed: 1, avgTokens: 1500, avgSeconds: 90, avgScores: { correctness: 0.5, clean_code: 1, performance: 0.5 } }]);
  assert.deepEqual(body.checks.runs, [2, 1]);
  assert.deepEqual(body.checks.rows.map((r) => [r.title, r.failed]), [['Same results', 1], ['Short functions', 0], ['Fast', 1]]);
  assert.equal(body.task, '# Do the thing\n');
});

test('a graded test run has its grade, diagnosis, files and recorded events', async () => {
  const { body } = await get('/api/testcases/samples/tc-easy/runs/1');
  assert.equal(body.verdict, 'FAIL');
  assert.equal(body.agentRunInStore, false);
  assert.deepEqual(body.files, ['summary.json', 'grade.txt', 'agent/events.ndjson']);
  assert.deepEqual(body.notes.map((n) => n.level), ['warning', 'warning', 'info', 'critical', 'critical']);
  assert.match(body.notes[3].text, /Correctness gate failed on 1 check\(s\): Same results/);
  assert.match(body.notes[4].text, /performance scored 0%, below the 70% pass mark/);
  assert.equal((await get('/api/testcases/samples/tc-easy/runs/1/events')).body.events.length, 2);
  const passed = (await get('/api/testcases/samples/tc-easy/runs/2')).body;
  assert.match(passed.notes[0].text, /reached outside its workspace: \.\.\/\.\.\/reference\/app\.py \(view_file\)/);
  assert.deepEqual((await get('/api/testcases/samples/tc-easy/runs/2/events')).body, { events: [], nextOffset: 0 });
});

test('a test run in progress shows its live agent run, events and progress log', async () => {
  const { body } = await get('/api/testcases/samples/tc-easy/runs/3');
  assert.equal(body.state, 'running');
  assert.equal(body.agentRunInStore, true);
  assert.deepEqual({ id: body.agent.run_id, status: body.agent.status, model: body.agent.model }, { id: '20260101-000002-cccccc', status: 'running', model: 'gemini-fast' });
  assert.equal(body.grade, null);
  assert.equal(body.delegateLog, 'working...\n');
  assert.deepEqual((await get('/api/testcases/samples/tc-easy/runs/3/events')).body.events, [{ event: 'init' }]);
  const run = (await get('/api/runs/20260101-000002-cccccc')).body;
  assert.deepEqual(run.testRun, { collection: 'samples', testcase: 'tc-easy', number: 3 });
  assert.equal((await get('/api/runs/20260101-000000-aaaaaa')).body.testRun, null);
});

test('the overview counts test runs across testcases', async () => {
  const { tests } = (await get('/api/overview')).body;
  assert.deepEqual(
    { available: tests.available, testcases: tests.testcases, total: tests.total, graded: tests.graded, passed: tests.passed, running: tests.running },
    { available: true, testcases: 1, total: 3, graded: 2, passed: 1, running: 1 },
  );
  assert.deepEqual(tests.recent.map((r) => [r.testcase, r.number]), [['tc-easy', 3], ['tc-easy', 2], ['tc-easy', 1]]);
});

test('serves only the record files of a test run, and only from known collections', async () => {
  const file = await fetch(`${base}/api/testcases/samples/tc-easy/runs/1/files/grade.txt`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /^text\/plain/);
  assert.equal(await file.text(), 'Result: FAIL\n');
  for (const p of [
    '/api/testcases/samples/tc-easy/runs/1/files/workspace/secret.py',
    '/api/testcases/samples/tc-easy/runs/1/files/..%2F..%2F..%2FREADME.md',
    '/api/testcases/samples/tc-easy/runs/1/files/changes.diff', // listed but not written for this run
    '/api/testcases/samples/tc-easy/runs/9',
    '/api/testcases/samples/_grading',
    '/api/testcases/archives/old',
    '/api/testcases/samples/..%2F..%2Fetc',
  ]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test('writes require same-origin JSON and loopback host', async () => {
  const form = await fetch(`${base}/api/runs`, { method: 'POST', body: 'prompt=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  const cross = await fetch(`${base}/api/runs`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get(`${base}/api/runs`, { headers: { host: 'attacker.example' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

test('rejects bad launch input and path traversal', async () => {
  const bad = await fetch(`${base}/api/runs`, { method: 'POST', body: JSON.stringify({ prompt: 'x', cwd: 'relative' }), headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  const yolo = await fetch(`${base}/api/runs`, { method: 'POST', body: JSON.stringify({ prompt: 'x', cwd: TMP, yolo: true }), headers: { 'content-type': 'application/json' } });
  assert.equal(yolo.status, 403);
  assert.equal((await fetch(`${base}/api/runs/..%2F..%2Fetc`)).status, 404);
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('launches and stops runs through the plugin CLI', { skip: !fs.existsSync(PLUGIN_CLI) && 'plugin not checked out next to the server' }, async () => {
  process.env.AGY_BIN = PLUGIN_FAKE_AGY;
  process.env.FAKE_AGY_MODE = 'slow';
  const res = await fetch(`${base}/api/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'do it', cwd: TMP, label: 'from dashboard', plan: true }),
  });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  let run;
  for (let i = 0; i < 40; i++) {
    run = (await get(`/api/runs/${id}`)).body;
    if (run.status === 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(run.status, 'running');
  assert.equal(run.source, 'dashboard');
  assert.equal(run.mode, 'plan');
  const stopped = await fetch(`${base}/api/runs/${id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await stopped.json()).status, 'cancelled');
});
