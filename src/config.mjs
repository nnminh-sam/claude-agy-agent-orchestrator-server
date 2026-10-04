import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = os.homedir();

export const config = {
  root: ROOT,
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4777),
  // Run store written by the plugin's claude-agy CLI.
  stateHome: process.env.CLAUDE_AGY_HOME || path.join(home, '.claude-agy'),
  // The plugin CLI is used to launch and stop runs, so there is one implementation of both.
  cli: process.env.CLAUDE_AGY_CLI || path.resolve(ROOT, '..', 'claude-agy-plugin', 'scripts', 'claude-agy.mjs'),
  agyBin: process.env.AGY_BIN || 'agy',
  // Antigravity CLI state: conversation index and project definitions.
  agyStateDir: process.env.AGY_STATE_DIR || path.join(home, '.gemini', 'antigravity-cli'),
  agyProjectsDir: process.env.AGY_PROJECTS_DIR || path.join(home, '.gemini', 'config', 'projects'),
  // Testcases and their graded runs, written by each testcase's evaluate.py.
  playgroundDir: process.env.CLAUDE_AGY_PLAYGROUND || path.resolve(ROOT, '..', 'playground'),
  allowYolo: process.env.CLAUDE_AGY_ALLOW_YOLO === '1',
};
