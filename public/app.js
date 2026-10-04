// Claude-AGY orchestrator dashboard. Plain ES modules, no build step.
const $view = document.getElementById('view');
const $tooltip = document.getElementById('tooltip');

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const int = (n) => (n == null ? '–' : Math.round(n).toLocaleString('en-US'));
function compact(n) {
  if (n == null) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}
function ago(iso) {
  if (!iso) return '–';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function dur(seconds) {
  if (seconds == null) return '–';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const elapsed = (run) => run.durationSeconds ?? (run.startedAt ? (Date.now() - Date.parse(run.startedAt)) / 1000 : null);
function until(iso) {
  const m = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (Number.isNaN(m)) return '';
  if (m <= 0) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.round(m / 1440)}d`;
}
const oneLine = (s, n = 90) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const runTitle = (r) => r.label || oneLine(r.prompt, 80);
const base = (p) => String(p ?? '').split('/').filter(Boolean).pop() ?? p;

const STATUS_TEXT = {
  starting: 'Starting', running: 'Running', succeeded: 'Succeeded', blocked: 'Blocked', failed: 'Failed', cancelled: 'Cancelled', lost: 'Lost',
  active: 'Running', idle: 'Idle', pass: 'Pass', fail: 'Fail', ungraded: 'Not graded', prepared: 'Prepared',
};
const status = (s) => `<span class="status ${esc(s)}"><span class="dot" aria-hidden="true"></span>${esc(STATUS_TEXT[s] ?? s)}</span>`;
const ACTIVE = new Set(['starting', 'running']);
const enc = encodeURIComponent;
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const mean = (values) => {
  const present = values.filter((v) => typeof v === 'number');
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
};
// Escapes text and renders its `code` spans.
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}
async function apiText(path) {
  const res = await fetch(path);
  const text = await res.text();
  if (!res.ok) {
    let message = null;
    try {
      message = JSON.parse(text).error;
    } catch {}
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  return text;
}
const post = (path, body = {}) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Same summarization as the plugin CLI, tolerant of how step payloads are nested.
function findKey(obj, key, maxDepth = 4) {
  let level = [obj];
  for (let d = 0; d <= maxDepth && level.length; d++) {
    const next = [];
    for (const node of level) {
      if (!node || typeof node !== 'object') continue;
      if (Object.hasOwn(node, key) && node[key] != null) return node[key];
      next.push(...Object.values(node));
    }
    level = next;
  }
  return undefined;
}
function describeEvent(e) {
  const kind = e.event ?? e.type ?? 'event';
  if (kind === 'result') return { kind, what: `Finished: ${e.status ?? e.result?.status ?? ''}` };
  if (kind === 'raw') return { kind, what: e.text };
  const parts = [];
  const stepType = findKey(e, 'step_type');
  if (stepType) parts.push(String(stepType).replace(/^CORTEX_STEP_TYPE_|^STEP_TYPE_/, '').toLowerCase().replace(/_/g, ' '));
  const tool = findKey(e, 'tool_info');
  if (tool) parts.push(tool.name ?? tool.canonical_name ?? tool.tool_name ?? 'tool');
  const sub = findKey(e, 'subagent_info');
  if (sub?.conversation_id) parts.push(`subagent ${sub.conversation_id.slice(0, 8)}`);
  for (const key of ['text', 'delta_text', 'message', 'summary', 'title']) {
    const v = findKey(e, key);
    if (typeof v === 'string' && v.trim()) {
      parts.push(`— ${oneLine(v, 160)}`);
      break;
    }
  }
  if (kind === 'init') parts.unshift('Session started');
  return { kind, what: parts.join(' ') || kind };
}

// ---------- polling & routing ----------
let timer = null;
let routeToken = 0;
function poll(fn, ms) {
  const token = routeToken;
  const tick = async () => {
    if (token !== routeToken) return;
    if (!document.hidden) {
      try {
        await fn();
      } catch (err) {
        console.warn(err);
      }
    }
    if (token === routeToken) timer = setTimeout(tick, ms);
  };
  tick();
}

const VIEWS = {
  '': overview,
  agents,
  runs,
  run: runDetail,
  testcases,
  testcase: testcaseDetail,
  testrun: testRunDetail,
  usage,
  quota,
  conversations,
};
const PARENT_TAB = { run: 'runs', testcase: 'testcases', testrun: 'testcases' };

function route() {
  routeToken += 1;
  clearTimeout(timer);
  hideTip();
  const [name = '', ...args] = location.hash.replace(/^#\/?/, '').split('/');
  const view = VIEWS[name] ?? overview;
  const tab = PARENT_TAB[name] ?? (name || 'overview');
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  $view.innerHTML = '<p class="sub">Loading…</p>';
  view(...args.map(decodeURIComponent));
}
window.addEventListener('hashchange', route);

function fail(err) {
  $view.innerHTML = `<div class="card error-box">${esc(err.message)}</div>`;
}

// ---------- shared fragments ----------
function runsTable(runs, { empty = 'No runs yet. Delegate one with /agy:delegate in Claude Code, or “New task”.' } = {}) {
  if (!runs.length) return `<p class="empty">${esc(empty)}</p>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Status</th><th>Task</th><th>Model</th><th>Source</th><th>Created</th><th class="num">Duration</th><th class="num">Tokens</th></tr></thead>
    <tbody>${runs.map((r) => `
      <tr class="link" data-href="#/run/${esc(r.id)}">
        <td>${status(r.status)}</td>
        <td><div class="truncate"><a href="#/run/${esc(r.id)}">${esc(runTitle(r))}</a></div><div class="sub mono">${esc(base(r.cwd))}</div></td>
        <td><span class="chip">${esc(r.model ?? 'default')}</span></td>
        <td class="sub">${esc(r.source ?? '–')}</td>
        <td class="sub" title="${esc(r.createdAt)}">${ago(r.createdAt)}</td>
        <td class="num">${dur(elapsed(r))}</td>
        <td class="num">${int(r.usage?.total_tokens)}</td>
      </tr>`).join('')}</tbody></table></div>`;
}
$view.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a,button')) location.hash = row.dataset.href;
});

function agentCards(runs) {
  if (!runs.length) return '<p class="empty">No agents running.</p>';
  return `<div class="agent-list">${runs.map((r) => `
    <a class="agent" href="#/run/${esc(r.id)}">
      <div class="row"><span class="title">${esc(runTitle(r))}</span>${status(r.status)}</div>
      <div class="row sub"><span>${esc(r.model ?? 'default model')} · ${esc(r.mode ?? '')} · ${esc(base(r.cwd))}</span><span>${dur(elapsed(r))}</span></div>
    </a>`).join('')}</div>`;
}

function meters(quota, { compactView = false } = {}) {
  if (!quota?.groups) return '<p class="sub">Loading quota…</p>';
  return quota.groups.map((g) => `
    <div class="meter-group">
      <h2>${esc(g.name)}</h2>
      ${compactView ? '' : `<p class="sub">${esc(g.description ?? '')}</p>`}
      ${(g.buckets ?? []).map((b) => {
        const pct = Math.round((b.remaining_fraction ?? 0) * 100);
        const level = pct < 10 ? 'critical' : pct < 25 ? 'warning' : '';
        const flag = level ? `<span aria-hidden="true">⚠ </span>${level === 'critical' ? 'Nearly exhausted · ' : 'Running low · '}` : '';
        return `<div class="meter ${level}">
          <div class="row"><span>${esc(b.name)}</span><span><span class="sub">${flag}</span><span class="pct">${pct}%</span> left</span></div>
          <div class="track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(`${g.name} ${b.name}`)}"><div class="fill" style="width:${pct}%"></div></div>
          <div class="note">Resets in ${esc(until(b.reset_time))} · ${esc(new Date(b.reset_time).toLocaleString())}${!compactView && b.description ? ` · ${esc(b.description)}` : ''}</div>
        </div>`;
      }).join('')}
    </div>`).join('');
}

const tile = (label, value, hint = '') => `<div class="card tile"><div class="label">${esc(label)}</div><div class="value">${value}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;

// ---------- views ----------
function overview() {
  let quotaRequested = false;
  poll(async () => {
    const o = await api('/api/overview');
    if (!o.quota && !quotaRequested) {
      quotaRequested = true;
      api('/api/quota').catch(() => {});
    }
    const finished = o.counts.succeeded + o.counts.failed;
    const t = o.tests;
    $view.innerHTML = `
      <div class="page-head"><h1>Overview</h1><span class="sub">Antigravity agents delegated from Claude Code and this dashboard</span></div>
      <div class="tiles">
        ${tile('Running agents', int(o.counts.active))}
        ${tile('Delegated runs', int(o.counts.total), `${o.counts.failed} failed · ${o.counts.cancelled} cancelled`)}
        ${tile('Success rate', finished ? `${Math.round((o.counts.succeeded / finished) * 100)}%` : '–', 'of finished runs')}
        ${tile('Tokens, last 7 days', compact(o.usage.totals.total_tokens), `${o.usage.runsWithUsage} runs with usage data`)}
        ${t.available ? tile('Test runs passed', t.graded ? `${t.passed}/${t.graded}` : '–', `${t.testcases} testcases${t.running ? ` · ${t.running} running` : ''}`) : ''}
      </div>
      <div class="cols">
        <section class="card"><h2>Running agents</h2>${agentCards(o.active)}</section>
        <section class="card"><div class="page-head"><h2>Quota</h2><a href="#/quota">Details</a></div>${meters(o.quota, { compactView: true })}</section>
      </div>
      <section class="card"><div class="page-head"><h2>Recent runs</h2><a href="#/runs">All runs</a></div>${runsTable(o.recent)}</section>
      ${t.available ? `<section class="card"><div class="page-head"><h2>Recent test runs</h2><a href="#/testcases">All testcases</a></div>${recentTestRuns(t.recent)}</section>` : ''}`;
  }, 3000);
}

function agents() {
  poll(async () => {
    const [a, models] = await Promise.all([api('/api/agents'), api('/api/models').catch(() => [])]);
    $view.innerHTML = `
      <div class="page-head"><h1>Agents</h1><span class="sub">What is running now, and what agy can run</span></div>
      <div class="cols">
        <section class="card"><h2>Delegated agents (claude-agy)</h2>${agentCards(a.delegated)}</section>
        <section class="card"><h2>Active Antigravity conversations</h2>
          ${a.antigravity.length ? `<div class="agent-list">${a.antigravity.map((c) => `
            <div class="agent"><div class="row"><span class="title">${esc(c.title || c.id)}</span>${status('active')}</div>
            <div class="row sub"><span>${esc(c.workspaces.map(base).join(', '))}</span><span>${int(c.steps)} steps</span></div></div>`).join('')}</div>`
            : '<p class="empty">No Antigravity conversation is running (IDE, CLI or delegated).</p>'}
        </section>
      </div>
      <div class="cols">
        <section class="card"><h2>Custom agents</h2>
          ${a.definitions.length ? `<ul>${a.definitions.map((d) => `<li class="mono">${esc(d)}</li>`).join('')}</ul>`
            : '<p class="notice">No custom agents defined. Add them under <code>.agents/agents/</code> in a workspace and pass <code>--agent NAME</code> to <code>claude-agy run</code>.</p>'}
        </section>
        <section class="card"><h2>Models</h2>
          ${models.length ? `<table><thead><tr><th>ID</th><th>Name</th></tr></thead><tbody>${models.map((m) => `<tr><td class="mono">${esc(m.id)}</td><td>${esc(m.name)}</td></tr>`).join('')}</tbody></table>` : '<p class="sub">Model list unavailable.</p>'}
        </section>
      </div>`;
  }, 5000);
}

let runsFilter = 'all';
function runs() {
  const filters = ['all', 'running', 'succeeded', 'failed', 'cancelled'];
  const filter = runsFilter;
  poll(async () => {
    const all = await api('/api/runs');
    const shown = filter === 'all' ? all
      : filter === 'running' ? all.filter((r) => ACTIVE.has(r.status))
      : filter === 'failed' ? all.filter((r) => r.status === 'failed' || r.status === 'lost')
      : all.filter((r) => r.status === filter);
    $view.innerHTML = `
      <div class="page-head"><h1>Runs</h1>
        <div class="checks" role="group" aria-label="Filter by status">${filters.map((f) => `<button class="btn${f === filter ? ' primary' : ''}" data-filter="${f}" type="button">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div>
      </div>
      <section class="card">${runsTable(shown, { empty: filter === 'all' ? undefined : `No ${filter} runs.` })}</section>`;
    $view.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
      runsFilter = b.dataset.filter;
      routeToken += 1;
      clearTimeout(timer);
      runs.call(null);
    }));
  }, 3000);
}

function runDetail(id) {
  let offset = 0;
  let count = 0;
  let shellReady = false;
  let chat = null;
  poll(async () => {
    const [run, ev] = await Promise.all([api(`/api/runs/${encodeURIComponent(id)}`), api(`/api/runs/${encodeURIComponent(id)}/events?offset=${offset}`)]);
    if (!shellReady) {
      $view.innerHTML = `
        <div class="page-head"><div><a href="#/runs">← Runs</a><h1 id="run-title"></h1></div><div id="run-actions"></div></div>
        <div class="cols">
          <section class="card"><h2>Details</h2><dl class="kv" id="run-kv"></dl></section>
          <section class="card mdv" ${mdAttrs('run-task')}><div class="page-head"><h2>Task</h2>${mdToggle()}</div>${mdPanes(run.prompt)}</section>
        </div>
        <div id="run-error"></div>
        <section class="card mdv" id="run-response-card" hidden ${mdAttrs('run-report')}><div class="page-head"><h2>Agent report</h2>${mdToggle()}</div><div id="run-response"></div></section>
        <section class="card">
          <div class="page-head"><h2>Activity</h2>
            <div class="checks"><span class="sub" id="run-count"></span>${activitySwitch()}</div></div>
          <div class="chat" id="run-chat"></div>
          <div class="timeline" id="run-timeline"></div>
        </section>`;
      initMdViews($view);
      chat = createChat(document.getElementById('run-chat'), run);
      bindActivitySwitch();
      shellReady = true;
    }
    setHtml(document.getElementById('run-title'), `${esc(runTitle(run))} ${status(run.status)}`);
    // Re-rendered only when the status changes, so a clicked button stays disabled and gets one listener.
    if (setHtml(document.getElementById('run-actions'), ACTIVE.has(run.status) ? '<button class="btn danger" id="stop" type="button">Stop agent</button>' : '')) {
      document.getElementById('stop')?.addEventListener('click', async (e) => {
        if (!confirm('Stop this agent? Edits it already made stay in the workspace.')) return;
        e.target.disabled = true;
        try {
          await post(`/api/runs/${encodeURIComponent(id)}/stop`);
        } catch (err) {
          alert(err.message);
        }
      });
    }
    const u = run.usage;
    const kv = [
      ['Run', `<span class="mono">${esc(run.id)}</span>`],
      ['Model', esc(run.model ?? 'agy default')],
      ['Mode', esc([run.mode, run.effort && `effort ${run.effort}`, run.sandbox && 'sandbox', run.skipPermissions && 'permissions skipped'].filter(Boolean).join(' · '))],
      ['Workspace', `<span class="mono">${esc(run.cwd)}</span>`],
      ['Source', esc(run.source ?? '–')],
      ['Created', `${esc(new Date(run.createdAt).toLocaleString())} (${ago(run.createdAt)})`],
      ['Duration', `${dur(elapsed(run))}${run.numTurns != null ? ` · ${run.numTurns} turns` : ''}`],
      ['Tokens', u ? `${int(u.total_tokens)} total · ${int(u.input_tokens)} in · ${int(u.output_tokens)} out · ${int(u.thinking_tokens)} thinking · ${int(u.cache_read_tokens)} cache read` : '–'],
      ['Conversation', run.conversationId ? `<span class="mono">${esc(run.conversationId)}</span>` : '–'],
      ...(run.testRun ? [['Test run', `<a href="${testRunHref(run.testRun.collection, run.testRun.testcase, run.testRun.number)}">${esc(run.testRun.testcase)} #${run.testRun.number}</a>`]] : []),
    ];
    setHtml(document.getElementById('run-kv'), kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(''));
    // Polling must not rebuild this section unless it changed: rebuilding closes the stderr <details>.
    setHtml(document.getElementById('run-error'), run.error
      ? `<div class="card error-box"><strong>Error</strong><pre class="block">${typeof run.error === 'string' ? esc(run.error) : jsonHtml(run.error)}</pre>
         ${run.stderr ? `<details><summary>stderr</summary><pre class="block">${esc(run.stderr)}</pre></details>` : ''}</div>`
      : run.status === 'lost' ? '<div class="card error-box">The supervising process exited without recording an outcome.</div>' : '');
    if (run.response) {
      document.getElementById('run-response-card').hidden = false;
      setHtml(document.getElementById('run-response'), agentPanes(run.response));
    }
    const $tl = document.getElementById('run-timeline');
    count += appendEvents($tl, ev.events);
    chat.add(ev.events, ACTIVE.has(run.status));
    offset = ev.nextOffset;
    document.getElementById('run-count').textContent = `${count} events${ACTIVE.has(run.status) ? ' · live' : ''}`;
    if (!count) $tl.innerHTML = '<p class="empty">No events yet.</p>';
  }, 1500);
}

// Sets an element's HTML only when it changed, so polling keeps what the user opened, selected or clicked.
const renderedHtml = new WeakMap();
function setHtml(el, html) {
  if (renderedHtml.get(el) === html) return false;
  renderedHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

// Appends events to an activity timeline, staying scrolled to the end if it was there. Returns how many it added.
function appendEvents($tl, events) {
  const stick = $tl.scrollHeight - $tl.scrollTop - $tl.clientHeight < 40;
  if (events.length) $tl.querySelector('.empty')?.remove();
  for (const e of events) {
    const { kind, what } = describeEvent(e);
    const el = document.createElement('details');
    el.innerHTML = `<summary><span class="kind">${esc(kind)}</span><span class="what">${esc(what)}</span></summary><pre class="json"></pre>`;
    const pre = el.querySelector('pre');
    el.addEventListener('toggle', () => {
      if (el.open && !pre.firstChild) pre.innerHTML = jsonHtml(e);
    });
    $tl.append(el);
  }
  if (stick) $tl.scrollTop = $tl.scrollHeight;
  return events.length;
}

// ---------- activity as a chat ----------
// agy streams steps, not messages: an agent_response step's text arrives as text_delta chunks, and a tool step
// arrives as ACTIVE, then DONE or ERROR. The chat merges each step into one message, keyed by conversation and index.

const ACTIVITY_VIEW_KEY = 'claude-agy:activity-view';
function activityView() {
  try {
    return localStorage.getItem(ACTIVITY_VIEW_KEY) === 'events' ? 'events' : 'chat';
  } catch {
    return 'chat';
  }
}
const activitySwitch = () => `<div class="seg" role="group" aria-label="Show activity as">${['chat', 'events'].map((v) =>
  `<button type="button" data-view="${v}" aria-pressed="${activityView() === v}">${v === 'chat' ? 'Chat' : 'Events'}</button>`).join('')}</div>`;
function bindActivitySwitch() {
  const show = (view) => {
    $view.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    $view.querySelector('.chat').hidden = view !== 'chat';
    $view.querySelector('.timeline').hidden = view !== 'events';
  };
  $view.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    try {
      localStorage.setItem(ACTIVITY_VIEW_KEY, b.dataset.view);
    } catch {}
    show(b.dataset.view);
  }));
  show(activityView());
}

const SOURCE_LABEL = { 'claude-code': 'Claude Code', dashboard: 'Dashboard', cli: 'claude-agy CLI' };
const REPORT_STATUS = { done: 'succeeded', blocked: 'blocked', failed: 'failed' };
// The parameter that says what a tool call is about, shown on its one-line summary.
const TOOL_SUBJECT = ['CommandLine', 'TargetFile', 'AbsolutePath', 'FilePath', 'File', 'DirectoryPath', 'SearchPath', 'Path', 'Query', 'SearchQuery', 'Url', 'Pattern'];

// ---------- markdown and JSON ----------

// Escapes text and renders inline markdown: `code`, **bold**, *italic* and [links](url); images show as links.
// Only http(s) links become anchors; other targets (files, relative paths) show on hover.
function mdInline(text) {
  const s = String(text ?? '');
  let html = '';
  let last = 0;
  for (const m of s.matchAll(/`([^`]+)`|!?\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|\*(?=\S)([^*]+?)(?<=\S)\*/g)) {
    html += esc(s.slice(last, m.index));
    if (m[1] != null) html += `<code>${esc(m[1])}</code>`;
    else if (m[2] != null) {
      html += /^https?:\/\//i.test(m[3])
        ? `<a href="${esc(m[3])}" target="_blank" rel="noopener">${mdInline(m[2])}</a>`
        : `<span class="md-link" title="${esc(m[3].replace(/^file:\/\//, ''))}">${mdInline(m[2])}</span>`;
    } else if (m[4] != null) html += `<strong>${mdInline(m[4])}</strong>`;
    else html += `<em>${mdInline(m[5])}</em>`;
    last = m.index + m[0].length;
  }
  return html + esc(s.slice(last));
}

const MD = {
  fence: /^(\s*)(```|~~~)/,
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  rule: /^\s*([-*_])(\s*\1){2,}\s*$/,
  item: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
  row: /^\s*\|.*\|\s*$/,
  separator: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
  quote: /^\s*>/,
};

// A fenced code block starting at lines[i]; returns [html, index after it]. `indent` is removed from its lines.
function mdFence(lines, i, indent = 0) {
  const fence = MD.fence.exec(lines[i])[2];
  const body = [];
  for (i += 1; i < lines.length && !lines[i].trim().startsWith(fence); i++) body.push(lines[i].slice(Math.min(indent, lines[i].search(/\S|$/))));
  return [`<pre class="block">${esc(body.join('\n'))}</pre>`, i + 1];
}

// A list starting at lines[i], with deeper-indented items as nested lists; returns [html, index after it].
function mdList(lines, i) {
  const first = MD.item.exec(lines[i]);
  const indent = first[1].length;
  const tag = /\d/.test(first[2]) ? 'ol' : 'ul';
  const items = [];
  while (i < lines.length) {
    const line = lines[i];
    const m = MD.item.exec(line);
    const lead = line.search(/\S|$/);
    if (m && m[1].length === indent) {
      if (/\d/.test(m[2]) !== (tag === 'ol')) break; // a different kind of marker starts a new list
      items.push({ text: [m[3]], children: '' });
      i += 1;
    } else if (m && m[1].length > indent && items.length) {
      const [html, next] = mdList(lines, i);
      items.at(-1).children += html;
      i = next;
    } else if (!line.trim()) {
      // A blank line ends the list unless an item at this depth or deeper follows.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const n = MD.item.exec(lines[j] ?? '');
      if (!n || n[1].length < indent) break;
      i = j;
    } else if (lead > indent && items.length && MD.fence.test(line)) {
      const [html, next] = mdFence(lines, i, lead);
      items.at(-1).children += html;
      i = next;
    } else if (lead > indent && items.length) {
      items.at(-1).text.push(line.trim());
      i += 1;
    } else break;
  }
  return [`<${tag}>${items.map((it) => `<li>${it.text.map(mdInline).join('<br>')}${it.children}</li>`).join('')}</${tag}>`, i];
}

// Renders block markdown: headings, paragraphs, nested lists, tables, quotes, fenced code and rules.
// Everything is escaped, so HTML inside the markdown shows as text.
function markdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => mdInline(c.trim().replace(/\\\|/g, '|')));
  const startsBlock = (l) => MD.fence.test(l) || MD.heading.test(l) || MD.rule.test(l) || MD.item.test(l) || MD.quote.test(l) || MD.row.test(l);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = MD.heading.exec(line);
    let html;
    if (!line.trim()) {
      i += 1;
      continue;
    } else if (MD.fence.test(line)) {
      [html, i] = mdFence(lines, i, line.search(/\S/));
    } else if (heading) {
      html = `<p class="md-h md-h${heading[1].length}">${mdInline(heading[2])}</p>`;
      i += 1;
    } else if (MD.rule.test(line)) {
      html = '<hr>';
      i += 1;
    } else if (MD.row.test(line) && MD.separator.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && MD.row.test(lines[i]); i++) rows.push(cells(lines[i]));
      html = `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } else if (MD.quote.test(line)) {
      const body = [];
      for (; i < lines.length && MD.quote.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''));
      html = `<blockquote>${markdown(body.join('\n'))}</blockquote>`;
    } else if (MD.item.test(line)) {
      [html, i] = mdList(lines, i);
    } else {
      const para = [line.trim()];
      for (i += 1; i < lines.length && lines[i].trim() && !startsBlock(lines[i]); i++) para.push(lines[i].trim());
      html = `<p>${para.map(mdInline).join('<br>')}</p>`;
    }
    out.push(html);
  }
  return out.join('');
}

// Pretty-prints a value as JSON with keys, strings, numbers and literals marked for highlighting.
function jsonHtml(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  let html = '';
  let last = 0;
  for (const m of text.matchAll(/("(?:[^"\\\n]|\\.)*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g)) {
    html += esc(text.slice(last, m.index));
    if (m[1] != null) html += `<span class="${m[2] ? 'j-key' : 'j-str'}">${esc(m[1])}</span>${esc(m[2] ?? '')}`;
    else html += `<span class="${/\d/.test(m[0]) ? 'j-num' : 'j-lit'}">${m[0]}</span>`;
    last = m.index + m[0].length;
  }
  return html + esc(text.slice(last));
}

// A markdown view: rendered by default, switchable to the raw source. Put mdToggle() and mdPanes() inside an element
// with mdAttrs(); one click handler on the document switches every view, including ones rendered later.
// Raw is remembered as the default for views rendered afterwards.
const MD_MODE_KEY = 'claude-agy:markdown-view';
function mdDefaultMode() {
  try {
    return localStorage.getItem(MD_MODE_KEY) === 'raw' ? 'raw' : 'preview';
  } catch {
    return 'preview';
  }
}
const mdAttrs = (key = '') => `data-mode="${mdDefaultMode()}"${key ? ` data-key="${esc(key)}"` : ''}`;
const mdToggle = () => `<span class="seg seg-sm" role="group" aria-label="Show markdown as">
  <button type="button" data-md="preview">Preview</button><button type="button" data-md="raw">Raw</button></span>`;
// `preview` replaces the rendered markdown (for example an executor report), and `raw` the escaped source.
const mdPanes = (text, { preview, raw, extra = '' } = {}) =>
  `<div class="md md-preview">${preview ?? markdown(text)}${extra}</div><pre class="block md-raw">${raw ?? esc(text)}</pre>`;
function setMdMode(view, mode) {
  view.dataset.mode = mode;
  view.querySelectorAll(':scope [data-md]').forEach((b) => {
    if (b.closest('.mdv') === view) b.setAttribute('aria-pressed', String(b.dataset.md === mode));
  });
}
document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-md]');
  const view = button?.closest('.mdv');
  if (!view) return;
  e.preventDefault();
  setMdMode(view, button.dataset.md);
  try {
    localStorage.setItem(MD_MODE_KEY, button.dataset.md);
  } catch {}
});
// Marks the pressed button of every markdown view under `root`, after it was rendered.
const initMdViews = (root) => root.querySelectorAll('.mdv').forEach((v) => setMdMode(v, v.dataset.mode));

// Carries what the user opened or switched over to a re-rendered element: keyed elements by key, else by position.
function saveViewState(root) {
  return {
    keyed: new Map([...root.querySelectorAll('[data-key]')].map((el) => [el.dataset.key, { open: el.open, mode: el.dataset.mode }])),
    open: [...root.querySelectorAll('details')].map((d) => d.open),
    modes: [...root.querySelectorAll('.mdv')].map((v) => v.dataset.mode),
  };
}
function restoreViewState(root, state, { byPosition = false } = {}) {
  if (byPosition) {
    root.querySelectorAll('details').forEach((d, i) => {
      if (state.open[i]) d.open = true;
    });
    root.querySelectorAll('.mdv').forEach((v, i) => {
      if (state.modes[i]) v.dataset.mode = state.modes[i];
    });
  }
  root.querySelectorAll('[data-key]').forEach((el) => {
    const saved = state.keyed.get(el.dataset.key);
    if (saved?.open != null && el.tagName === 'DETAILS') el.open = saved.open;
    if (saved?.mode) el.dataset.mode = saved.mode;
  });
  initMdViews(root);
}

// The claude-agy executor report the agent ends with, when its text is one.
function parseReport(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const report = JSON.parse(trimmed);
    return typeof report?.summary === 'string' && typeof report.status === 'string' ? report : null;
  } catch {
    return null;
  }
}

// Panes for an agent's message: its executor report when it is one (raw: the report as JSON), otherwise markdown.
function agentPanes(text, options = {}) {
  const report = parseReport(text);
  return report ? mdPanes(text, { ...options, preview: reportHtml(report), raw: jsonHtml(report) }) : mdPanes(text, options);
}

function reportHtml(r) {
  const section = (title, items, render) => (Array.isArray(items) && items.length
    ? `<div class="rep-h">${title}</div><ul>${items.map((x) => `<li>${render(x)}</li>`).join('')}</ul>` : '');
  const text = (x) => mdInline(typeof x === 'string' ? x : JSON.stringify(x));
  return `<div class="report">
    <div class="rep-head">${status(REPORT_STATUS[r.status] ?? r.status)}<span>${mdInline(r.summary)}</span></div>
    ${r.details ? markdown(r.details) : ''}
    ${section('Changes', r.changes, (c) => `<code>${esc(c.path)}</code> ${mdInline(c.change ?? '')}`)}
    ${section('Verification', r.verification, (v) => `<span class="${v.passed ? 'cell-ok' : 'cell-no'}">${v.passed ? '✓' : '✗'}</span> <code>${esc(v.command)}</code>${v.output ? `<pre class="block">${esc(v.output)}</pre>` : ''}`)}
    ${section('Assumptions', r.assumptions, text)}
    ${section('Remaining', r.remaining, text)}
    ${section('Blockers', r.blockers, (b) => (typeof b === 'string' ? mdInline(b)
      : `<strong>${esc(b.kind ?? 'blocker')}</strong> ${mdInline(b.detail ?? '')}${b.target ? ` <code>${esc(b.target)}</code>` : ''}${b.needs ? ` · needs ${mdInline(b.needs)}` : ''}`))}
  </div>`;
}

const shortDur = (s) => (s == null ? '' : s < 1 ? `${Math.round(s * 1000)} ms` : dur(s));

function toolParams(params) {
  return Object.entries(params).map(([k, v]) => {
    if (typeof v !== 'string') return `${k}: ${JSON.stringify(v)}`;
    return v.includes('\n') ? `${k}:\n${v}` : `${k}: ${v}`;
  }).join('\n');
}

function chatItemHtml(item, run) {
  const sub = item.sub ? ` <span class="chip">subagent ${esc(item.sub)}</span>` : '';
  if (item.type === 'user') {
    return `<div class="bubble mdv" ${mdAttrs()}><div class="who"><span>${esc(SOURCE_LABEL[run.source] ?? 'Task')}</span>${mdToggle()}</div>${mdPanes(item.text)}</div>`;
  }
  if (item.type === 'agent') {
    const meta = [item.duration != null && shortDur(item.duration), item.usage?.total_tokens != null && `${int(item.usage.total_tokens)} tokens`].filter(Boolean).join(' · ');
    // While it streams, the text is shown as it comes; a finished one may turn out to be the executor report.
    const panes = item.state === 'ACTIVE' ? mdPanes(item.text, { extra: '<span class="caret" aria-hidden="true"></span>' }) : agentPanes(item.text);
    return `<div class="bubble mdv" ${mdAttrs()}><div class="who"><span>Antigravity · ${esc(run.model ?? 'agy')}${sub}${meta ? ` <span class="meta">${meta}</span>` : ''}</span>${mdToggle()}</div>${panes}</div>`;
  }
  if (item.type === 'tool') {
    const params = item.params ?? {};
    const key = TOOL_SUBJECT.find((k) => typeof params[k] === 'string') ?? Object.keys(params).find((k) => typeof params[k] === 'string');
    let subject = key ? params[key] : '';
    if (run.cwd && subject.startsWith(`${run.cwd}/`)) subject = subject.slice(run.cwd.length + 1);
    const state = item.state === 'ERROR' ? 'error' : item.state === 'DONE' ? 'done' : 'active';
    const badge = state === 'active' ? '<span class="tool-state">running…</span>'
      : state === 'error' ? '<span class="tool-state no">✗ failed</span>' : `<span class="tool-state ok">✓ ${esc(shortDur(item.duration))}</span>`;
    const output = item.output != null ? String(item.output) : '';
    return `<div class="tool-wrap"><details class="tool ${state}">
        <summary><span class="tool-name">${esc(item.name ?? 'tool')}</span><span class="tool-arg">${esc(oneLine(subject, 160))}</span>${sub}${badge}</summary>
        <div class="tool-body">
          ${Object.keys(params).length ? `<div class="rep-h">Input</div><pre class="block">${esc(toolParams(params))}</pre>` : ''}
          ${output ? `<div class="rep-h">Output</div><pre class="block">${esc(output.length > 20000 ? `${output.slice(0, 20000)}\n… (truncated)` : output)}</pre>` : ''}
          ${!Object.keys(params).length && !output ? '<p class="sub">No input or output recorded.</p>' : ''}
        </div>
      </details>${item.error ? `<div class="tool-error">${esc(item.error.message ?? JSON.stringify(item.error))}</div>` : ''}</div>`;
  }
  if (item.type === 'result') {
    const u = item.usage;
    const parts = [item.status && `Finished: ${item.status}`, item.duration != null && dur(item.duration), item.turns != null && `${item.turns} turn${item.turns === 1 ? '' : 's'}`,
      u?.total_tokens != null && `${int(u.total_tokens)} tokens`, item.denied?.length && `denied ${item.denied.map((d) => d.display_name || d.action).join(', ')}`];
    return `<div class="divider">${esc(parts.filter(Boolean).join(' · ') || 'Finished')}</div>`;
  }
  return `<div class="divider">${esc(item.text)}${sub}</div>`;
}

// Renders events as a conversation and keeps it current as more arrive. Only messages whose HTML changed are
// replaced, and opened tool calls stay open.
function createChat($el, run) {
  const items = new Map();
  const nodes = new Map();
  let mainConversation = null;
  let userShown = false;
  let raw = 0;
  $el.innerHTML = '<p class="empty">No activity yet.</p><div class="msg msg-agent typing" hidden><div class="bubble"><span class="dots" aria-label="The agent is working"><i></i><i></i><i></i></span></div></div>';
  const $typing = $el.querySelector('.typing');

  function ingest(e) {
    const kind = e.event ?? e.type;
    if (kind === 'init') {
      mainConversation = e.conversation_id ?? e.init?.conversation_id ?? null;
      const init = e.init ?? {};
      items.set('init', { type: 'system', text: `Session started${init.model ? ` with ${init.model}` : ''}${init.permission_mode ? ` · ${init.permission_mode}` : ''}` });
      return;
    }
    if (kind === 'result') {
      const r = e.result && typeof e.result === 'object' ? e.result : e;
      items.set('result', { type: 'result', status: r.status, duration: r.duration_seconds, turns: r.num_turns, usage: r.usage, denied: r.denied_actions });
      return;
    }
    const s = e.step_update;
    if (!s) {
      items.set(`raw-${raw++}`, { type: 'system', text: kind === 'raw' ? e.text : describeEvent(e).what });
      return;
    }
    const key = `${s.conversation_id ?? ''}:${s.step_index}`;
    const sub = mainConversation && s.conversation_id && s.conversation_id !== mainConversation ? s.conversation_id.slice(0, 8) : null;
    const item = items.get(key) ?? { sub };
    if (s.step_type === 'user_input') {
      // The step carries no text; the first one is the task claude-agy sent.
      Object.assign(item, { type: 'user', text: item.text ?? (userShown || sub ? '(user input)' : run.prompt) });
      userShown ||= !sub;
    } else if (s.step_type === 'agent_response') {
      Object.assign(item, { type: 'agent', text: (item.text ?? '') + (s.text_delta ?? s.delta_text ?? s.text ?? ''), state: s.state });
      item.duration = s.duration_seconds ?? item.duration;
      item.usage = s.usage ?? item.usage;
    } else if (s.step_type === 'tool') {
      const info = s.tool_info ?? {};
      Object.assign(item, {
        type: 'tool', state: s.state, name: s.tool_name ?? info.name ?? item.name, params: info.parameters ?? item.params,
        output: info.output ?? item.output, error: info.error ?? item.error, duration: s.duration_seconds ?? item.duration,
      });
    } else if (s.text_delta || s.text) {
      Object.assign(item, { type: 'system', text: (item.text ?? '') + (s.text_delta ?? s.text) });
    } else if (s.step_type === 'finish' || s.step_type === 'system_message') {
      return; // carry nothing to show; the result event reports the outcome
    } else {
      Object.assign(item, { type: 'system', text: String(s.step_type ?? 'step').replace(/_/g, ' ') });
    }
    items.set(key, item);
  }

  return {
    add(events, active) {
      events.forEach(ingest);
      let prev = null;
      for (const [key, item] of items) {
        const node = nodes.get(key);
        // An agent turn that only chose tools has no text; its tool calls follow as their own messages.
        if (item.type === 'agent' && !item.text.trim()) {
          node?.el.remove();
          nodes.delete(key);
          continue;
        }
        const html = chatItemHtml(item, run);
        if (node?.html !== html) {
          const el = document.createElement('div');
          el.className = `msg msg-${item.type}`;
          el.innerHTML = html;
          if (node) {
            const state = saveViewState(node.el);
            node.el.replaceWith(el);
            restoreViewState(el, state, { byPosition: true });
          } else {
            if (prev) prev.after(el);
            else $el.prepend(el);
            initMdViews(el);
          }
          nodes.set(key, { el, html });
        }
        prev = nodes.get(key).el;
      }
      $el.querySelector(':scope > .empty')?.toggleAttribute('hidden', nodes.size > 0 || active);
      $typing.hidden = !active;
      $el.append($typing);
    },
  };
}

function usage() {
  poll(async () => {
    const u = await api('/api/usage?days=14');
    const t = u.totals;
    const models = Object.entries(u.byModel).sort((a, b) => b[1].total_tokens - a[1].total_tokens);
    const sources = Object.entries(u.bySource).sort((a, b) => b[1].total_tokens - a[1].total_tokens);
    const rows = (entries) => entries.map(([name, r]) => `<tr><td class="name">${esc(name)}</td><td class="num">${int(r.runs)}</td><td class="num">${int(r.input_tokens)}</td><td class="num">${int(r.output_tokens)}</td><td class="num">${int(r.thinking_tokens)}</td><td class="num">${int(r.cache_read_tokens)}</td><td class="num">${int(r.total_tokens)}</td></tr>`).join('');
    const head = (first) => `<thead><tr><th>${first}</th><th class="num">Runs</th><th class="num">Input</th><th class="num">Output</th><th class="num">Thinking</th><th class="num">Cache read</th><th class="num">Total</th></tr></thead>`;
    $view.innerHTML = `
      <div class="page-head"><h1>Token usage</h1><span class="sub">All delegated runs with a recorded result. Quota is tracked by Antigravity, see Quota.</span></div>
      <div class="tiles">
        ${tile('Total tokens', compact(t.total_tokens), `${u.runsWithUsage} runs`)}
        ${tile('Input', compact(t.input_tokens))}
        ${tile('Output', compact(t.output_tokens))}
        ${tile('Thinking', compact(t.thinking_tokens))}
        ${tile('Cache read', compact(t.cache_read_tokens))}
      </div>
      <section class="card chart"><h2>Total tokens per day, last 14 days</h2>${columnChart(u.daily)}</section>
      <div class="cols">
        <section class="card"><h2>By model</h2>${models.length ? `<div class="table-wrap"><table>${head('Model')}<tbody>${rows(models)}</tbody></table></div>` : '<p class="empty">No usage yet.</p>'}</section>
        <section class="card"><h2>By source</h2>${sources.length ? `<div class="table-wrap"><table>${head('Source')}<tbody>${rows(sources)}</tbody></table></div>` : '<p class="empty">No usage yet.</p>'}</section>
      </div>`;
    bindChart(u.daily);
  }, 10000);
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}
const shortDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function columnChart(daily) {
  // Size the SVG to its card so text renders at its CSS size instead of being scaled.
  const W = Math.max(280, Math.min(1200, $view.clientWidth) - 48 - 38), H = 220, L = 52, R = 8, T = 10, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(0, ...daily.map((d) => d.total_tokens));
  const step = max ? niceStep(max / 4) : 1;
  const top = max ? Math.ceil(max / step) * step : 4;
  const y = (v) => T + ih - (v / top) * ih;
  const band = iw / daily.length;
  const bw = Math.min(24, band * 0.6);
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += max ? step : 1) ticks.push(v);
  const labelEvery = Math.ceil(daily.length / 7);
  const bars = daily.map((d, i) => {
    const x = L + band * i + (band - bw) / 2;
    const h = Math.max(0, (d.total_tokens / top) * ih);
    const r = Math.min(4, h, bw / 2);
    const yb = T + ih;
    const path = h > 0 ? `M${x},${yb}V${yb - h + r}Q${x},${yb - h} ${x + r},${yb - h}H${x + bw - r}Q${x + bw},${yb - h} ${x + bw},${yb - h + r}V${yb}Z` : '';
    return `<g data-i="${i}"><rect class="hit" x="${L + band * i}" y="${T}" width="${band}" height="${ih}"></rect>${path ? `<path class="bar" d="${path}"></path>` : ''}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Column chart of total tokens per day for the last ${daily.length} days, peak ${int(max)}">
    ${ticks.map((v) => `<line class="${v === 0 ? 'baseline' : 'gridline'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"></line><text class="tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join('')}
    ${daily.map((d, i) => (i % labelEvery === (daily.length - 1) % labelEvery ? `<text class="tick" x="${L + band * i + band / 2}" y="${H - 6}" text-anchor="middle">${esc(shortDay(d.day))}</text>` : '')).join('')}
    ${bars}
  </svg>
  <details><summary class="sub">Show as table</summary><div class="table-wrap"><table><thead><tr><th>Day</th><th class="num">Runs</th><th class="num">Input</th><th class="num">Output</th><th class="num">Thinking</th><th class="num">Cache read</th><th class="num">Total</th></tr></thead>
  <tbody>${daily.map((d) => `<tr><td>${esc(shortDay(d.day))}</td><td class="num">${int(d.runs)}</td><td class="num">${int(d.input_tokens)}</td><td class="num">${int(d.output_tokens)}</td><td class="num">${int(d.thinking_tokens)}</td><td class="num">${int(d.cache_read_tokens)}</td><td class="num">${int(d.total_tokens)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

function bindChart(daily) {
  $view.querySelectorAll('.chart svg g[data-i]').forEach((g) => {
    const d = daily[Number(g.dataset.i)];
    g.addEventListener('mousemove', (e) => {
      g.classList.add('on');
      showTip(e, `<div class="t-head">${esc(shortDay(d.day))}</div>
        <div class="t-row"><span>Total</span><span>${int(d.total_tokens)}</span></div>
        <div class="t-row"><span>Input</span><span>${int(d.input_tokens)}</span></div>
        <div class="t-row"><span>Output</span><span>${int(d.output_tokens)}</span></div>
        <div class="t-row"><span>Thinking</span><span>${int(d.thinking_tokens)}</span></div>
        <div class="t-row"><span>Cache read</span><span>${int(d.cache_read_tokens)}</span></div>
        <div class="t-row"><span>Runs</span><span>${int(d.runs)}</span></div>`);
    });
    g.addEventListener('mouseleave', () => {
      g.classList.remove('on');
      hideTip();
    });
  });
}
function showTip(e, html) {
  $tooltip.innerHTML = html;
  $tooltip.hidden = false;
  const { width, height } = $tooltip.getBoundingClientRect();
  const x = Math.min(e.clientX + 14, innerWidth - width - 8);
  const y = e.clientY - height - 12 < 8 ? e.clientY + 16 : e.clientY - height - 12;
  $tooltip.style.left = `${x}px`;
  $tooltip.style.top = `${y}px`;
}
function hideTip() {
  $tooltip.hidden = true;
}

let quotaRefresh = false;
function quota() {
  poll(async () => {
    let q;
    try {
      q = await api(`/api/quota${quotaRefresh ? '?refresh=1' : ''}`);
    } catch (err) {
      return fail(err);
    }
    quotaRefresh = false;
    $view.innerHTML = `
      <div class="page-head"><h1>Quota</h1>
        <span class="sub">Fetched ${ago(q.fetchedAt)} from <code>agy /usage</code> (no quota is spent) <button class="btn" id="refresh" type="button">Refresh</button></span></div>
      <section class="card">${q.description ? `<p class="notice">${esc(q.description)}</p>` : ''}${meters(q)}</section>
      ${q.credits ? `<section class="card"><h2>AI credits</h2><p><span class="tile"><span class="value">${int(q.credits.remaining_credits)}</span></span> remaining${q.credits.upgrade_uri ? ` · <a href="${esc(q.credits.upgrade_uri)}" target="_blank" rel="noopener">Upgrade</a>` : ''}</p></section>` : ''}`;
    document.getElementById('refresh').addEventListener('click', () => {
      quotaRefresh = true;
      routeToken += 1;
      clearTimeout(timer);
      quota.call(null);
    });
  }, 60000);
}

function conversations() {
  poll(async () => {
    const data = await api('/api/conversations?limit=150');
    if (!data.available) {
      $view.innerHTML = '<div class="card notice">No Antigravity CLI conversation index found (<code>~/.gemini/antigravity-cli/conversation_summaries.db</code>). Set AGY_STATE_DIR if it lives elsewhere.</div>';
      return;
    }
    const list = data.conversations;
    $view.innerHTML = `
      <div class="page-head"><h1>Antigravity conversations</h1><span class="sub">${list.length} most recent, from the Antigravity CLI's local index</span></div>
      <section class="card"><div class="table-wrap"><table>
        <thead><tr><th>Status</th><th>Title</th><th>Workspace</th><th>Project</th><th class="num">Steps</th><th>Updated</th><th>Delegated run</th></tr></thead>
        <tbody>${list.map((c) => `<tr>
          <td>${status(c.killed ? 'cancelled' : c.active ? 'active' : 'idle')}</td>
          <td><div class="truncate" title="${esc(c.id)}">${esc(c.title || '(untitled)')}</div>${c.depth > 0 ? '<span class="chip">subagent</span>' : ''}</td>
          <td class="mono sub">${esc(c.workspaces.map(base).join(', '))}</td>
          <td class="sub">${esc(c.projectName ?? c.projectId ?? '')}</td>
          <td class="num">${int(c.steps)}</td>
          <td class="sub" title="${esc(c.lastModified)}">${ago(c.lastModified?.replace(' ', 'T'))}</td>
          <td>${c.runId ? `<a href="#/run/${esc(c.runId)}">open</a>` : ''}</td>
        </tr>`).join('')}</tbody></table></div></section>`;
  }, 10000);
}

// ---------- testcases ----------
// Testcases and their runs come from the playground, where each testcase's evaluate.py delegates and grades them.
const DIMENSIONS = { correctness: 'Correctness', clean_code: 'Clean code', performance: 'Performance', maintainability: 'Maintainability' };
const dimTitle = (d) => DIMENSIONS[d] ?? String(d).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const GATE = 'correctness';
const testcaseHref = (collection, name) => `#/testcase/${enc(collection)}/${enc(name)}`;
const testRunHref = (collection, name, number) => `#/testrun/${enc(collection)}/${enc(name)}/${number}`;
const testRunApi = (collection, name, number) => `/api/testcases/${enc(collection)}/${enc(name)}/runs/${enc(number)}`;
const testState = (r) => (r.state === 'graded' ? (r.passed ? 'pass' : 'fail') : r.state);
const testStatus = (r) => status(testState(r))
  + (r.outsideWorkspace ? ' <span class="flag" title="The agent reached outside its workspace, so treat this result as suspect">⚠</span>' : '');
// Quality dimensions present in these runs, in grader order; the correctness gate is shown separately.
function qualityDims(runs) {
  const dims = [...new Set(runs.flatMap((r) => Object.keys(r.scores ?? {})))].filter((d) => d !== GATE);
  return dims.length ? dims : ['clean_code', 'performance', 'maintainability'];
}
// A running agent's time, kept current between renders by tickElapsed().
const elapsedHtml = (r) => (r.durationSeconds == null && r.state === 'running' && r.startedAt
  ? `<span data-since="${esc(r.startedAt)}">${dur(elapsed(r))}</span>` : dur(r.durationSeconds));
function tickElapsed() {
  $view.querySelectorAll('[data-since]').forEach((el) => {
    el.textContent = dur((Date.now() - Date.parse(el.dataset.since)) / 1000);
  });
}
const scoreCell = (value, passMark) => `<td class="num${value != null && passMark != null && value < passMark ? ' bad' : ''}">${pct(value)}</td>`;

function recentTestRuns(rows) {
  if (!rows.length) return '<p class="empty">No test runs yet. Start one with <code>python3 evaluate.py run</code> in a testcase folder.</p>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Result</th><th>Test run</th><th>Model</th><th>Started</th><th class="num">Agent time</th><th class="num">Tokens</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr class="link" data-href="${testRunHref(r.collection, r.testcase, r.number)}">
        <td>${testStatus(r)}</td>
        <td><div class="truncate"><a href="${testRunHref(r.collection, r.testcase, r.number)}">${esc(r.testcaseTitle)} #${r.number}</a></div><div class="sub mono">${esc(r.testcase)}</div></td>
        <td>${r.model ? `<span class="chip">${esc(r.model)}</span>` : '–'}</td>
        <td class="sub nowrap" title="${esc(r.startedAt)}">${ago(r.startedAt)}</td>
        <td class="num">${elapsedHtml(r)}</td>
        <td class="num">${int(r.tokens)}</td>
      </tr>`).join('')}</tbody></table></div>`;
}

function collectionCard(collection, list) {
  const empty = collection.id === 'testcases'
    ? 'No finalized testcases yet. Move a sample here, with the shared _grading/ library, when it is ready.'
    : 'No testcases.';
  return `<section class="card"><div class="page-head"><h2>${esc(collection.label)}</h2><span class="sub">${esc(collection.description)}</span></div>
    ${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Testcase</th><th>Difficulty</th><th class="num">Runs</th><th class="num">Passed</th><th>Last run</th><th>Model</th><th>Started</th></tr></thead>
      <tbody>${list.map((t) => {
        const last = t.stats.last;
        return `<tr class="link" data-href="${testcaseHref(t.collection, t.name)}">
          <td><a href="${testcaseHref(t.collection, t.name)}">${esc(t.title)}</a><div class="sub desc">${t.description ? inline(t.description) : esc(t.name)}</div></td>
          <td>${t.difficulty ? `<span class="chip">${esc(t.difficulty)}</span>` : '–'}</td>
          <td class="num">${int(t.stats.total)}</td>
          <td class="num">${t.stats.graded ? `${t.stats.passed}/${t.stats.graded}` : '–'}</td>
          <td class="nowrap">${last ? `<a href="${testRunHref(t.collection, t.name, last.number)}">#${last.number}</a> ${testStatus(last)}` : '<span class="sub">No runs yet</span>'}</td>
          <td>${last?.model ? `<span class="chip">${esc(last.model)}</span>` : ''}</td>
          <td class="sub nowrap">${last ? ago(last.startedAt) : ''}</td>
        </tr>`;
      }).join('')}</tbody></table></div>` : `<p class="empty">${esc(empty)}</p>`}
  </section>`;
}

function testcases() {
  let last = '';
  poll(async () => {
    let data;
    try {
      data = await api('/api/testcases');
    } catch (err) {
      last = '';
      return fail(err);
    }
    const sig = JSON.stringify(data);
    if (sig === last) return tickElapsed();
    last = sig;
    if (!data.available) {
      $view.innerHTML = `<div class="card notice">No playground found at <code>${esc(data.root)}</code>. Set CLAUDE_AGY_PLAYGROUND to the folder that holds <code>testcases/</code> and <code>samples/</code>.</div>`;
      return;
    }
    const all = data.testcases;
    const sum = (key) => all.reduce((n, t) => n + t.stats[key], 0);
    const graded = sum('graded');
    $view.innerHTML = `
      <div class="page-head"><h1>Testcases</h1><span class="sub">Delegated runs graded by each testcase's <code>evaluate.py</code>, from <code>${esc(data.root)}</code></span></div>
      <div class="tiles">
        ${tile('Testcases', int(all.length), data.collections.map((c) => `${all.filter((t) => t.collection === c.id).length} ${c.label.toLowerCase()}`).join(' · '))}
        ${tile('Test runs', int(sum('total')), `${graded} graded`)}
        ${tile('Pass rate', graded ? `${Math.round((sum('passed') / graded) * 100)}%` : '–', `${sum('passed')} of ${graded} graded runs`)}
        ${tile('Running now', int(sum('running')))}
      </div>
      ${data.collections.map((c) => collectionCard(c, all.filter((t) => t.collection === c.id))).join('')}`;
    tickElapsed();
  }, 5000);
}

function testRunsTable(runs, collection, name, dims) {
  if (!runs.length) return '<p class="empty">No runs yet. Start one in the testcase folder with <code>python3 evaluate.py run</code>.</p>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Run</th><th>Result</th><th>Started</th><th>Model</th><th>Agent</th><th class="num">Agent time</th><th class="num">Tokens</th>
      <th class="num">Files</th><th class="num">Correctness</th>${dims.map((d) => `<th class="num">${esc(dimTitle(d))}</th>`).join('')}</tr></thead>
    <tbody>${runs.map((r) => `
      <tr class="link" data-href="${testRunHref(collection, name, r.number)}">
        <td><a href="${testRunHref(collection, name, r.number)}">#${r.number}</a></td>
        <td>${testStatus(r)}</td>
        <td class="sub nowrap" title="${esc(r.startedAt)}">${ago(r.startedAt)}</td>
        <td>${r.model ? `<span class="chip">${esc(r.model)}</span>` : '–'}</td>
        <td>${r.agentStatus ? status(r.agentStatus) : '–'}</td>
        <td class="num">${elapsedHtml(r)}</td>
        <td class="num">${int(r.tokens)}</td>
        <td class="num">${int(r.filesChanged)}</td>
        <td class="num${r.gate && r.gate.passed < r.gate.total ? ' bad' : ''}">${r.gate ? `${r.gate.passed}/${r.gate.total}` : '–'}</td>
        ${dims.map((d) => scoreCell(r.scores[d], r.passMark)).join('')}
      </tr>`).join('')}</tbody></table></div>`;
}

function modelTable(models, dims) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Model</th><th class="num">Runs</th><th class="num">Passed</th><th class="num">Avg tokens</th><th class="num">Avg agent time</th>
      ${dims.map((d) => `<th class="num">Avg ${esc(dimTitle(d).toLowerCase())}</th>`).join('')}</tr></thead>
    <tbody>${models.map((m) => `<tr><td class="name mono">${esc(m.model)}</td><td class="num">${int(m.runs)}</td><td class="num">${int(m.passed)}</td>
      <td class="num">${int(m.avgTokens)}</td><td class="num">${dur(m.avgSeconds)}</td>${dims.map((d) => `<td class="num">${pct(m.avgScores[d])}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function checkMatrix({ runs, rows }, collection, name) {
  const dims = [...new Set(rows.map((r) => r.dimension))];
  const cols = runs.length + 2;
  return `<div class="table-wrap"><table class="matrix">
    <thead><tr><th>Check</th><th class="num">Failed</th>${runs.map((n) => `<th class="num"><a href="${testRunHref(collection, name, n)}">#${n}</a></th>`).join('')}</tr></thead>
    <tbody>${dims.map((d) => `<tr class="group"><td colspan="${cols}">${esc(dimTitle(d))}${d === GATE ? ' <span class="sub">gate</span>' : ''}</td></tr>
      ${rows.filter((r) => r.dimension === d).map((r) => {
        const seen = Object.keys(r.results).length;
        return `<tr><td>${esc(r.title)}${d !== GATE && r.weight > 1 ? ` <span class="sub">×${r.weight}</span>` : ''}</td>
          <td class="num${r.failed ? ' bad' : ''}">${r.failed}/${seen}</td>
          ${runs.map((n) => {
            const cell = r.results[n];
            if (!cell) return '<td class="num sub">–</td>';
            return `<td class="num"><span class="${cell.passed ? 'cell-ok' : 'cell-no'}" title="${esc(cell.detail)}" aria-label="${cell.passed ? 'passed' : 'failed'}">${cell.passed ? '✓' : '✗'}</span></td>`;
          }).join('')}</tr>`;
      }).join('')}`).join('')}</tbody>
  </table></div>`;
}

// A collapsible card holding a markdown document.
const mdDocCard = (key, title, hint, text) => `<section class="card"><details data-key="${key}">
  <summary class="h2">${esc(title)} <span class="sub">${esc(hint)}</span></summary>
  <div class="mdv" ${mdAttrs(`${key}-md`)}><div class="md-bar">${mdToggle()}</div>${mdPanes(text)}</div></details></section>`;

function testcaseDetail(collection, name) {
  let last = '';
  poll(async () => {
    let t;
    try {
      t = await api(`/api/testcases/${enc(collection)}/${enc(name)}`);
    } catch (err) {
      last = '';
      return fail(err);
    }
    const sig = JSON.stringify(t);
    if (sig === last) return tickElapsed();
    last = sig;
    const state = saveViewState($view);
    const s = t.stats;
    const graded = t.runs.filter((r) => r.state === 'graded');
    const dims = qualityDims(graded);
    $view.innerHTML = `
      <div class="page-head">
        <div><a href="#/testcases">← Testcases</a><h1>${esc(t.title)}</h1><div class="sub">${esc(t.suiteTitle ?? t.name)}</div></div>
        <div class="checks">${t.difficulty ? `<span class="chip">${esc(t.difficulty)}</span>` : ''}<span class="chip">${esc(collection)}</span>${t.status ? `<span class="chip">${esc(t.status)}</span>` : ''}</div>
      </div>
      ${t.description ? `<p class="lede">${inline(t.description)}</p>` : ''}
      <div class="tiles">
        ${tile('Runs', int(s.total), `${s.graded} graded${s.running ? ` · ${s.running} running` : ''}`)}
        ${tile('Pass rate', s.graded ? `${Math.round((s.passed / s.graded) * 100)}%` : '–', `${s.passed} of ${s.graded} graded runs`)}
        ${tile('Avg tokens', compact(mean(graded.map((r) => r.tokens))), 'per graded run')}
        ${tile('Avg agent time', dur(mean(graded.map((r) => r.durationSeconds))), 'per graded run')}
      </div>
      <section class="card"><h2>Runs</h2>${testRunsTable(t.runs, collection, name, dims)}</section>
      ${t.byModel.length ? `<section class="card"><h2>By model</h2>${modelTable(t.byModel, dims)}</section>` : ''}
      ${t.checks.rows.length ? `<section class="card"><div class="page-head"><h2>Checks across runs</h2><span class="sub">Latest ${t.checks.runs.length} graded runs. Hover a mark for the grader's detail.</span></div>${checkMatrix(t.checks, collection, name)}</section>` : ''}
      <section class="card"><h2>Start a run</h2>
        <p class="notice">The testcase's <code>evaluate.py</code> sets up run N, delegates <code>TASK.md</code> with claude-agy, then grades and records the run. It appears here as soon as its workspace is set up.</p>
        <pre class="block">cd ${esc(t.dir)}\npython3 evaluate.py run --model MODEL --yolo --sandbox   # every flag is optional</pre>
        <p class="sub">Runs are kept in <code>${esc(t.runsDir)}</code>. The comparison report is <code>${esc(t.report)}</code>.</p>
      </section>
      ${t.task ? mdDocCard('task', 'Brief', 'TASK.md, handed to the agent verbatim', t.task) : ''}
      ${t.readme ? mdDocCard('readme', 'README', 'planted problems, grading and how to run', t.readme) : ''}`;
    restoreViewState($view, state);
    tickElapsed();
  }, 5000);
}

function scoreBar(dimension, value, passMark) {
  const p = Math.round((value ?? 0) * 100);
  return `<div class="score${value < passMark ? ' low' : ''}">
    <div class="row"><span>${esc(dimTitle(dimension))}</span><span class="pct">${pct(value)}</span></div>
    <div class="track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${esc(dimTitle(dimension))} score">
      <div class="fill" style="width:${p}%"></div><div class="pass-mark" style="left:${Math.round(passMark * 100)}%" title="Pass mark ${pct(passMark)}"></div>
    </div></div>`;
}

const diffHtml = (text) => (text.trim() ? text.split('\n').map((line) => {
  const cls = /^(\+\+\+|---) /.test(line) ? 'file' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
  return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
}).join('\n') : 'No changes.');

function pendingNotice(r) {
  const workspace = `<code>${esc(r.workspace)}</code>`;
  const grade = `grade it in <code>${esc(r.testcaseDir)}</code> with <code>python3 evaluate.py grade ${esc(r.workspace)}</code>`;
  if (r.state === 'running') return `The agent is working in ${workspace}. <code>evaluate.py run</code> grades and records the run when the agent finishes. If you delegated it step by step, ${grade} afterwards.`;
  if (r.state === 'ungraded') return `The agent finished as <strong>${esc(STATUS_TEXT[r.agentStatus] ?? r.agentStatus)}</strong>, but the run is not graded yet. If <code>evaluate.py run</code> started it, grading is under way. Otherwise ${grade}.`;
  return `The workspace ${workspace} is set up, but no claude-agy run has used it yet. Delegate the brief with <code>claude-agy run --cwd ${esc(r.workspace)} --label "${esc(r.testcase)} #${r.number}" - &lt; TASK.md</code>, then ${grade}.`;
}

function renderTestRun(r, $main) {
  const a = r.agent ?? {};
  const u = a.usage;
  const g = r.grade;
  const files = `${testRunApi(r.collection, r.testcase, r.number)}/files/`;
  const agentKv = [
    ['Status', a.status ? status(a.status) : '–'],
    ['claude-agy run', `<span class="mono">${esc(a.run_id)}</span>${r.agentRunInStore ? ` · <a href="#/run/${enc(a.run_id)}">open</a>` : ''}`],
    ['Model', `${esc(a.model ?? 'agy default')}${a.model_source ? ` <span class="sub">(from ${esc(a.model_source)})</span>` : ''}`],
    ['Options', esc([a.effort && `effort ${a.effort}`, a.yolo && '--yolo', a.sandbox && '--sandbox'].filter(Boolean).join(' · ') || 'defaults')],
    ['Started', a.started_at ? `${esc(new Date(a.started_at).toLocaleString())} (${ago(a.started_at)})` : '–'],
    ['Graded', r.gradedAt ? `${esc(new Date(r.gradedAt).toLocaleString())} (${ago(r.gradedAt)})` : 'not yet'],
    ['Agent time', `${elapsedHtml(r)}${a.num_turns != null ? ` · ${a.num_turns} turns` : ''}`],
    ['Tokens', u ? `${int(u.total_tokens)} total · ${int(u.input_tokens)} in · ${int(u.output_tokens)} out · ${int(u.thinking_tokens)} thinking · ${int(u.cache_read_tokens)} cache read` : '–'],
    ['Conversation', a.conversation_id ? `<span class="mono">${esc(a.conversation_id)}</span>` : '–'],
    ['Workspace', `<span class="mono">${esc(r.workspace)}</span>`],
  ];
  const head = `<div class="page-head">
      <div><a href="${testcaseHref(r.collection, r.testcase)}">← ${esc(r.testcaseTitle)}</a><h1>Run ${r.number} ${testStatus(r)}</h1><div class="sub">${esc(r.suiteTitle ?? r.testcase)}</div></div>
      ${r.agentRunInStore ? `<a class="btn" href="#/run/${enc(a.run_id)}">Agent run</a>` : ''}
    </div>`;
  const pending = g ? '' : `<div class="card info-box">${pendingNotice(r)}</div>
    ${r.delegateLog ? `<section class="card"><h2>claude-agy progress</h2><pre class="block">${esc(r.delegateLog)}</pre></section>` : ''}`;
  const result = g ? `<section class="card"><h2>Result</h2>
      <div class="verdict ${r.passed ? 'pass' : 'fail'}">${esc(r.verdict)}</div>
      <p class="sub">Correctness gate: ${r.gate.passed}/${r.gate.total} checks pass. Each quality dimension needs ${pct(g.pass_mark)}.</p>
      ${Object.entries(g.scores).filter(([d]) => d !== GATE).map(([d, v]) => scoreBar(d, v, g.pass_mark)).join('')}
    </section>` : '';
  const agent = `<section class="card"><h2>Agent</h2>${a.run_id
    ? `<dl class="kv">${agentKv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`
    : '<p class="empty">No claude-agy run was found for this workspace, so model, tokens and tools are unknown.</p>'}</section>`;
  const diagnosis = g ? `<section class="card"><h2>Diagnosis</h2>${r.notes.length
    ? `<ul class="notes">${r.notes.map((n) => `<li class="${esc(n.level)}">${esc(n.text)}</li>`).join('')}</ul>`
    : '<p class="notice">Every check passed.</p>'}</section>` : '';
  const checks = g ? `<section class="card"><h2>Checks</h2><div class="table-wrap"><table>
    <thead><tr><th>Result</th><th>Check</th><th class="num">Weight</th><th>Detail</th><th class="num">Time</th></tr></thead>
    <tbody>${[...new Set(g.checks.map((c) => c.dimension))].map((d) => {
      const list = g.checks.filter((c) => c.dimension === d);
      const sub = d === GATE ? `gate · ${list.filter((c) => c.passed).length}/${list.length} pass` : `${pct(g.scores[d])} · pass mark ${pct(g.pass_mark)}`;
      return `<tr class="group"><td colspan="5">${esc(dimTitle(d))} <span class="sub">${sub}</span></td></tr>
        ${list.map((c) => `<tr><td>${status(c.passed ? 'pass' : 'fail')}</td><td>${esc(c.title)}</td><td class="num">${d === GATE ? 'gate' : int(c.weight)}</td>
          <td class="detail">${esc(c.detail)}</td><td class="num">${c.seconds != null ? `${c.seconds}s` : '–'}</td></tr>`).join('')}`;
    }).join('')}</tbody></table></div></section>` : '';
  const ch = r.changes;
  const changes = ch ? `<section class="card"><div class="page-head"><h2>Changes</h2><span class="sub">against starter/</span></div>
      ${ch.files.length ? `<table><thead><tr><th>File</th><th class="num">Added</th><th class="num">Deleted</th></tr></thead>
        <tbody>${ch.files.map((f) => `<tr><td class="mono">${esc(f.path)}</td><td class="num add">+${int(f.added)}</td><td class="num del">−${int(f.deleted)}</td></tr>`).join('')}
        <tr><td class="sub">${ch.files.length} file(s)</td><td class="num add">+${int(ch.added)}</td><td class="num del">−${int(ch.deleted)}</td></tr></tbody></table>`
        : '<p class="empty">The agent changed no files.</p>'}
      ${r.files.includes('changes.diff') && ch.files.length ? '<details id="tr-diff"><summary class="sub">Show diff</summary><pre class="block diff">Loading…</pre></details>' : ''}
    </section>` : '';
  const t = r.tools;
  const toolCalls = t ? Object.entries(t.calls).sort((x, y) => y[1] - x[1]) : [];
  const tools = t ? `<section class="card"><h2>Tools</h2>
      ${toolCalls.length ? `<div class="chips">${toolCalls.map(([n, c]) => `<span class="chip mono">${esc(n)} ×${c}</span>`).join('')}</div>` : '<p class="empty">No tool calls recorded.</p>'}
      ${t.errors.length ? `<h3>Failed calls</h3><ul class="plain">${t.errors.map((e) => `<li><span class="mono">${esc(e.tool)}</span> <span class="detail">${esc(e.input)}</span></li>`).join('')}</ul>` : ''}
      ${a.denied_actions?.length ? `<h3>Denied by agy</h3><ul class="plain">${a.denied_actions.map((d) => `<li>${esc(d.display_name || d.action)}</li>`).join('')}</ul>` : ''}
      ${t.outside_workspace.length ? `<h3><span class="flag">⚠</span> Reached outside the workspace</h3><ul class="plain">${t.outside_workspace.map((o) => `<li><span class="mono">${esc(o.path)}</span> <span class="sub">(${esc(o.tool)})</span></li>`).join('')}</ul>` : ''}
    </section>` : '';
  const hasReport = Boolean(String(a.response ?? '').trim());
  const report = g || a.response ? `<section class="card mdv" ${mdAttrs('tr-report')}><div class="page-head"><h2>Agent's final report</h2>${hasReport ? mdToggle() : ''}</div>
    ${hasReport ? agentPanes(a.response) : '<p class="empty">The agent wrote no final report.</p>'}</section>` : '';
  const fileLinks = r.files.length ? `<section class="card"><h2>Files</h2>
      <p class="links">${r.files.map((f) => `<a href="${files}${esc(f)}" target="_blank" rel="noopener">${esc(f)}</a>`).join(' · ')}</p>
      <p class="sub mono">${esc(r.dir)}</p></section>` : '';
  const state = saveViewState($main);
  $main.innerHTML = `${head}${pending}<div class="cols">${result}${agent}</div>${diagnosis}${checks}
    ${changes || tools ? `<div class="cols">${changes}${tools}</div>` : ''}${report}${fileLinks}`;
  restoreViewState($main, state);
  $main.querySelector('#tr-diff')?.addEventListener('toggle', async (e) => {
    const details = e.currentTarget;
    if (!details.open || details.dataset.loaded) return;
    details.dataset.loaded = '1';
    const pre = details.querySelector('pre');
    try {
      pre.innerHTML = diffHtml(await apiText(`${files}changes.diff`));
    } catch (err) {
      pre.textContent = err.message;
      delete details.dataset.loaded;
    }
  });
}

function testRunDetail(collection, name, number) {
  const url = testRunApi(collection, name, number);
  let offset = 0;
  let count = 0;
  let last = '';
  let shellReady = false;
  poll(async () => {
    let r;
    let ev;
    try {
      [r, ev] = await Promise.all([api(url), api(`${url}/events?offset=${offset}`)]);
    } catch (err) {
      // fail() replaces the page, so the next successful poll rebuilds it from the first event.
      shellReady = false;
      offset = 0;
      count = 0;
      last = '';
      return fail(err);
    }
    if (!shellReady) {
      $view.innerHTML = `<div class="stack" id="tr-main"></div>
        <section class="card"><div class="page-head"><h2>Agent activity</h2><span class="sub" id="tr-count"></span></div><div class="timeline" id="tr-timeline"></div></section>`;
      shellReady = true;
    }
    const sig = JSON.stringify(r);
    if (sig !== last) {
      last = sig;
      renderTestRun(r, document.getElementById('tr-main'));
    }
    tickElapsed();
    const $tl = document.getElementById('tr-timeline');
    count += appendEvents($tl, ev.events);
    offset = ev.nextOffset;
    document.getElementById('tr-count').textContent = `${count} events${r.state === 'running' ? ' · live' : ''}`;
    if (!count) $tl.innerHTML = `<p class="empty">${r.state === 'prepared' ? 'No agent has worked in this run yet.' : 'No events recorded.'}</p>`;
  }, 2000);
}

// ---------- new task dialog ----------
const $dialog = document.getElementById('task-dialog');
const $form = document.getElementById('task-form');
const $err = document.getElementById('task-error');

document.getElementById('new-task').addEventListener('click', async () => {
  $err.textContent = '';
  $dialog.showModal();
  try {
    const [health, models] = await Promise.all([api('/api/health'), api('/api/models').catch(() => [])]);
    let lastCwd = null;
    try {
      lastCwd = localStorage.getItem('claude-agy:cwd');
    } catch {}
    if (!$form.cwd.value) $form.cwd.value = lastCwd || health.defaultCwd;
    document.getElementById('yolo-row').hidden = !health.allowYolo;
    if ($form.model.options.length === 1) {
      for (const m of models) $form.model.add(new Option(`${m.name} (${m.id})`, m.id));
    }
    if (!health.cliFound) $err.textContent = `claude-agy CLI not found at ${health.cli}. Set CLAUDE_AGY_CLI.`;
  } catch (err) {
    $err.textContent = err.message;
  }
});

$form.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'submit') return;
  e.preventDefault();
  const f = new FormData($form);
  const submit = document.getElementById('task-submit');
  submit.disabled = true;
  $err.textContent = '';
  try {
    const run = await post('/api/runs', {
      prompt: f.get('prompt'), cwd: f.get('cwd'), label: f.get('label') || undefined, model: f.get('model') || undefined,
      effort: f.get('effort') || undefined, plan: f.has('plan'), sandbox: f.has('sandbox'), yolo: f.has('yolo'),
    });
    try {
      localStorage.setItem('claude-agy:cwd', f.get('cwd'));
    } catch {}
    $form.prompt.value = '';
    $form.label.value = '';
    $dialog.close();
    location.hash = `#/run/${run.id}`;
  } catch (err) {
    $err.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

route();
