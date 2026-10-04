// Antigravity data: quota and models via read-only `agy` commands (no agent turn, no quota spent),
// conversations and projects from the Antigravity CLI's local state.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.mjs';

const cache = new Map();

// Caches a value for `ttlMs`; concurrent callers share one in-flight request; failures are not cached.
async function cached(key, ttlMs, load, { refresh = false } = {}) {
  const hit = cache.get(key);
  if (hit && !refresh && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.pending ?? hit.value;
  const pending = load();
  cache.set(key, { ...hit, pending });
  try {
    const value = await pending;
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    if (hit?.value !== undefined) cache.set(key, hit);
    else cache.delete(key);
    throw err;
  }
}

export const peek = (key) => cache.get(key)?.value ?? null;

function agy(args) {
  return new Promise((resolve, reject) => {
    execFile(config.agyBin, args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? `agy not found ("${config.agyBin}")` : stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

const slashJson = async (command) => JSON.parse(await agy(['-p', command, '--output-format', 'json'])).command?.data;

export const getQuota = (opts) =>
  cached('quota', 60_000, async () => ({ fetchedAt: new Date().toISOString(), ...(await slashJson('/usage')) }), opts);

export const getCredits = (opts) => cached('credits', 5 * 60_000, () => slashJson('/credits'), opts);

const tsv = (out) => out.split('\n').filter((line) => line.includes('\t')).map((line) => line.split('\t').map((s) => s.trim()));

export const getModels = (opts) =>
  cached('models', 10 * 60_000, async () => tsv(await agy(['models'])).map(([id, name]) => ({ id, name })), opts);

// `agy agents` has no machine-readable output yet; keep its non-empty lines.
export const getAgents = (opts) =>
  cached('agents', 10 * 60_000, async () => (await agy(['agents'])).split('\n').map((l) => l.trim()).filter(Boolean), opts);

export function getProjects() {
  let files;
  try {
    files = fs.readdirSync(config.agyProjectsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(config.agyProjectsDir, file), 'utf8'));
      const folders = (p.projectResources?.resources ?? []).map((r) => r.gitFolder?.folderUri ?? r.folder?.folderUri).filter(Boolean);
      return [{ id: p.id, name: p.name, folders: folders.map((u) => u.replace(/^file:\/\//, '')) }];
    } catch {
      return [];
    }
  });
}

let DatabaseSync;

export async function getConversations({ limit = 100 } = {}) {
  const file = path.join(config.agyStateDir, 'conversation_summaries.db');
  if (!fs.existsSync(file)) return { available: false, conversations: [] };
  DatabaseSync ??= (await import('node:sqlite')).DatabaseSync;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT conversation_id, title, step_count, last_modified_time, last_user_input_time, workspace_uris,
             status, source, project_id, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed
      FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?`).all(limit);
    return {
      available: true,
      conversations: rows.map((r) => {
        let workspaces = [];
        try {
          workspaces = JSON.parse(r.workspace_uris).map((u) => u.replace(/^file:\/\//, ''));
        } catch {}
        return {
          id: r.conversation_id,
          title: r.title,
          steps: r.step_count,
          lastModified: r.last_modified_time,
          lastUserInput: r.last_user_input_time,
          workspaces,
          status: String(r.status || '').replace(/^CASCADE_RUN_STATUS_/, '').toLowerCase() || 'unknown',
          active: Boolean(r.not_fully_idle) && !r.killed,
          killed: Boolean(r.killed),
          projectId: r.project_id,
          agent: r.agent_name,
          parentId: r.parent_conversation_id || null,
          depth: r.nesting_depth,
        };
      }),
    };
  } finally {
    db.close();
  }
}
