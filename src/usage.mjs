// Token accounting over delegated runs (from each run's `result` usage object).
const KEYS = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'];
const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0]));

function add(into, usage) {
  for (const k of KEYS) into[k] += Number(usage[k] ?? 0);
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function summarizeUsage(runs, { days = 14, now = new Date() } = {}) {
  const totals = zero();
  const byModel = {};
  const bySource = {};
  const daily = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    daily.set(localDay(d), { day: localDay(d), runs: 0, ...zero() });
  }
  let counted = 0;
  for (const run of runs) {
    if (!run.usage) continue;
    counted += 1;
    add(totals, run.usage);
    add((byModel[run.model ?? 'default'] ??= { runs: 0, ...zero() }), run.usage);
    byModel[run.model ?? 'default'].runs += 1;
    add((bySource[run.source ?? 'unknown'] ??= { runs: 0, ...zero() }), run.usage);
    bySource[run.source ?? 'unknown'].runs += 1;
    const bucket = daily.get(localDay(new Date(run.createdAt)));
    if (bucket) {
      bucket.runs += 1;
      add(bucket, run.usage);
    }
  }
  return { runsWithUsage: counted, totals, byModel, bySource, daily: [...daily.values()] };
}
