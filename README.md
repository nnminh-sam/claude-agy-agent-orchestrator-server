# Claude-AGY orchestrator server

A local web dashboard for Antigravity agents that are delegated from Claude Code by the [claude-agy plugin](../claude-agy-plugin). It also covers the Antigravity CLI's own conversations, and the [playground](../playground)'s testcases with their graded runs. It runs on Node.js 22.5 or later with no npm dependencies and no build step.

```bash
npm start                 # http://127.0.0.1:4777
npm run dev               # restarts on file changes
npm test
```

## What it shows

| Page | Contents |
| --- | --- |
| **Overview** | Running agents, run counts, success rate, tokens in the last 7 days, a quota summary, recent runs, test runs passed and recent test runs |
| **Agents** | Running delegated agents, Antigravity conversations that are active anywhere (IDE, CLI or delegated), custom agent definitions, and available models |
| **Runs** | Every delegated run, filterable by status |
| **Run detail** | Task, model, mode, workspace, duration and token breakdown. Also a live activity timeline (each event expands to its raw JSON), the agent's final report, errors with stderr, a **Stop** button, and a link to the test run when the agent worked in one |
| **Testcases** | The playground's finalized testcases and samples, with difficulty, description, run count, passes and the last run |
| **Testcase** | Every run with its verdict, model, agent outcome, time, tokens and score per dimension. Also results by model, a check-by-run matrix of the latest 12 graded runs, how to start a run, the brief (`TASK.md`) and the README |
| **Test run** | Verdict and scores against the pass mark, the agent's model, outcome, time and tokens, the same diagnosis as `REPORT.md`, every check with the grader's detail, changed files with the diff, tool calls, the agent's final report, the activity timeline and the recorded files. While the agent works, the run shows its live status, `delegate.log` and timeline |
| **Usage** | Token totals, tokens per day for 14 days (with a table view), and breakdowns by model and by source |
| **Quota** | Remaining 5-hour and weekly quota per model group, with reset times and AI credits. Comes from `agy -p /usage`, which spends nothing |
| **Conversations** | Recent conversations from the Antigravity CLI index, linked to delegated runs and projects |
| **New task** | Starts a background run from the browser through the plugin's `claude-agy` CLI |

## Data sources

- **Delegated runs:** `~/.claude-agy/runs/*`. The plugin writes these; see the plugin README's "State contract".
- **Quota, credits, models and agents:** read-only `agy` commands, cached for 1–10 minutes.
- **Conversations:** `~/.gemini/antigravity-cli/conversation_summaries.db`, opened read-only through `node:sqlite`.
- **Projects:** `~/.gemini/config/projects/*.json`.
- **Testcases and test runs:** `<playground>/{testcases,samples}/<testcase>/` and `<playground>/{testcases,samples}/outputs/<testcase>/<N>/`, which each testcase's `evaluate.py` writes (see the playground's `samples/README.md`). A folder counts as a testcase when it has `TASK.md` or `evaluate.py`; `_grading/`, `outputs/` and `archives/` do not. A run without `summary.json` is not graded yet; the claude-agy run whose `--cwd` is its workspace says whether its agent is still working.

The server starts and stops runs **through the plugin CLI** (`claude-agy run --background`, `claude-agy stop`), so run supervision exists in one place only. For the same reason it only reads the playground: `python3 evaluate.py run` in a testcase folder starts a test run, and the dashboard shows it as soon as its workspace is set up.

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` / `HOST` | `4777` / `127.0.0.1` |
| `CLAUDE_AGY_HOME` | `~/.claude-agy` |
| `CLAUDE_AGY_CLI` | `../claude-agy-plugin/scripts/claude-agy.mjs` |
| `AGY_BIN` | `agy` |
| `AGY_STATE_DIR` | `~/.gemini/antigravity-cli` |
| `AGY_PROJECTS_DIR` | `~/.gemini/config/projects` |
| `CLAUDE_AGY_PLAYGROUND` | `../playground` |
| `CLAUDE_AGY_ALLOW_YOLO` | unset. Set it to `1` to allow "skip permission prompts" on dashboard launches |

## Security

The server can start agents on your machine, so:
- It binds to loopback by default and rejects requests whose `Host` is not a loopback name. This blocks DNS rebinding.
- Writes must be `application/json`, and any `Origin` must be its own. This blocks cross-site form posts.
- Launch input is validated: the workspace must be an absolute, existing directory, and the model and effort must be valid. Arguments are passed without a shell.
- Skipping agy permission prompts from the dashboard is off unless `CLAUDE_AGY_ALLOW_YOLO=1`.
- Test run files are served from a fixed list (`summary.json`, `grade.txt`, `grade.json`, `changes.diff`, `delegate.log` and `agent/*`), never from the workspace, and as `text/plain`.

## API

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/health` | Config and whether the CLI was found |
| GET | `/api/overview` | Counts, active and recent runs, 7-day usage, cached quota, test run counts and recent test runs |
| GET | `/api/runs` | All runs |
| POST | `/api/runs` | Launch a run. Body: `{prompt, cwd, model?, effort?, label?, plan?, sandbox?, yolo?}` |
| GET | `/api/runs/:id` | Metadata, response, stderr tail and `testRun` (`{collection, testcase, number}` or `null`) |
| GET | `/api/runs/:id/events?offset=N` | NDJSON events after byte `N`, plus `nextOffset` |
| POST | `/api/runs/:id/stop` | Cancel a run |
| GET | `/api/usage?days=14` | Token aggregates |
| GET | `/api/quota[?refresh]` | Quota groups and credits |
| GET | `/api/models`, `/api/agents`, `/api/conversations?limit=`, `/api/projects` | Antigravity data |
| GET | `/api/testcases` | Testcases by collection, with run counts and the last run |
| GET | `/api/testcases/:collection/:testcase` | Testcase details, runs, results by model and the check matrix |
| GET | `/api/testcases/:collection/:testcase/runs/:n` | A test run: grade, diagnosis, agent, tools, changes, files |
| GET | `/api/testcases/:collection/:testcase/runs/:n/events?offset=N` | The agent's NDJSON events after byte `N`, from the run's record or, until it is graded, from its live claude-agy run |
| GET | `/api/testcases/:collection/:testcase/runs/:n/files/:file` | One of the run's record files, as text |
