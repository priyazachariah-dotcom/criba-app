#!/usr/bin/env node
// Runs the kinds eval over a fixed list of message IDs. Two arms per message:
// the production prompt as it stands, and the same prompt with the kinds
// variant applied. Writes a results file and prints the table.
//
// It cannot touch the calendar. It imports no part of server.js that writes,
// never constructs a Calendar client, and never loads the events store. The
// only Google scope it uses is gmail.readonly, and the only mail it fetches is
// the IDs listed in EXPECTATIONS.
//
// The API key is read from the environment and is never printed, never written
// to the results file, and never sent anywhere except api.anthropic.com.
//
//   ANTHROPIC_API_KEY=... node api/run-kinds-eval.mjs --email you@example.com
//
// Flags:
//   --email      which account's mail to read (required)
//   --model      default claude-sonnet-5
//   --cap        hard spend ceiling in USD, default 2. The run aborts rather
//                than crossing it.
//   --out        results file, default ./kinds-eval-<timestamp>.json
//   --dry        print the plan and the cost estimate, call nothing

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import Redis from 'ioredis';
import { loadExtractionPrompt, applyPromptVariant, extractPlainText, buildTail } from './shadow-replay.js';
import { EXPECTATIONS, scoreOne, scoreAll, estimateCostUsd } from './kinds-eval.js';

const PRICING = {
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5':   { in: 5, out: 25 },
  'claude-fable-5':  { in: 10, out: 50 },
  'claude-haiku-4-5':{ in: 1, out: 5 },
};

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const EMAIL = (arg('email') || '').toLowerCase();
const MODEL = arg('model', 'claude-sonnet-5');
const CAP_USD = Number(arg('cap', '2'));
const OUT = arg('out', `./kinds-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

if (!EMAIL) { console.error('--email is required'); process.exit(1); }
if (!PRICING[MODEL]) { console.error(`unpriced model "${MODEL}"`); process.exit(1); }

const planned = EXPECTATIONS.filter(e => e.messageId);
const missing = EXPECTATIONS.filter(e => !e.messageId).map(e => e.label);
if (missing.length) {
  console.error(`\nThese expectations have no messageId yet:\n  ${missing.join('\n  ')}\n`);
  console.error('Fill them in api/kinds-eval.js, or they are skipped.\n');
}
if (!planned.length) { console.error('Nothing to run.'); process.exit(1); }

const estimate = estimateCostUsd({ emails: planned.length, arms: 2, model: MODEL });
console.log(`\n${planned.length} emails x 2 arms = ${estimate.calls} calls on ${MODEL}`);
console.log(`estimated cost: $${estimate.usd}   hard cap: $${CAP_USD}\n`);
if (has('dry')) { console.log('--dry: nothing was called.'); process.exit(0); }
if (estimate.usd > CAP_USD) {
  console.error(`Estimate exceeds the cap. Raise --cap deliberately or shorten the list.`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set.'); process.exit(1); }

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const refreshToken = await redis.get(`refreshToken:${EMAIL}`);
if (!refreshToken) { console.error(`No refresh token stored for ${EMAIL}.`); process.exit(1); }
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
auth.setCredentials({ refresh_token: refreshToken });
const gmail = google.gmail({ version: 'v1', auth });

const serverSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'server.js'), 'utf8');
const basePrompt = loadExtractionPrompt(serverSrc);
const kindsPrompt = applyPromptVariant(basePrompt, 'kinds');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let spentUsd = 0;
async function callArm(prompt, tail) {
  if (spentUsd >= CAP_USD) throw new Error(`spend cap $${CAP_USD} reached — stopping`);
  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 8192,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: tail },
    ] }],
  });
  const p = PRICING[MODEL];
  spentUsd += ((res.usage?.input_tokens || 0) * p.in + (res.usage?.output_tokens || 0) * p.out) / 1e6;
  const text = (res.content || []).map(c => c.text || '').join('').trim();
  const m = text.match(/\[[\s\S]*\]/);
  try { return m ? JSON.parse(m[0]) : []; } catch { return []; }
}

const rows = [];
for (const spec of planned) {
  process.stdout.write(`  ${spec.label} … `);
  const msg = await gmail.users.messages.get({ userId: 'me', id: spec.messageId, format: 'full' });
  const headers = msg.data.payload?.headers || [];
  const h = n => (headers.find(x => x.name.toLowerCase() === n) || {}).value || '';
  const tail = buildTail(h('subject'), extractPlainText(msg.data.payload), h('date'),
    (arg('roster', 'Arin,Aarav') || '').split(',').map(s => s.trim()).filter(Boolean));
  const baseline = await callArm(basePrompt, tail);
  const candidate = await callArm(kindsPrompt, tail);
  const scored = scoreOne(spec.label, baseline, candidate, spec.expect || {});
  scored.note = spec.note || '';
  scored.baseline = baseline;
  scored.candidate = candidate;
  rows.push(scored);
  console.log(scored.passed ? 'pass' : 'FAIL');
}

const summary = scoreAll(rows);
summary.model = MODEL;
summary.spentUsd = +spentUsd.toFixed(4);
summary.ranAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(summary, null, 2));

console.log(`\n${'label'.padEnd(24)} ${'items'.padEnd(12)} ${'all-day'.padEnd(10)} kinds`);
for (const r of rows) {
  console.log(`${r.label.padEnd(24)} ${`${r.baselineItems} -> ${r.candidateItems}`.padEnd(12)}`
    + ` ${`${r.baselineAllDay} -> ${r.candidateAllDay}`.padEnd(10)} ${r.kinds.join(',')}`
    + (r.passed ? '' : `   FAILED: ${r.checks.filter(c => !c.pass).map(c => c.name).join(', ')}`));
}
console.log(`\npassed ${summary.passed}/${summary.emails}`
  + `   items/email ${summary.baselineItemsPerEmail} -> ${summary.candidateItemsPerEmail}`
  + `   all-day ${summary.baselineAllDay} -> ${summary.candidateAllDay}`
  + `   items lost ${summary.itemsLost}`);
console.log(`spent $${summary.spentUsd}`);
console.log(`\nresults: ${OUT}\n`);
await redis.quit();
