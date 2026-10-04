// Testcases and their delegated runs, read from the playground. Each testcase's evaluate.py writes them
// (see playground/samples/README.md and playground/samples/_grading/runs.py):
//
//   <playground>/<collection>/<testcase>/              README.md, TASK.md, evaluate.py, starter/, reference/
//   <playground>/<collection>/outputs/<testcase>/<N>/  workspace/, agent/, changes.diff, grade.txt, grade.json,
//                                                      summary.json, delegate.log
//
// A run without summary.json is not graded yet. The claude-agy run whose --cwd is its workspace says whether
// its agent is still working. This module only reads: evaluate.py prepares, delegates and grades runs.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { eventsFile, getRun, isActive, readNdjson } from './runs.mjs';

export const COLLECTIONS = [
  { id: 'testcases', label: 'Testcases', description: 'Finalized testcases. Validate the plugin against these before a release.' },
  { id: 'samples', label: 'Samples', description: 'Testcases in development.' },
];
const COLLECTION_IDS = new Set(COLLECTIONS.map((c) => c.id));
const NAME = /^[A-Za-z0-9_-]+$/;
const GATE = 'correctness';
const MATRIX_RUNS = 12;
// Files of a run that the dashboard may serve; anything else in the run folder (the workspace) is not served.
export const RUN_FILES = ['summary.json', 'grade.txt', 'grade.json', 'changes.diff', 'delegate.log',
  'agent/meta.json', 'agent/events.ndjson', 'agent/result.json', 'agent/stderr.log'];

function readText(file, max = 4_000_000) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// evaluate.py records workspaces by their real path, so compare real paths.
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

function playgroundRoot() {
  try {
    return fs.realpathSync(config.playgroundDir);
  } catch {
    return null;
  }
}

const isTestcase = (dir, name) => NAME.test(name) && !name.startsWith('_') && name !== 'outputs'
  && ['TASK.md', 'evaluate.py'].some((f) => fs.existsSync(path.join(dir, name, f)));

const plain = (cell) => cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

// The collection README's reference table, e.g. | No | Sample directory | Testcase description | Status | Difficulty | Notes |
function referenceTable(readme) {
  const entries = new Map();
  let header = [];
  for (const line of (readme ?? '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const name = cells.map((c) => /\]\(\.?\/?([A-Za-z0-9_-]+)\/?\)/.exec(c)?.[1]).find(Boolean);
    if (!name) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    const column = (word) => {
      const i = header.findIndex((h) => h.includes(word));
      return i >= 0 && cells[i] ? plain(cells[i]) : null;
    };
    entries.set(name, { description: column('description'), status: column('status'), difficulty: column('difficulty'), notes: column('notes') });
  }
  return entries;
}

function testcaseInfo(base, collection, name, table) {
  const dir = path.join(base, collection, name);
  const readme = readText(path.join(dir, 'README.md')) ?? '';
  const evaluate = readText(path.join(dir, 'evaluate.py')) ?? '';
  const ref = table.get(name) ?? {};
  return {
    collection,
    name,
    dir,
    title: /^#\s+(.+)$/m.exec(readme)?.[1].trim() || name,
    suiteTitle: /Suite\(\s*["'][^"']*["']\s*,\s*["']([^"']+)["']/.exec(evaluate)?.[1] ?? null,
    description: ref.description ?? null,
    status: ref.status ?? null,
    difficulty: ref.difficulty ?? null,
    notes: ref.notes ?? null,
  };
}

// ---------- runs ----------

const runsDir = (base, collection, name) => path.join(base, collection, 'outputs', name);

// The claude-agy run that works, or worked, in `workspace`: the newest one whose --cwd is that folder.
function agentFor(workspace, agentRuns) {
  return agentRuns.find((r) => r.cwd && real(r.cwd) === workspace) ?? null;
}

function gateCount(grade) {
  const gate = (grade?.checks ?? []).filter((c) => c.dimension === GATE);
  return { passed: gate.filter((c) => c.passed).length, total: gate.length };
}

function gradedRow(summary) {
  const { agent = {}, grade = {}, changes = {}, tools = {} } = summary;
  return {
    number: summary.run,
    state: 'graded',
    verdict: grade.verdict ?? (grade.passed ? 'PASS' : 'FAIL'),
    passed: Boolean(grade.passed),
    gatePassed: Boolean(grade.gate_passed),
    gate: gateCount(grade),
    scores: grade.scores ?? {},
    passMark: grade.pass_mark ?? null,
    startedAt: agent.started_at ?? summary.graded_at,
    gradedAt: summary.graded_at,
    model: agent.model ?? null,
    agentStatus: agent.status ?? null,
    agentRunId: agent.run_id ?? null,
    durationSeconds: agent.duration_seconds ?? null,
    tokens: agent.usage?.total_tokens ?? null,
    filesChanged: changes.files?.length ?? 0,
    added: changes.added ?? 0,
    deleted: changes.deleted ?? 0,
    outsideWorkspace: (tools.outside_workspace ?? []).length > 0,
    blocked: (agent.denied_actions ?? []).length > 0,
  };
}

// A run that is not graded: `running` while its agent works, `ungraded` after, `prepared` before any agent used it.
function pendingRow(number, dir, agent) {
  let created = null;
  try {
    const stat = fs.statSync(dir);
    created = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
  } catch {}
  return {
    number,
    state: !agent ? 'prepared' : isActive(agent) ? 'running' : 'ungraded',
    verdict: null,
    passed: false,
    gatePassed: false,
    gate: null,
    scores: {},
    passMark: null,
    startedAt: agent?.startedAt ?? agent?.createdAt ?? created,
    gradedAt: null,
    model: agent?.model ?? null,
    agentStatus: agent?.status ?? null,
    agentRunId: agent?.id ?? null,
    durationSeconds: agent?.durationSeconds ?? null,
    tokens: agent?.usage?.total_tokens ?? null,
    filesChanged: null,
    added: null,
    deleted: null,
    outsideWorkspace: false,
    blocked: (agent?.deniedActions ?? []).length > 0,
  };
}

// Run N of a testcase as { row, summary, dir, workspace, agent }, where `agent` is its claude-agy run if still stored.
function loadRun(base, collection, name, number, agentRuns) {
  const dir = path.join(runsDir(base, collection, name), String(number));
  const workspace = path.join(dir, 'workspace');
  const summary = readJson(path.join(dir, 'summary.json'));
  if (summary?.grade) {
    const agent = agentRuns.find((r) => r.id === summary.agent?.run_id) ?? null;
    return { row: { ...gradedRow(summary), number }, summary, dir, workspace, agent };
  }
  const agent = agentFor(workspace, agentRuns);
  return { row: pendingRow(number, dir, agent), summary: null, dir, workspace, agent };
}

// Every run of a testcase, newest first.
function loadRuns(base, collection, name, agentRuns) {
  return subdirs(runsDir(base, collection, name)).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => b - a)
    .map((number) => loadRun(base, collection, name, number, agentRuns));
}

const mean = (values) => {
  const present = values.filter((v) => typeof v === 'number');
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
};

function stats(rows) {
  const graded = rows.filter((r) => r.state === 'graded');
  return {
    total: rows.length,
    graded: graded.length,
    passed: graded.filter((r) => r.passed).length,
    running: rows.filter((r) => r.state === 'running').length,
    last: rows[0] ?? null,
  };
}

function byModel(rows) {
  const groups = new Map();
  for (const r of rows.filter((row) => row.state === 'graded')) {
    const key = r.model ?? 'unknown';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([model, runs]) => {
    const dimensions = [...new Set(runs.flatMap((r) => Object.keys(r.scores)))];
    return {
      model,
      runs: runs.length,
      passed: runs.filter((r) => r.passed).length,
      avgTokens: mean(runs.map((r) => r.tokens)),
      avgSeconds: mean(runs.map((r) => r.durationSeconds)),
      avgScores: Object.fromEntries(dimensions.map((d) => [d, mean(runs.map((r) => r.scores[d]))])),
    };
  });
}

// Which check passed in which of the latest graded runs. Checks are listed in the newest grader's order.
function checkMatrix(loaded) {
  const graded = loaded.filter((l) => l.summary).slice(0, MATRIX_RUNS);
  const rows = new Map();
  for (const { summary, row } of graded) {
    for (const check of summary.grade.checks ?? []) {
      const key = `${check.dimension}\u0000${check.title}`;
      if (!rows.has(key)) rows.set(key, { dimension: check.dimension, title: check.title, weight: check.weight, results: {}, failed: 0 });
      const entry = rows.get(key);
      entry.results[row.number] = { passed: Boolean(check.passed), detail: check.detail ?? '' };
      if (!check.passed) entry.failed += 1;
    }
  }
  return { runs: graded.map((l) => l.row.number), rows: [...rows.values()] };
}

// The same notes as the "Diagnosis" of a run in REPORT.md (see _grading/runs.py).
export function diagnose(summary) {
  const { agent = {}, grade = {}, tools = {}, changes = {} } = summary;
  const notes = [];
  const outside = tools.outside_workspace ?? [];
  if (outside.length) {
    const reached = outside.slice(0, 5).map((e) => `${e.path} (${e.tool})`).join(', ');
    notes.push({ level: 'critical', text: `The agent reached outside its workspace: ${reached}. Beyond it are the testcases with their reference/ solutions, the grader and other runs, so this result may not be the agent's own work.` });
  }
  if (!agent.run_id) notes.push({ level: 'warning', text: 'No claude-agy run was found for this workspace, so model, tokens and tools are unknown.' });
  else if (agent.status !== 'succeeded') notes.push({ level: 'warning', text: `The agent run ended as ${agent.status}: ${agent.error || '-'}` });
  const denied = agent.denied_actions ?? [];
  if (denied.length) {
    const names = denied.map((a) => a.display_name || a.action || '?').join(', ');
    notes.push({ level: 'warning', text: `agy denied ${names}: headless mode cannot ask for approval. Re-run with --yolo (ideally with --sandbox) or allow the command in agy's settings.` });
  }
  for (const error of tools.errors ?? []) notes.push({ level: 'warning', text: `Tool ${error.tool} failed on ${error.input}.` });
  if (!(changes.files ?? []).length) notes.push({ level: 'warning', text: 'The agent changed no files, so the grade reflects the starter code.' });
  if (agent.run_id && !String(agent.response ?? '').trim()) notes.push({ level: 'info', text: 'The agent wrote no final report.' });
  const gateFailures = (grade.checks ?? []).filter((c) => c.dimension === GATE && !c.passed).map((c) => c.title);
  if (gateFailures.length) notes.push({ level: 'critical', text: `Correctness gate failed on ${gateFailures.length} check(s): ${gateFailures.join('; ')}.` });
  for (const [dimension, score] of Object.entries(grade.scores ?? {})) {
    if (dimension !== GATE && score < grade.pass_mark) {
      notes.push({ level: 'critical', text: `${dimension.replace(/_/g, ' ')} scored ${Math.round(score * 100)}%, below the ${Math.round(grade.pass_mark * 100)}% pass mark.` });
    }
  }
  return notes;
}

// The agent's side of a run that is not graded yet, shaped like summary.json's `agent`.
function agentFromRun(run) {
  if (!run) return null;
  const full = getRun(run.id) ?? run;
  return {
    run_id: full.id,
    status: full.status,
    model: full.model ?? null,
    model_source: full.modelSource ?? null,
    yolo: Boolean(full.skipPermissions),
    sandbox: Boolean(full.sandbox),
    effort: full.effort ?? null,
    started_at: full.createdAt,
    conversation_id: full.conversationId ?? null,
    duration_seconds: full.durationSeconds ?? null,
    num_turns: full.numTurns ?? null,
    usage: full.usage ?? null,
    denied_actions: full.deniedActions ?? [],
    error: full.error == null || typeof full.error === 'string' ? full.error ?? null : JSON.stringify(full.error),
    response: full.response ?? null,
  };
}

// ---------- public API ----------

function locate(collection, name) {
  const base = playgroundRoot();
  if (!base || !COLLECTION_IDS.has(collection) || !NAME.test(name) || !isTestcase(path.join(base, collection), name)) return null;
  return base;
}

function scan(agentRuns) {
  const base = playgroundRoot();
  if (!base) return { available: false, root: config.playgroundDir, testcases: [] };
  const testcases = COLLECTIONS.flatMap(({ id }) => {
    const dir = path.join(base, id);
    const table = referenceTable(readText(path.join(dir, 'README.md')));
    return subdirs(dir).filter((name) => isTestcase(dir, name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => ({ ...testcaseInfo(base, id, name, table), loaded: loadRuns(base, id, name, agentRuns) }));
  });
  return { available: true, root: base, testcases };
}

export function listTestcases(agentRuns) {
  const { testcases, ...rest } = scan(agentRuns);
  return {
    ...rest,
    collections: COLLECTIONS,
    testcases: testcases.map(({ loaded, ...t }) => ({ ...t, stats: stats(loaded.map((l) => l.row)) })),
  };
}

// Counts and the latest test runs across every testcase, for the overview.
export function testsOverview(agentRuns, { recent = 6 } = {}) {
  const { available, testcases } = scan(agentRuns);
  const rows = testcases.flatMap((t) => t.loaded.map((l) => ({ ...l.row, collection: t.collection, testcase: t.name, testcaseTitle: t.title })));
  return {
    available,
    testcases: testcases.length,
    ...stats(rows),
    recent: rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, recent),
  };
}

export function getTestcase(collection, name, agentRuns) {
  const base = locate(collection, name);
  if (!base) return null;
  const table = referenceTable(readText(path.join(base, collection, 'README.md')));
  const info = testcaseInfo(base, collection, name, table);
  const loaded = loadRuns(base, collection, name, agentRuns);
  const rows = loaded.map((l) => l.row);
  return {
    ...info,
    runsDir: runsDir(base, collection, name),
    report: path.join(base, collection, 'outputs', 'reports', name, 'REPORT.md'),
    task: readText(path.join(info.dir, 'TASK.md')),
    readme: readText(path.join(info.dir, 'README.md')),
    runs: rows,
    stats: stats(rows),
    byModel: byModel(rows),
    checks: checkMatrix(loaded),
  };
}

function findRun(collection, name, number, agentRuns) {
  const base = locate(collection, name);
  if (!base || !/^\d+$/.test(String(number))) return null;
  if (!fs.statSync(path.join(runsDir(base, collection, name), String(Number(number))), { throwIfNoEntry: false })?.isDirectory()) return null;
  return { base, ...loadRun(base, collection, name, Number(number), agentRuns) };
}

export function getTestRun(collection, name, number, agentRuns) {
  const found = findRun(collection, name, number, agentRuns);
  if (!found) return null;
  const { base, row, summary, dir, workspace, agent } = found;
  const info = testcaseInfo(base, collection, name, referenceTable(readText(path.join(base, collection, 'README.md'))));
  return {
    ...row,
    collection,
    testcase: name,
    testcaseTitle: info.title,
    suiteTitle: summary?.title ?? info.suiteTitle,
    testcaseDir: info.dir,
    dir,
    workspace,
    agentRunInStore: Boolean(agent),
    agent: summary?.agent ?? agentFromRun(agent),
    tools: summary?.tools ?? null,
    changes: summary?.changes ?? null,
    grade: summary?.grade ?? null,
    notes: summary ? diagnose(summary) : [],
    files: RUN_FILES.filter((f) => fs.existsSync(path.join(dir, f))),
    delegateLog: summary ? null : readText(path.join(dir, 'delegate.log'))?.slice(-8000) ?? null,
  };
}

// The run's agent events after byte `offset`: from the copy recorded with the run or, until it is graded,
// from the claude-agy run working in its workspace. Both are the same bytes, so offsets carry over.
export function readTestRunEvents(collection, name, number, offset, agentRuns) {
  const found = findRun(collection, name, number, agentRuns);
  if (!found) return null;
  const archived = path.join(found.dir, 'agent', 'events.ndjson');
  if (fs.existsSync(archived)) return readNdjson(archived, offset);
  return found.agent ? readNdjson(eventsFile(found.agent.id), offset) : { events: [], nextOffset: 0 };
}

export function readTestRunFile(collection, name, number, file) {
  if (!RUN_FILES.includes(file)) return null;
  const found = findRun(collection, name, number, []);
  return found ? readText(path.join(found.dir, file)) : null;
}

// { collection, testcase, number } when `cwd` is the workspace of a test run, otherwise null.
export function testRunForCwd(cwd) {
  const base = playgroundRoot();
  if (!base || !cwd) return null;
  const parts = path.relative(base, real(cwd)).split(path.sep);
  const [collection, outputs, testcase, number, workspace] = parts;
  if (parts.length !== 5 || outputs !== 'outputs' || workspace !== 'workspace' || !COLLECTION_IDS.has(collection)
    || !NAME.test(testcase) || !/^\d+$/.test(number)) return null;
  return { collection, testcase, number: Number(number) };
}
