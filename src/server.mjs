import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config } from './config.mjs';
import { getAgents, getConversations, getCredits, getModels, getProjects, getQuota, peek } from './agy.mjs';
import { getTestcase, getTestRun, listTestcases, readTestRunEvents, readTestRunFile, testRunForCwd, testsOverview } from './playground.mjs';
import { getRun, httpError, isActive, launchRun, listRuns, readEvents, stopRun } from './runs.mjs';
import { summarizeUsage } from './usage.mjs';

const PUBLIC = path.join(config.root, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw httpError(413, 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw httpError(400, 'invalid JSON body');
  }
}

// The server can start agents, so it only answers to loopback host names (blocks DNS rebinding)
// and only accepts writes from its own origin as JSON (blocks cross-site form posts).
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function guard(req) {
  if (!LOOPBACK.test(req.headers.host ?? '') && config.host === '127.0.0.1') throw httpError(403, 'forbidden host');
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw httpError(403, 'cross-origin request refused');
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw httpError(415, 'expected application/json');
}

const quotaSnapshot = () => {
  const quota = peek('quota');
  if (!quota || Date.now() - Date.parse(quota.fetchedAt) > 60_000) getQuota().catch(() => {});
  return quota;
};

const routes = [
  ['GET', /^\/api\/health$/, () => ({
    ok: true,
    stateHome: config.stateHome,
    cli: config.cli,
    cliFound: fs.existsSync(config.cli),
    agyBin: config.agyBin,
    allowYolo: config.allowYolo,
    defaultCwd: path.resolve(config.root, '..'),
  })],
  ['GET', /^\/api\/overview$/, () => {
    const runs = listRuns();
    const count = (s) => runs.filter((r) => r.status === s).length;
    return {
      counts: { total: runs.length, active: runs.filter(isActive).length, succeeded: count('succeeded'), failed: count('failed') + count('lost'), cancelled: count('cancelled') },
      active: runs.filter(isActive),
      recent: runs.slice(0, 8),
      usage: summarizeUsage(runs, { days: 7 }),
      quota: quotaSnapshot(),
      tests: testsOverview(runs),
    };
  }],
  ['GET', /^\/api\/runs$/, () => listRuns()],
  ['POST', /^\/api\/runs$/, async (req) => launchRun(await readBody(req))],
  ['GET', /^\/api\/runs\/([\w-]+)$/, (req, [id]) => {
    const run = getRun(id);
    return run ? { ...run, testRun: testRunForCwd(run.cwd) } : Promise.reject(httpError(404, 'run not found'));
  }],
  ['GET', /^\/api\/runs\/([\w-]+)\/events$/, (req, [id], url) =>
    readEvents(id, Number(url.searchParams.get('offset') ?? 0)) ?? Promise.reject(httpError(404, 'run not found'))],
  ['POST', /^\/api\/runs\/([\w-]+)\/stop$/, (req, [id]) => stopRun(id)],
  ['GET', /^\/api\/usage$/, (req, m, url) => summarizeUsage(listRuns(), { days: Math.min(90, Number(url.searchParams.get('days') ?? 14)) })],
  ['GET', /^\/api\/quota$/, async (req, m, url) => {
    const refresh = url.searchParams.has('refresh');
    const [quota, credits] = await Promise.all([getQuota({ refresh }), getCredits({ refresh }).catch(() => null)]);
    return { ...quota, credits };
  }],
  ['GET', /^\/api\/models$/, () => getModels()],
  ['GET', /^\/api\/agents$/, async () => {
    const runs = listRuns();
    const { conversations } = await getConversations({ limit: 200 });
    return {
      delegated: runs.filter(isActive),
      antigravity: conversations.filter((c) => c.active),
      definitions: await getAgents().catch(() => []),
    };
  }],
  ['GET', /^\/api\/conversations$/, async (req, m, url) => {
    const data = await getConversations({ limit: Math.min(500, Number(url.searchParams.get('limit') ?? 100)) });
    const runsByConversation = new Map(listRuns().filter((r) => r.conversationId).map((r) => [r.conversationId, r.id]));
    const projects = new Map(getProjects().map((p) => [p.id, p.name]));
    for (const c of data.conversations) {
      c.runId = runsByConversation.get(c.id) ?? null;
      c.projectName = projects.get(c.projectId) ?? null;
    }
    return data;
  }],
  ['GET', /^\/api\/projects$/, () => getProjects()],
  ['GET', /^\/api\/testcases$/, () => listTestcases(listRuns())],
  ['GET', /^\/api\/testcases\/([\w-]+)\/([\w-]+)$/, (req, [collection, name]) =>
    getTestcase(collection, name, listRuns()) ?? Promise.reject(httpError(404, 'testcase not found'))],
  ['GET', /^\/api\/testcases\/([\w-]+)\/([\w-]+)\/runs\/(\d+)$/, (req, [collection, name, n]) =>
    getTestRun(collection, name, n, listRuns()) ?? Promise.reject(httpError(404, 'test run not found'))],
  ['GET', /^\/api\/testcases\/([\w-]+)\/([\w-]+)\/runs\/(\d+)\/events$/, (req, [collection, name, n], url) =>
    readTestRunEvents(collection, name, n, Number(url.searchParams.get('offset') ?? 0), listRuns())
      ?? Promise.reject(httpError(404, 'test run not found'))],
  ['GET', /^\/api\/testcases\/([\w-]+)\/([\w-]+)\/runs\/(\d+)\/files\/(.+)$/, (req, [collection, name, n, file]) =>
    readTestRunFile(collection, name, n, file) ?? Promise.reject(httpError(404, 'file not found'))],
];

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      guard(req);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') throw httpError(405, 'method not allowed');
        return serveStatic(res, url.pathname);
      }
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (match && method === req.method) return send(res, 200, await handler(req, match.slice(1), url));
      }
      throw httpError(404, 'no such endpoint');
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  createServer().listen(config.port, config.host, () => {
    console.log(`Claude-AGY orchestrator on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`  runs: ${config.stateHome}/runs   cli: ${config.cli}${fs.existsSync(config.cli) ? '' : ' (NOT FOUND: launching and stopping disabled)'}`);
  });
}
