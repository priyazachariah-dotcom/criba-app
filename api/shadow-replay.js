// Track 1 — offline Sonnet replay harness.
//
// STRUCTURAL GUARANTEE
// --------------------
// This file has no path to the calendar. It never imports server.js, never
// constructs a Google Calendar client, and never names the calendar-write
// chokepoint or the live extraction function. Sonnet's output cannot reach the
// calendar or the review queue because nothing here is capable of writing to
// either — not because a flag says so.
//
// The identifiers are deliberately NOT written out anywhere in this file, so
// that grepping for them is a real proof rather than a comment match. The
// verification command lives in the commit message, not here.
//
// The only Google scope used is gmail.readonly, via the refresh token the user
// already granted. No new consent, and nothing fetched here is stored: message
// bodies live in memory for the duration of one comparison and are dropped.
//
// WHY IT READS THE PROMPT OUT OF server.js AS TEXT
// A copied prompt would drift, and a harness testing a stale prompt silently
// measures the wrong thing. Importing server.js would boot an Express app. So
// the exact production literal is sliced out of the source at runtime, and the
// slice is asserted to look right rather than trusted.

import Redis from 'ioredis';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const redis = new Redis(process.env.REDIS_URL);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SHADOW_MODEL = 'claude-sonnet-5';
// Candidates the harness may replay. Kept as an allow-list so a typo becomes an
// error rather than a silent fallback to Fable pricing on a real run.
const SHADOW_PRICING = {
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.1 },
  'claude-opus-5':   { in: 5, out: 25, cacheRead: 0.1 },
};
const SHADOW_MAX_TOKENS = 8192;   // matched to the live path, so truncation is comparable

// The harness bills to its own key, never to a user's. callClaude checks a
// per-user daily cap before every call; if the replay spent against a real
// user's budget it could trip that cap and abort their live extraction — a
// missed email caused by the measurement. Separate key, separate cap.
const SHADOW_SPEND_KEY_PREFIX = 'shadowSpendMicroUsd';
const SHADOW_DAILY_CAP_USD = Number(process.env.SHADOW_DAILY_CAP_USD || 15);


function shadowSpendKey() {
  return `${SHADOW_SPEND_KEY_PREFIX}:${new Date().toISOString().slice(0, 10)}`;
}

function shadowCostMicroUsd(model, usage) {
  const p = SHADOW_PRICING[model];
  if (!p) throw new Error(`unpriced shadow model "${model}" — add it to SHADOW_PRICING`);
  const inTok = Number(usage?.input_tokens || 0);
  const outTok = Number(usage?.output_tokens || 0);
  const cacheRead = Number(usage?.cache_read_input_tokens || 0);
  const w5 = Number(usage?.cache_creation_input_tokens || 0);
  return Math.ceil((inTok + w5 * 1.25 + cacheRead * p.cacheRead) * p.in + outTok * p.out);
}

// ── The production prompt, loaded as text ────────────────────────────────
const PROMPT_DECL = 'const FULL_EXTRACTION_PROMPT = `';

export function loadExtractionPrompt(serverSource) {
  const start = serverSource.indexOf(PROMPT_DECL);
  if (start < 0) throw new Error('FULL_EXTRACTION_PROMPT declaration not found in server.js');
  const from = start + PROMPT_DECL.length;
  // The literal closes on the same line as its last sentence, not on a line of
  // its own -- an earlier version looked for a newline before the backtick and
  // found nothing. The prompt contains no backticks and no interpolation, so
  // the very next backtick is unambiguously the terminator.
  const end = serverSource.indexOf('`', from);
  if (end < 0) throw new Error('FULL_EXTRACTION_PROMPT closing backtick not found');
  const prompt = serverSource.slice(from, end);
  // Fail loudly rather than replay against a mangled slice. These two sentences
  // top and tail the real prompt; if either is gone the slice is wrong.
  if (!prompt.includes('calendar extraction expert')) throw new Error('prompt slice missing its opening line');
  if (!prompt.includes('Return a JSON array only')) throw new Error('prompt slice missing its closing line');
  if (prompt.includes('${')) throw new Error('prompt slice contains interpolation — cannot be used verbatim');
  return prompt;
}

// ── Prompt variants ──────────────────────────────────────────────────────
// Named, in-repo transforms of the PRODUCTION prompt -- never free text from
// the request. A caller can pick a variant but cannot inject one, so every
// result stays reproducible and auditable, and the base is always what the
// live path actually uses.
//
// rule8-strict tests one hypothesis: that the recall gap is instruction
// following rather than capability. Sonnet 5 and Opus 5 landed within a point
// of each other (58.1% / 59.1%), which is not the shape of a capability
// ceiling, and what both drop is a consistent category -- early release days,
// testing days, form deadlines, single-use tickets. Rule 8 currently states a
// principle and gives three examples; a summarising model can satisfy it while
// still exercising judgement about what is "worth" including. This variant
// removes the judgement: it names the dropped categories and reframes the rule
// as an enumeration requirement rather than an exhortation.
const RULE8_ORIGINAL = '8. Never miss an event because it seems minor. "Return library books" is on the calendar. "Submit grad photo" is on the calendar. "Verify card is current" is on the calendar. Busy people miss these exactly because they seem small.';

const RULE8_STRICT = `8. ENUMERATE EVERY DATED ITEM. This is not a judgement call and there is no
threshold of importance. If a line in the source names a date or a deadline,
it becomes an event, full stop. Do not decide something is too small, too
routine, too administrative or too obvious to include.

The following are all REQUIRED, and are the ones most often wrongly dropped:
- Schedule variations: early release days, minimum days, late starts, no-school
  days, half days, "regular early release day", schedule change days
- School operations: testing days, picture day, picture make-up day,
  class lists released, report cards issued, registration opening or closing
- Form and money deadlines: schedule change forms due, permission slips,
  waivers, signed acknowledgements, fee and invoice due dates, RSVP cutoffs
- Optional and opt-in items: optional exams (SAT, ACT), optional camps and
  clinics, sign-up windows, ticket sales, single-use bus tickets, spirit wear
  or merchandise order deadlines
- Administrative notices with a date attached, even when no action is required

A newsletter listing fifteen dated items must yield fifteen events. Returning
the five most interesting ones is a failure, not a summary. Before you finish,
re-read the source and confirm every date you can see appears in your output.`;

export function applyPromptVariant(prompt, variant) {
  if (!variant || variant === 'production') return prompt;
  if (variant === 'rule8-strict') {
    if (!prompt.includes(RULE8_ORIGINAL)) {
      // Fail rather than silently replay the unmodified prompt and report the
      // result as if the variant had been applied.
      throw new Error('rule8-strict: Rule 8 not found verbatim in the production prompt — it has changed and the variant needs updating');
    }
    return prompt.replace(RULE8_ORIGINAL, RULE8_STRICT);
  }
  throw new Error(`unknown prompt variant "${variant}"`);
}

function serverSourcePath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'server.js');
}

// ── Gmail (read-only) ────────────────────────────────────────────────────
async function gmailFor(email) {
  const refreshToken = await redis.get(`refreshToken:${email}`);
  if (!refreshToken) throw new Error(`no refresh token stored for ${email}`);
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth });
}

function decodeBody(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Prefers text/plain, falls back to stripped text/html. Mirrors what the live
// path feeds the model closely enough for a like-for-like comparison.
export function extractPlainText(payload) {
  if (!payload) return '';
  const parts = [];
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data) parts.push({ type: 'plain', text: decodeBody(p.body.data) });
    else if (p.mimeType === 'text/html' && p.body?.data) parts.push({ type: 'html', text: decodeBody(p.body.data) });
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const plain = parts.filter(p => p.type === 'plain').map(p => p.text).join('\n');
  if (plain.trim()) return plain;
  const html = parts.filter(p => p.type === 'html').map(p => p.text).join('\n');
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerOf(msg, name) {
  const h = (msg?.payload?.headers || []).find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

// The sender search is the source of truth for which messages existed. A
// store-derived corpus is blind to exactly the failure this test hunts: an
// email Fable read and extracted nothing from leaves no event row behind.
export function buildSenderQuery(senders, days) {
  const list = senders.map(s => `from:${s}`).join(' OR ');
  return `(${list}) newer_than:${days}d`;
}

async function searchCorpus(gmail, senders, days, limit) {
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me', q: buildSenderQuery(senders, days), maxResults: 100, pageToken,
    });
    for (const m of res.data.messages || []) {
      ids.push(m.id);
      if (ids.length >= limit) return ids;
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return ids;
}

// ── Comparison ───────────────────────────────────────────────────────────
export function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function eventKey(ev) {
  return `${ev.date || ''}|${normTitle(ev.title)}`;
}

// Agreement, not truth. Fable's set is the incumbent baseline, not ground
// truth, so these are reported as agreement rates and every disagreement is
// handed to a human rather than scored as an error.
// Two models describing the same event rarely phrase it identically. The first
// run scored "BSC U9B Pre-NPL Scrimmage" against "U9B Pre-NPL Scrimmage vs
// Alameda" as BOTH a miss and a false positive, and reported 21.9% recall for
// what was in fact agreement. Exact title equality is not a usable matcher.
//
// So: the date must match exactly -- that is the fact a calendar turns on and
// a model that moves a date is wrong -- and titles are matched by token
// overlap above a threshold. Fuzzy matches are counted SEPARATELY and listed,
// never folded silently into the headline, because "probably the same event"
// is a judgement a human should confirm.
const TITLE_MATCH_THRESHOLD = 0.5;

export function titleSimilarity(a, b) {
  const A = new Set(normTitle(a).split(' ').filter(Boolean));
  const B = new Set(normTitle(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function compareSets(sonnetEvents, fableEvents) {
  const unusedSonnet = sonnetEvents.map((e, i) => ({ e, i })).filter(x => x.e);
  const taken = new Set();
  const matchedExact = [];
  const matchedFuzzy = [];
  const missingFromSonnet = [];

  for (const fe of fableEvents) {
    let best = null;
    for (const cand of unusedSonnet) {
      if (taken.has(cand.i)) continue;
      if (String(cand.e.date || '') !== String(fe.date || '')) continue;  // date is non-negotiable
      const sim = titleSimilarity(cand.e.title, fe.title);
      if (!best || sim > best.sim) best = { ...cand, sim };
    }
    if (best && best.sim >= TITLE_MATCH_THRESHOLD) {
      taken.add(best.i);
      const se = best.e;
      const timeAgrees = String(se.start_time || se.time || '') === String(fe.time || '');
      const rec = {
        date: fe.date, fableTitle: fe.title, sonnetTitle: se.title,
        similarity: Number(best.sim.toFixed(2)), timeAgrees,
        sonnetTime: se.start_time || se.time || '', fableTime: fe.time || '',
      };
      if (best.sim === 1) matchedExact.push(rec); else matchedFuzzy.push(rec);
    } else {
      missingFromSonnet.push({ key: eventKey(fe), title: fe.title, date: fe.date, time: fe.time || '' });
    }
  }
  const extraInSonnet = unusedSonnet.filter(x => !taken.has(x.i))
    .map(x => ({ key: eventKey(x.e), title: x.e.title, date: x.e.date, time: x.e.start_time || x.e.time || '' }));

  const matched = [...matchedExact, ...matchedFuzzy];
  return {
    matched, matchedExact, matchedFuzzy, missingFromSonnet, extraInSonnet,
    fableCount: fableEvents.length, sonnetCount: sonnetEvents.length,
    timeMismatches: matched.filter(m => !m.timeAgrees).length,
    exactAgreement: missingFromSonnet.length === 0 && extraInSonnet.length === 0,
  };
}

export function rate(numerator, denominator) {
  return denominator ? Number((100 * numerator / denominator).toFixed(1)) : null;
}

// Recall and precision stay separate on purpose. A missed event breaks the
// cardinal rule; a spurious one costs one click. Averaging them into a single
// score would let a recall regression hide behind a precision gain.
export function scoreStratum(pairs) {
  let matched = 0, fable = 0, sonnet = 0, timeMismatch = 0, truncated = 0, exact = 0;
  let exactOnly = 0, fuzzy = 0;
  for (const p of pairs) {
    matched += p.cmp.matched.length;
    exactOnly += (p.cmp.matchedExact || []).length;
    fuzzy += (p.cmp.matchedFuzzy || []).length;
    fable += p.cmp.fableCount;
    sonnet += p.cmp.sonnetCount;
    timeMismatch += p.cmp.timeMismatches;
    if (p.stopReason === 'max_tokens') truncated++;
    if (p.cmp.exactAgreement) exact++;
  }
  return {
    messages: pairs.length,
    fableEvents: fable, sonnetEvents: sonnet, matchedEvents: matched,
    // Upper bound counts fuzzy title matches as agreement; the lower bound
    // counts only identical titles. The truth is between them, and the fuzzy
    // matches are listed so a human can close the gap rather than guess.
    recallVsFable: rate(matched, fable),
    precisionVsFable: rate(matched, sonnet),
    recallExactTitlesOnly: rate(exactOnly, fable),
    precisionExactTitlesOnly: rate(exactOnly, sonnet),
    fuzzyTitleMatches: fuzzy,
    timeMismatches: timeMismatch,
    truncationStops: truncated,
    exactAgreementMessages: exact,
  };
}

// ── Sonnet ───────────────────────────────────────────────────────────────
function parseEvents(text) {
  const cleaned = String(text || '').replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
  const raw = JSON.parse(cleaned);
  return Array.isArray(raw) ? raw : [];
}

// Replicated VERBATIM from the live path (server.js, extractGmail... tail
// construction). Not an approximation: the first scored run omitted the sent
// date in ISO form, the "resolve relative dates against the sent date" rule and
// the family roster, then scored Sonnet against Fable's output under the full
// prompt. On a corpus reaching 60 days back that difference alone misdates
// events, and the resulting gap would have read as a Sonnet failure.
//
// If the live construction changes, this must change with it. The parity test
// asserts the exact sentences rather than trusting the shape.
const EXTRACTION_CHAR_LIMIT = 60000;

export function buildTail(subject, body, dateSent, familyNames = [], today = null) {
  const textContent = [subject ? `Subject: ${subject}\n\n` : '', body].join('').slice(0, EXTRACTION_CHAR_LIMIT);
  const sentIso = dateSent ? new Date(dateSent) : null;
  const sentLine = sentIso && !isNaN(sentIso)
    ? `This email was sent on ${sentIso.toISOString().split('T')[0]} (${sentIso.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}).`
    : '';
  const dateContext = [
    `Today's date is ${today || new Date().toISOString().split('T')[0]}.`,
    sentLine,
    'Resolve every relative date ("Monday", "this Friday", "next week", "the 12th") against the email\'s sent date. Always output a full YYYY-MM-DD with an explicit year — never omit the year or guess one.',
  ].filter(Boolean).join(' ');
  const rosterContext = familyNames.length
    ? `This person's family members are: ${familyNames.join(', ')}. For each event, put into "attendees" the names of the family members it concerns — the child whose team, class or activity it is. Infer from the team name, teacher, grade or context even when the name is not written out. Use the exact spelling listed above. Leave the array empty if the event concerns the whole family or you genuinely cannot tell.`
    : '';
  const context = [dateContext, rosterContext].filter(Boolean).join('\n\n');
  return `${context}\n\nEmail:\n${textContent}`;
}

async function sonnetExtract(prompt, subject, body, dateSent, familyNames, maxTokens, model) {
  const tail = buildTail(subject, body, dateSent, familyNames);
  const res = await anthropic.messages.create({
    model: model || SHADOW_MODEL,
    max_tokens: maxTokens || SHADOW_MAX_TOKENS,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: tail },
    ] }],
  });
  const micro = shadowCostMicroUsd(model || SHADOW_MODEL, res.usage);
  const key = shadowSpendKey();
  await redis.incrby(key, micro);
  await redis.expire(key, 7 * 24 * 60 * 60);
  const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let events = [], parseError = null;
  try { events = parseEvents(text); } catch (e) { parseError = e.message; }
  return { events, parseError, stopReason: res.stop_reason, usage: res.usage, micro };
}

// ── Sender discovery ─────────────────────────────────────────────────────
// The corpus needs a sender list. Rather than guess at one, rank the senders
// Criba has actually seen by how often a single message from them produced
// MORE THAN ONE event -- that is the definition of the multi-event newsletter
// stratum, so it selects the hard cases directly instead of by reputation.
//
// This reads stored events only. It is a way of proposing a list for a human
// to approve, not the corpus itself: the corpus is always the Gmail sender
// search, because a message Fable extracted nothing from leaves no row here.
export async function discoverSenders(email, { top = 15 } = {}) {
  const all = await redis.hgetall(`events:${email}`);
  const byMessage = new Map();
  for (const raw of Object.values(all || {})) {
    let ev; try { ev = JSON.parse(raw); } catch { continue; }
    const mid = ev?.gmail_message_id;
    const sender = String(ev?.sender_email || '').toLowerCase();
    if (!mid || !sender) continue;
    if (!byMessage.has(mid)) byMessage.set(mid, { sender, events: 0 });
    byMessage.get(mid).events++;
  }
  const bySender = new Map();
  for (const { sender, events } of byMessage.values()) {
    if (!bySender.has(sender)) bySender.set(sender, { sender, messages: 0, events: 0, multiEventMessages: 0 });
    const r = bySender.get(sender);
    r.messages++; r.events += events;
    if (events > 1) r.multiEventMessages++;
  }
  return [...bySender.values()]
    .map(r => ({ ...r, eventsPerMessage: Number((r.events / r.messages).toFixed(2)) }))
    .sort((x, y) => y.multiEventMessages - x.multiEventMessages || y.eventsPerMessage - x.eventsPerMessage)
    .slice(0, top);
}

export async function buildReport(runId, senders, email) {
  const raw = (await redis.hgetall(runResultsKey(runId))) || {};
  const pairs = Object.values(raw).map(v => JSON.parse(v));
  if (!pairs.length) throw new Error(`no results stored for run ${runId}`);

  // Sonnet's raw events are stored per message, so the comparison can be
  // rebuilt without paying for the run again. That is the whole reason the
  // pairs are persisted rather than scored in flight: the first matcher was
  // wrong, and fixing it had to cost nothing.
  if (email) {
    const all = await redis.hgetall(`events:${email}`);
    const byMessage = new Map();
    for (const rowRaw of Object.values(all || {})) {
      let ev; try { ev = JSON.parse(rowRaw); } catch { continue; }
      if (!ev?.gmail_message_id || ev.redactedAt) continue;
      if (!byMessage.has(ev.gmail_message_id)) byMessage.set(ev.gmail_message_id, []);
      byMessage.get(ev.gmail_message_id).push(ev);
    }
    for (const p of pairs) {
      if (!Array.isArray(p.sonnetEventsHere)) continue;
      const fable = byMessage.get(p.id) || [];
      if (!fable.length) continue;              // leave fableFoundNothing rows alone
      p.cmp = compareSets(p.sonnetEventsHere, fable);
    }
  }
  return scorePairs(pairs, senders, { runId, rescored: !!email });
}

// ── Run state ────────────────────────────────────────────────────────────
// A 50-message run exceeds the serverless request timeout, so a run is a
// sequence of batches sharing a runId. The corpus is frozen on the first batch
// -- re-deriving it per batch would let a newly arrived email shift every
// subsequent offset and silently skip messages.
const RUN_TTL_SECONDS = 3 * 24 * 60 * 60;

function runCorpusKey(runId) { return `shadowRun:${runId}:ids`; }
function runResultsKey(runId) { return `shadowRun:${runId}:pairs`; }

export async function shadowSpendTodayUsd() {
  return (Number(await redis.get(shadowSpendKey())) || 0) / 1e6;
}

export async function shadowRunStatus(runId) {
  const idsRaw = await redis.get(runCorpusKey(runId));
  const ids = idsRaw ? JSON.parse(idsRaw) : [];
  const done = await redis.hlen(runResultsKey(runId));
  return { runId, corpusSize: ids.length, processed: done, remaining: Math.max(0, ids.length - done),
    spentTodayUsd: Number((await shadowSpendTodayUsd()).toFixed(4)) };
}

// ── Orchestration ────────────────────────────────────────────────────────
export async function runReplay({
  email, senders, days = 45, limit = 40, dryRun = false,
  runId = null, batchSize = 10,
  // Raising the ceiling is a HARNESS-ONLY knob. The live path's 8192 is
  // untouched; this exists to find out whether truncation is a budget problem
  // or a model problem before anyone proposes changing production.
  maxTokens = null,
  model = SHADOW_MODEL,
  variant = 'production',
  // Restrict the corpus to specific messages, so a hypothesis about two
  // failures costs two calls rather than fifty.
  onlyIds = null,
} = {}) {
  if (!email) throw new Error('email is required');
  if (!Array.isArray(senders) || !senders.length) throw new Error('at least one sender is required');

  if (!SHADOW_PRICING[model]) throw new Error(`unknown shadow model "${model}"`);

  const spentMicro = Number(await redis.get(shadowSpendKey())) || 0;
  if (spentMicro / 1e6 >= SHADOW_DAILY_CAP_USD) {
    throw new Error(`shadow replay budget exhausted: $${(spentMicro / 1e6).toFixed(2)} of $${SHADOW_DAILY_CAP_USD}`);
  }

  const prompt = applyPromptVariant(
    loadExtractionPrompt(readFileSync(serverSourcePath(), 'utf8')), variant);
  // The roster drives the "attendees" field. Fable gets it on every call; a
  // replay without it is not the same prompt.
  const familyRaw = (await redis.hgetall(`family:${email}`)) || {};
  const familyNames = Object.values(familyRaw)
    .map(v => { try { return JSON.parse(v)?.name; } catch { return null; } })
    .filter(Boolean);
  const gmail = await gmailFor(email);

  // Freeze the corpus on the first batch of a run and reuse it thereafter, so
  // mail arriving mid-run cannot shift the offsets under us.
  let ids;
  if (runId && !dryRun) {
    const cached = await redis.get(runCorpusKey(runId));
    if (cached) {
      ids = JSON.parse(cached);
    } else {
      ids = await searchCorpus(gmail, senders, days, limit);
      await redis.set(runCorpusKey(runId), JSON.stringify(ids), 'EX', RUN_TTL_SECONDS);
    }
  } else {
    ids = await searchCorpus(gmail, senders, days, limit);
  }

  // Fable's result is already known — it is whatever is on the calendar today.
  // Re-running it would cost money and prove nothing.
  const storedByMessageId = new Map();
  const all = await redis.hgetall(`events:${email}`);
  for (const raw of Object.values(all || {})) {
    let ev; try { ev = JSON.parse(raw); } catch { continue; }
    const mid = ev?.gmail_message_id;
    if (!mid) continue;
    if (!storedByMessageId.has(mid)) storedByMessageId.set(mid, []);
    storedByMessageId.get(mid).push(ev);
  }

  const pairs = [];
  const skipped = [];

  if (Array.isArray(onlyIds) && onlyIds.length) {
    const keep = new Set(onlyIds);
    ids = ids.filter(id => keep.has(id));
    // A typo in an id would silently produce an empty, passing run.
    if (!ids.length) throw new Error('onlyIds matched no message in the corpus');
  }

  // Resume where the previous batch stopped, by message id rather than by
  // index: a batch that half-failed leaves the ids it did finish recorded, and
  // those must not be paid for twice.
  let todo = ids;
  if (runId && !dryRun) {
    const doneIds = new Set(Object.keys((await redis.hgetall(runResultsKey(runId))) || {}));
    todo = ids.filter(id => !doneIds.has(id)).slice(0, batchSize);
  }

  for (const id of todo) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const subject = headerOf(msg.data, 'Subject');
    const from = headerOf(msg.data, 'From');
    const dateSent = headerOf(msg.data, 'Date');
    const body = extractPlainText(msg.data.payload);
    const storedRows = storedByMessageId.get(id) || [];
    // Retention strips content once an event is over but KEEPS the row, its
    // date and its gmail_message_id. Such a row has no title and no time, so
    // scoring against it would manufacture a disagreement out of a privacy
    // feature. Excluded from scoring and counted instead.
    const redactedRows = storedRows.filter(e => e.redactedAt);
    const fableEvents = storedRows.filter(e => !e.redactedAt);

    if (dryRun) {
      pairs.push({ id, subject, from, bodyChars: body.length,
        fableCount: fableEvents.length, redactedCount: redactedRows.length, dryRun: true });
      continue;
    }
    if (!body.trim()) { skipped.push({ id, reason: 'empty body' }); continue; }

    let out;
    try { out = await sonnetExtract(prompt, subject, body, dateSent, familyNames, maxTokens, model); }
    catch (e) { skipped.push({ id, reason: `sonnet call failed: ${e.message}` }); continue; }

    pairs.push({
      id, subject, from,
      stopReason: out.stopReason,
      parseError: out.parseError,
      cmp: compareSets(out.events, fableEvents),
      costMicro: out.micro,
      maxTokensUsed: maxTokens || SHADOW_MAX_TOKENS,
      modelUsed: model,
      variantUsed: variant,
      // Two conditions that must never be scored as if they were agreement or
      // error. A redacted baseline is unknowable; a baseline of zero is not
      // evidence Sonnet is wrong, only that Fable found nothing to compare to.
      baselineRedacted: redactedRows.length > 0 && fableEvents.length === 0,
      fableFoundNothing: redactedRows.length === 0 && fableEvents.length === 0,
      sonnetEventsHere: out.events.map(e => ({ title: e.title, date: e.date, time: e.start_time || e.time || '' })),
    });
    if (runId) {
      await redis.hset(runResultsKey(runId), id, JSON.stringify(pairs[pairs.length - 1]));
      await redis.expire(runResultsKey(runId), RUN_TTL_SECONDS);
    }
  }

  // A batched run reports progress only. Scoring happens once, over the whole
  // corpus, in buildReport -- scoring per batch would invite quoting a partial
  // stratum as if it were the result.
  if (runId && !dryRun) {
    const status = await shadowRunStatus(runId);
    return { ...status, batchProcessed: pairs.length, skipped,
      done: status.remaining === 0,
      note: status.remaining === 0
        ? 'Corpus complete. Call with { report: true, runId } for the scored result.'
        : `Call again with the same runId for the next ${batchSize}.` };
  }

  if (dryRun) {
    return {
      dryRun: true, model: SHADOW_MODEL, corpusSize: ids.length,
      query: buildSenderQuery(senders, days),
      messages: pairs,
      withFableEvents: pairs.filter(p => p.fableCount > 0).length,
      withoutFableEvents: pairs.filter(p => !p.fableCount).length,
    };
  }

  return scorePairs(pairs, senders, { query: buildSenderQuery(senders, days), corpusSize: ids.length, skipped });
}

// Scoring lives in one place so a batched run and a single-shot run cannot
// diverge. Takes finished pairs, returns the report.
export function scorePairs(pairs, senders, extra = {}) {
  const senderSet = new Set(senders.map(s => s.toLowerCase()));
  const inStratum = p => senderSet.has(String(p.from || '').toLowerCase().replace(/^.*<|>.*$/g, ''))
    || senders.some(s => String(p.from || '').toLowerCase().includes(s.toLowerCase()));

  // Only messages with a usable Fable baseline can be scored. The other two
  // groups are reported in full for adjudication rather than folded into a
  // number they would distort in opposite directions.
  const scorable = pairs.filter(p => p.cmp && !p.baselineRedacted && !p.fableFoundNothing);
  const newsletter = scorable.filter(inStratum);
  const other = scorable.filter(p => !inStratum(p));

  // Fable extracting nothing is the single most interesting case for recall:
  // either Sonnet caught something Fable missed, or Sonnet invented it. Neither
  // can be settled by arithmetic, so every one goes to a human.
  const fableFoundNothing = pairs.filter(p => p.fableFoundNothing).map(p => ({
    id: p.id, subject: p.subject, from: p.from, stopReason: p.stopReason,
    sonnetFound: p.sonnetEventsHere,
  }));
  const redactedBaseline = pairs.filter(p => p.baselineRedacted).length;

  // Only disagreements go to a human. Agreement is evidence, not proof — so a
  // sample of the agreements is surfaced too, to catch a matching count that
  // hides a swapped event.
  const disagreements = scorable
    .filter(p => !p.cmp.exactAgreement)
    .map(p => ({
      id: p.id, subject: p.subject, from: p.from, stopReason: p.stopReason,
      missingFromSonnet: p.cmp.missingFromSonnet,
      extraInSonnet: p.cmp.extraInSonnet,
      timeMismatches: p.cmp.matched.filter(m => !m.timeAgrees),
    }));

  const agreementSample = scorable
    .filter(p => p.cmp.exactAgreement && p.cmp.fableCount > 0)
    .slice(0, 8)
    .map(p => ({ id: p.id, subject: p.subject, events: p.cmp.matched.map(m => m.key) }));

  const totalMicro = pairs.reduce((n, p) => n + (p.costMicro || 0), 0);

  return {
    model: pairs.find(p => p.modelUsed)?.modelUsed || SHADOW_MODEL,
    variant: pairs.find(p => p.variantUsed)?.variantUsed || 'production',
    ...extra,
    scoredMessages: scorable.length,
    // THE RESULT. Everything else is reference.
    newsletterStratum: scoreStratum(newsletter),
    otherStratum: scoreStratum(other),
    // Not scored, deliberately. Listed so they can be looked at directly.
    fableFoundNothingCount: fableFoundNothing.length,
    fableFoundNothing,
    redactedBaseline,
    parseFailures: pairs.filter(p => p.parseError).length,
    disagreements,
    agreementSample,
    shadowCostUsd: Number((totalMicro / 1e6).toFixed(4)),
    note: 'Fable is the incumbent baseline, not ground truth. Recall/precision here are agreement rates; every disagreement needs adjudication before it counts as a Sonnet error.',
  };}
