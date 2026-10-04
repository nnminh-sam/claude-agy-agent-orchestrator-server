#!/usr/bin/env node
// Answers the read-only agy commands the server uses.
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const [a, b] = process.argv.slice(2);
if (a === '-p' && b === '/usage') {
  out({ status: 'SUCCESS', command: { name: 'usage', data: { description: 'd', groups: [{ name: 'Gemini Models', buckets: [{ id: 'g5', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.08, reset_time: '2099-01-01T00:00:00Z' }] }] } } });
} else if (a === '-p' && b === '/credits') {
  out({ status: 'SUCCESS', command: { name: 'credits', data: { remaining_credits: 3 } } });
} else if (a === 'models') {
  process.stdout.write('Fetching available models...\ngemini-fast\tGemini Fast\n');
} else if (a === 'agents') {
  process.stdout.write('');
} else {
  process.exit(2);
}
