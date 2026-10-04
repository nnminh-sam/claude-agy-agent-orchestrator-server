// Read side of the run store shared with the plugin (see the plugin README, "State contract").
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.mjs';

const ACTIVE = new Set(['starting', 'running']);
const ID = /^[A-Za-z0-9_-]+$/;

const runsDir = () => path.join(config.stateHome, 'runs');
const runFile = (id, name) => path.join(runsDir(), id, name);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const withEffectiveStatus = (meta) =>
  meta && ACTIVE.has(meta.status) && meta.pid && !isAlive(meta.pid) ? { ...meta, status: 'lost' } : meta;

export const isActive = (run) => ACTIVE.has(run.status);

export function listRuns() {
  let ids;
  try {
    ids = fs.readdirSync(runsDir());
  } catch {
    return [];
  }
  return ids
    .filter((id) => ID.test(id))
    .map((id) => withEffectiveStatus(readJson(runFile(id, 'meta.json'))))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function getRun(id) {
  if (!ID.test(id)) return null;
  const meta = withEffectiveStatus(readJson(runFile(id, 'meta.json')));
  if (!meta) return null;
  const result = readJson(runFile(id, 'result.json'));
  let stderr = '';
  try {
    stderr = fs.readFileSync(runFile(id, 'stderr.log'), 'utf8').slice(-8000);
  } catch {}
  return { ...meta, response: result?.response ?? null, stderr };
}

export const eventsFile = (id) => runFile(id, 'events.ndjson');

export function readEvents(id, offset = 0) {
  if (!ID.test(id)) return null;
  return readNdjson(eventsFile(id), offset);
}

// Returns complete NDJSON lines after byte `offset`, and the offset to ask for next.
export function readNdjson(file, offset = 0) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { events: [], nextOffset: 0 };
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.min(Math.max(0, offset), size);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const end = buf.lastIndexOf(0x0a) + 1; // keep a partially written last line for the next poll
    const events = buf.subarray(0, end).toString('utf8').split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [{ event: 'raw', text: line }];
      }
    });
    return { events, nextOffset: start + end };
  } finally {
    fs.closeSync(fd);
  }
}

function cli(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [config.cli, ...args], { timeout: 30_000, env: { ...process.env, CLAUDE_AGY_HOME: config.stateHome } },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr.trim() || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(stderr.trim() || stdout.trim() || 'unexpected output from claude-agy'));
        }
      });
  });
}

export const stopRun = (id) => cli(['stop', id, '--json']);

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Validates a launch request from the dashboard and starts a detached run.
export async function launchRun(body) {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw httpError(400, 'prompt is required');
  if (prompt.length > 100_000) throw httpError(400, 'prompt is too long');
  const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
  if (!path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw httpError(400, 'cwd must be an absolute path to an existing directory');
  }
  const args = ['run', '--background', '--json', '--source', 'dashboard', '--cwd', cwd];
  if (body.model) {
    if (!/^[\w.-]+$/.test(body.model)) throw httpError(400, 'invalid model id');
    args.push('--model', body.model);
  }
  if (body.effort) {
    if (!EFFORTS.has(body.effort)) throw httpError(400, 'invalid effort');
    args.push('--effort', body.effort);
  }
  if (body.label) args.push('--label', String(body.label).slice(0, 120));
  if (body.plan) args.push('--plan');
  if (body.sandbox) args.push('--sandbox');
  if (body.yolo) {
    if (!config.allowYolo) throw httpError(403, 'skipping permissions is disabled (set CLAUDE_AGY_ALLOW_YOLO=1)');
    args.push('--yolo');
  }
  args.push('--', prompt);
  return cli(args);
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
