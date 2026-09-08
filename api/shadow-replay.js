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
const SHADOW_MAX_TOKENS = 8192;   // matched to the live path, so truncation is comparable

// The harness bills to its own key, never to a user's. callClaude checks a
// per-user daily cap before every call; if the replay spent against a real
// user's budget it could trip that cap and abort their live extraction — a
// missed email caused by the measurement. Separate key, separate cap.
const SHADOW_SPEND_KEY_PREFIX = 'shadowSpendMicroUsd';
const SHADOW_DAILY_CAP_USD = Number(process.env.SHADOW_DAILY_CAP_USD || 15);
const SONNET_PRICING = { in: 2, out: 10, cacheRead: 0.1 };

function shadowSpendKey() {
  return `${SHADOW_SPEND_KEY_PREFIX}:${new Date().toISOString().slice(0, 10)}`;
}

function sonnetCostMicroUsd(usage) {
  const inTok = Number(usage?.input_tokens || 0);
  const outTok = Number(usage?.output_tokens || 0);
  const cacheRead = Number(usage?.cache_read_input_tokens || 0);
  const w5 = Number(usage?.cache_creation_input_tokens || 0);
  const inCost = (inTok + w5 * 1.25 + cacheRead * SONNET_PRICING.cacheRead) * SONNET_PRICING.in;
  return Math.ceil(inCost + outTok * SONNET_PRICING.out);
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
export function compareSets(sonnetEvents, fableEvents) {
  const sKeys = new Map(sonnetEvents.map(e => [eventKey(e), e]));
  const fKeys = new Map(fableEvents.map(e => [eventKey(e), e]));
  const matched = [];
  const missingFromSonnet = [];
  const extraInSonnet = [];
  for (const [k, fe] of fKeys) {
    if (sKeys.has(k)) {
      const se = sKeys.get(k);
      // A matching key is not a matching event: same day and title can still
      // disagree on the clock time, which is a real defect hiding behind a
      // count match.
      const timeAgrees = String(se.start_time || se.time || '') === String(fe.time || '');
      matched.push({ key: k, timeAgrees, sonnetTime: se.start_time || se.time || '', fableTime: fe.time || '' });
    } else {
      missingFromSonnet.push({ key: k, title: fe.title, date: fe.date, time: fe.time || '' });
    }
  }
  for (const [k, se] of sKeys) {
    if (!fKeys.has(k)) extraInSonnet.push({ key: k, title: se.title, date: se.date, time: se.start_time || se.time || '' });
  }
  return {
    matched, missingFromSonnet, extraInSonnet,
    fableCount: fKeys.size, sonnetCount: sKeys.size,
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
  for (const p of pairs) {
    matched += p.cmp.matched.length;
    fable += p.cmp.fableCount;
    sonnet += p.cmp.sonnetCount;
    timeMismatch += p.cmp.timeMismatches;
    if (p.stopReason === 'max_tokens') truncated++;
    if (p.cmp.exactAgreement) exact++;
  }
  return {
    messages: pairs.length,
    fableEvents: fable, sonnetEvents: sonnet, matchedEvents: matched,
    recallVsFable: rate(matched, fable),
    precisionVsFable: rate(matched, sonnet),
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

async function sonnetExtract(prompt, subject, body, dateSent) {
  const tail = `Today is ${new Date().toISOString().slice(0, 10)}. This email was sent ${dateSent}.\n\nEmail:\nSubject: ${subject}\n\n${body}`;
  const res = await anthropic.messages.create({
    model: SHADOW_MODEL,
    max_tokens: SHADOW_MAX_TOKENS,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: tail },
    ] }],
  });
  const micro = sonnetCostMicroUsd(res.usage);
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

// ── Orchestration ────────────────────────────────────────────────────────
export async function runReplay({
  email, senders, days = 45, limit = 40, dryRun = false,
} = {}) {
  if (!email) throw new Error('email is required');
  if (!Array.isArray(senders) || !senders.length) throw new Error('at least one sender is required');

  const spentMicro = Number(await redis.get(shadowSpendKey())) || 0;
  if (spentMicro / 1e6 >= SHADOW_DAILY_CAP_USD) {
    throw new Error(`shadow replay budget exhausted: $${(spentMicro / 1e6).toFixed(2)} of $${SHADOW_DAILY_CAP_USD}`);
  }

  const prompt = loadExtractionPrompt(readFileSync(serverSourcePath(), 'utf8'));
  const gmail = await gmailFor(email);
  const ids = await searchCorpus(gmail, senders, days, limit);

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

  const senderSet = new Set(senders.map(s => s.toLowerCase()));
  const pairs = [];
  const skipped = [];

  for (const id of ids) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const subject = headerOf(msg.data, 'Subject');
    const from = headerOf(msg.data, 'From');
    const dateSent = headerOf(msg.data, 'Date');
    const body = extractPlainText(msg.data.payload);
    const fableEvents = storedByMessageId.get(id) || [];

    if (dryRun) {
      pairs.push({ id, subject, from, bodyChars: body.length, fableCount: fableEvents.length, dryRun: true });
      continue;
    }
    if (!body.trim()) { skipped.push({ id, reason: 'empty body' }); continue; }

    let out;
    try { out = await sonnetExtract(prompt, subject, body, dateSent); }
    catch (e) { skipped.push({ id, reason: `sonnet call failed: ${e.message}` }); continue; }

    pairs.push({
      id, subject, from,
      stopReason: out.stopReason,
      parseError: out.parseError,
      cmp: compareSets(out.events, fableEvents),
      costMicro: out.micro,
    });
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

  const inStratum = p => senderSet.has(String(p.from || '').toLowerCase().replace(/^.*<|>.*$/g, ''))
    || senders.some(s => String(p.from || '').toLowerCase().includes(s.toLowerCase()));
  const newsletter = pairs.filter(inStratum);
  const other = pairs.filter(p => !inStratum(p));

  // Only disagreements go to a human. Agreement is evidence, not proof — so a
  // sample of the agreements is surfaced too, to catch a matching count that
  // hides a swapped event.
  const disagreements = pairs
    .filter(p => p.cmp && !p.cmp.exactAgreement)
    .map(p => ({
      id: p.id, subject: p.subject, from: p.from, stopReason: p.stopReason,
      missingFromSonnet: p.cmp.missingFromSonnet,
      extraInSonnet: p.cmp.extraInSonnet,
      timeMismatches: p.cmp.matched.filter(m => !m.timeAgrees),
    }));

  const agreementSample = pairs
    .filter(p => p.cmp && p.cmp.exactAgreement && p.cmp.fableCount > 0)
    .slice(0, 8)
    .map(p => ({ id: p.id, subject: p.subject, events: p.cmp.matched.map(m => m.key) }));

  const totalMicro = pairs.reduce((n, p) => n + (p.costMicro || 0), 0);

  return {
    model: SHADOW_MODEL,
    query: buildSenderQuery(senders, days),
    corpusSize: ids.length,
    // THE RESULT. Everything else is reference.
    newsletterStratum: scoreStratum(newsletter),
    otherStratum: scoreStratum(other),
    parseFailures: pairs.filter(p => p.parseError).length,
    skipped,
    disagreements,
    agreementSample,
    shadowCostUsd: Number((totalMicro / 1e6).toFixed(4)),
    note: 'Fable is the incumbent baseline, not ground truth. Recall/precision here are agreement rates; every disagreement needs adjudication before it counts as a Sonnet error.',
  };
}
