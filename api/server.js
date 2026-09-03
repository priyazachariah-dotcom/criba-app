import express from 'express';
import cookieParser from 'cookie-parser';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import ical from 'node-ical';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import fs from 'fs';
import crypto from 'crypto';
import Redis from 'ioredis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 20 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SECRET = process.env.SESSION_SECRET || 'criba-secret-key-2026';

const redis = new Redis(process.env.REDIS_URL);

// Async wrapper over a Redis hash that mirrors the Map methods the routes
// were already calling (get/set/has/delete/values/entries), since Redis
// access is inherently async unlike the in-memory Map it replaces.
class RedisHashMap {
  constructor(key) { this.key = key; }
  async get(field) {
    const val = await redis.hget(this.key, field);
    return val ? JSON.parse(val) : undefined;
  }
  async set(field, value) {
    await redis.hset(this.key, field, JSON.stringify(value));
    return this;
  }
  async has(field) {
    return (await redis.hexists(this.key, field)) === 1;
  }
  async delete(field) {
    return (await redis.hdel(this.key, field)) > 0;
  }
  async values() {
    const all = await redis.hgetall(this.key);
    return Object.values(all).map(v => JSON.parse(v));
  }
  async entries() {
    const all = await redis.hgetall(this.key);
    return Object.entries(all).map(([k, v]) => [k, JSON.parse(v)]);
  }
  // Batches multiple field writes into a single round trip (used when
  // importing many events at once from an iCal feed or PDF).
  async setMany(pairs) {
    if (!pairs.length) return;
    const pipeline = redis.pipeline();
    for (const [field, value] of pairs) pipeline.hset(this.key, field, JSON.stringify(value));
    await pipeline.exec();
  }
}

function getUserEvents(email) {
  return new RedisHashMap(`events:${email}`);
}

function getUserCalendars(email) {
  return new RedisHashMap(`calendars:${email}`);
}

function getUserFamily(email) {
  return new RedisHashMap(`family:${email}`);
}

function getUserSettings(email) {
  return new RedisHashMap(`settings:${email}`);
}

// Exclusion rules — the things the user has explicitly told Criba to stop
// showing. Keyed by the rule's canonical id, so confirming the same rule twice
// updates one record instead of growing a duplicate.
function getUserExclusions(email) {
  return new RedisHashMap(`exclusions:${email}`);
}

// ── Decisions — what the user said, kept apart from what Criba did ────────
//
// Everything else in this file records Criba's actions: status is a pipeline
// position, calEventId is a calendar fact, gcalWritten is a write log. None of
// them survives contact with a second email about the same event, because rows
// are minted per extraction — a dismissal attaches to a disposable artifact of
// one email and the next email never consults it. Bug #14.
//
// This store records the decision itself, keyed by the same date|title
// normalisation as the gcalWritten guard (decisionKey — one notion of "same
// event", already tested against 523 real rows with zero false merges).
// Deliberately date-scoped: "no to this event on this date", never "no to this
// title forever". Date-scoped fails safely — the worst case is the event
// resurfacing for one more click, never a different future event silently
// suppressed.
//
// No migration: historical dismissed/cancelled/rejected rows stay untouched and
// do not populate this store. It governs only what the user decides from now on.
function getUserDecisions(email) {
  return new RedisHashMap(`decisions:${email}`);
}

// Called from every path where the user (or the school, for a confirmed
// cancellation) says no to a specific event. Never inferred; each call site is
// an explicit gesture. Failures are logged and swallowed — a refusal that fails
// to record must not break the dismissal the user actually asked for.
async function recordRefusal(email, ev, via) {
  try {
    if (!ev?.date || !ev?.title) return;
    const store = getUserDecisions(email);
    const key = decisionKey(ev.date, ev.title);
    const prev = await store.get(key);
    await store.set(key, {
      key, verdict: 'no', title: ev.title, date: ev.date, via,
      source_event_id: ev.id || null,
      decided_at: prev?.decided_at || new Date().toISOString(),
      last_affirmed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[decisions] record failed for "${ev?.title}":`, err.message);
  }
}

// A yes erases the no. Without this, approving a held event from Review would
// work once and then the same refusal would hold it again on the next email —
// "one click adds it" has to mean the click also retires the rule that held it.
async function clearRefusal(email, ev) {
  try {
    if (ev?.date && ev?.title) await getUserDecisions(email).delete(decisionKey(ev.date, ev.title));
  } catch (err) {
    console.error(`[decisions] clear failed for "${ev?.title}":`, err.message);
  }
}

// The gate's question, consulted by the webhook and backfill paths BEFORE
// their dedup checks — a prior "no" always resurfaces for review rather than
// being swallowed by a blocking row or auto-written again.
async function priorRefusal(email, date, title) {
  try {
    const d = await getUserDecisions(email).get(decisionKey(date, title));
    return d?.verdict === 'no' ? d : null;
  } catch (err) {
    // An unreadable store must not hold mail; failing open here means at worst
    // a duplicate card, where failing closed would mean a silent drop.
    console.error('[decisions] lookup failed:', err.message);
    return null;
  }
}

// The exact fields a refusal-hold writes, shared by the replay endpoint and the
// live path so what the debug endpoint shows is what the user will read.
function refusalHold(d) {
  const when = String(d.decided_at || d.at || '').slice(0, 10) || 'earlier';
  return {
    held_reason: `you said no to this on ${when}`,
    conflict_note: `Not added — you said no to this on ${when}. It came up again, so it's here for you to decide.`,
  };
}

// One honest sentence for a calendar-duplicate, wherever it is rendered. The
// write-guard case used to claim "Already on your calendar" when the guard had
// only matched a 400-day Redis signature — the event may have been removed on
// purpose, and the card asserted something the calendar no longer said.
function calDupNote(dup, targetCalId) {
  if (dup?.via === 'write-guard') {
    return `Criba added "${dup.title}" once before — not re-added automatically, in case you removed it on purpose`;
  }
  return `Already on your calendar as "${dup.title}"${dup.calendarName && dup.calendarId !== targetCalId ? ` (${dup.calendarName})` : ''} — not added again`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// People who are routinely invited to events — a co-parent, a grandparent, an
// ex. Started life as a single `partnerEmail` string, which meant re-finding
// the same person in contact search on every card. Any address saved here is
// read back as an existing record, so a stored one is migrated in place rather
// than stranded when the setting became a list.
// Anthropic errors arrive as a raw 400 with a JSON blob inside the message.
// Shown verbatim they are unreadable; swallowed entirely they leave a silent
// zero. Translate the ones a user can actually act on, and pass anything else
// through trimmed rather than inventing a reassuring summary for it.
// ── Daily spend cap ───────────────────────────────────────────────────────
//
// Every cost bug found so far failed the same way: it spent money silently.
// A pinned history cursor re-walked 399 messages every few minutes for hours
// and nothing anywhere said so; the first signal was the bill. This is the
// backstop that does not depend on having found every such bug. It measures
// real usage returned by the API — not estimates — and refuses to start more
// work once a user has cost more than the ceiling in a day.

// $5 is a runaway-loop backstop, not a normal-usage budget. For scale: at the
// current EXTRACTION_CHAR_LIMIT one extraction costs about $0.09, so this is
// roughly 57 emails. A full 150-email scan costs about $13 and WILL hit this —
// deliberately. A first full scan is a rare, deliberate act that can be raised
// for; an unattended loop billing $35 per webhook fire is not.
// How old an email may be and still be extracted on the webhook path.
//
// 24 hours, and it is a hard product rule rather than a tuning knob. The
// webhook exists to catch NEW mail. Anything older reached it through a gap in
// the cursor, which is a fault to recover from cheaply — not a backlog worth
// paying full extraction price for, and not something to crowd the user's
// review queue with events she dealt with weeks ago.
//
// A deliberate historical sweep is what the backfill scan is for, and the user
// starts that one on purpose, knowing what it costs.
const WEBHOOK_MAX_EMAIL_AGE_DAYS = Number(process.env.WEBHOOK_MAX_EMAIL_AGE_DAYS || 1);

const DAILY_SPEND_CAP_USD = Number(process.env.DAILY_SPEND_CAP_USD || 5);

// Dollars per million tokens. An unrecognised model is priced at the most
// expensive tier we know of: an unknown model must never be silently cheap,
// because that turns the cap into a no-op exactly when it is most needed.
const MODEL_PRICING = {
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
const FALLBACK_PRICING = { in: 5, out: 25 };

// Marker string. The webhook aborts a whole run on this rather than retrying
// per message, and summariseApiError turns it into something a user can read.
const SPEND_CAP_ERROR = 'DAILY_SPEND_CAP_REACHED';

function spendKey(email) {
  const day = new Date().toISOString().slice(0, 10);
  return `spendMicroUsd:${String(email || 'unattributed').toLowerCase()}:${day}`;
}

// Micro-dollars as an integer, so Redis INCRBY stays exact. Floating-point
// cents accumulated over thousands of calls drift.
function costMicroUsd(model, usage) {
  const p = MODEL_PRICING[model] || FALLBACK_PRICING;
  const cacheRead = Number(usage?.cache_read_input_tokens || 0);
  const cacheWrite = Number(usage?.cache_creation_input_tokens || 0);
  const inTok = Number(usage?.input_tokens || 0);
  const outTok = Number(usage?.output_tokens || 0);
  // Cache reads bill at ~0.1x and cache writes at ~1.25x. Neither is in use
  // yet, but counting them now means enabling caching later cannot quietly
  // desynchronise the meter from the invoice.
  const inCost = (inTok + cacheWrite * 1.25 + cacheRead * 0.1) * p.in;
  const outCost = outTok * p.out;
  return Math.ceil((inCost + outCost));
}

async function getSpendTodayUsd(email) {
  const v = Number(await redis.get(spendKey(email))) || 0;
  return v / 1e6;
}

// Called before work starts, not per call, so a user who is already over
// budget is told once rather than discovering it mid-run.
async function spendBudgetState(email) {
  const spent = await getSpendTodayUsd(email);
  return { spent, cap: DAILY_SPEND_CAP_USD, exceeded: spent >= DAILY_SPEND_CAP_USD };
}

// The only path to Claude. Every call site goes through here so that adding a
// new feature cannot accidentally create an unmetered one.
async function callClaude(email, params, label = 'call') {
  const { exceeded, spent } = await spendBudgetState(email);
  if (exceeded) {
    console.error(`[spend] BLOCKED ${label} for ${email} — $${spent.toFixed(2)} of $${DAILY_SPEND_CAP_USD} used today`);
    throw new Error(`${SPEND_CAP_ERROR}: $${spent.toFixed(2)} of $${DAILY_SPEND_CAP_USD.toFixed(2)} daily limit used`);
  }
  const response = await anthropic.messages.create(params);
  try {
    const micro = costMicroUsd(params.model, response?.usage);
    if (micro > 0) {
      const key = spendKey(email);
      await redis.incrby(key, micro);
      // Comfortably longer than a day so the key survives timezone edges,
      // short enough that it cannot accumulate forever.
      await redis.expire(key, 7 * 24 * 60 * 60);
      // Broken down by call site as well as totalled. "You spent $4 today" is
      // not actionable; "$3.80 of it was gmail-extract" says which lever to
      // pull. Counted per label and per call so an unexpectedly chatty path
      // shows up as a call count, not just a number.
      const bd = `${key}:by`;
      await redis.hincrby(bd, `${label}:micro`, micro);
      await redis.hincrby(bd, `${label}:calls`, 1);
      await redis.expire(bd, 7 * 24 * 60 * 60);
    }
  } catch (meterErr) {
    // A meter failure must not fail the user's extraction. It is logged loudly
    // because an unmetered call is exactly what this whole mechanism exists to
    // prevent, but the work that already succeeded still stands.
    console.error(`[spend] failed to record usage for ${email}:`, meterErr.message);
  }
  return response;
}

function summariseApiError(msg) {
  const m = String(msg || '');
  if (!m) return '';
  if (m.includes(SPEND_CAP_ERROR)) return `Criba paused itself — ${m.split(': ').slice(1).join(': ')}. This resets at midnight UTC. Raise DAILY_SPEND_CAP_USD if you need a bigger allowance.`;
  if (/credit balance is too low/i.test(m)) return 'Anthropic credits exhausted — top up at console.anthropic.com under Plans & Billing.';
  if (/rate.?limit|429/i.test(m)) return 'Anthropic rate limit reached — wait a minute and scan again.';
  if (/overloaded|529/i.test(m)) return 'Anthropic is overloaded right now — try again shortly.';
  if (/authentication|invalid x-api-key|401/i.test(m)) return 'Anthropic API key rejected — check ANTHROPIC_API_KEY.';
  if (/not_found_error|model/i.test(m) && /404/.test(m)) return 'The configured AI model was not found — check the model name.';
  return m.length > 160 ? `${m.slice(0, 160)}…` : m;
}

async function getSavedRecipients(email) {
  const settings = getUserSettings(email);
  const list = await settings.get('recipients');
  if (Array.isArray(list)) return list;
  const legacy = await settings.get('partnerEmail');
  return legacy ? [{ name: legacy.split('@')[0], email: legacy }] : [];
}

// Returns the target calendarId — always 'primary' (single-calendar model),
// unless test mode is active, in which case the test calendar is returned.
async function resolveTargetCalendar(email) {
  const settings = getUserSettings(email);
  const testCalId = (await settings.get('testCalendarId')) || null;
  return testCalId || 'primary';
}

// Returns a Google Calendar event colorId ("1"–"11") for the relevant person,
// or null to use the calendar default color.
async function resolveEventColor(email, preferredMemberId, calSrc) {
  const familyStore = getUserFamily(email);
  let member = null;
  if (preferredMemberId) member = await familyStore.get(preferredMemberId);
  else if (calSrc?.memberId) member = await familyStore.get(calSrc.memberId);
  return member?.eventColor || member?.color || null;
}

// Which family member does this event belong to?
//
// Matched on whole words. The old test was `attendeeName.includes(memberName)`,
// which meant a member called "Al" matched a sender called "Alison Parker" and
// coloured the event for the wrong person.
//
// Claude's attendee tagging is the primary signal, but plenty of events name the
// child only in the title ("Aarav's soccer practice"), so `text` — title,
// location and notes — is checked as a fallback.
function matchFamilyMember(members, nameStrings, text = '') {
  if (!members?.length) return null;
  const norm = s => String(s || '').toLowerCase().trim();
  const hasWord = (haystack, needle) => {
    if (!needle) return false;
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(haystack);
  };
  for (const name of (nameStrings || [])) {
    const n = norm(name);
    if (!n) continue;
    const match = members.find(m => norm(m.name) === n || hasWord(n, norm(m.name)));
    if (match) return match;
  }
  const hay = norm(text);
  if (hay) {
    // First name only, so "Aarav's" and "Aarav Zachariah" both hit.
    for (const m of members) {
      const first = norm(m.name).split(/\s+/)[0];
      if (first && first.length > 2 && hasWord(hay, first)) return m;
    }
  }
  return null;
}

// ── Grade relevance ───────────────────────────────────────────────────────
// A school newsletter covers the whole school. Criba was writing every event in
// it to the calendar, so a family with a third grader got Kindergarten Full-Day
// Schedule Begins, TK What to Expect Night and the K-2nd presentations — none of
// which will ever concern them. That is not a filtering nicety; it is the
// difference between a calendar you trust and one you stop reading.
//
// Grades are normalised to numbers so ranges work: TK is -1, K is 0.
const GRADE_NAMED = { tk: -1, 'pre-k': -1, prek: -1, 'transitional kindergarten': -1, k: 0, kinder: 0, kindergarten: 0 };

function normalizeGrade(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(GRADE_NAMED, s)) return GRADE_NAMED[s];
  const m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n : null;
}

// Which grades does this text single out? Returns an empty set when the text
// isn't about particular grades at all — which is the common case, and must be
// treated as "concerns everyone" rather than "concerns nobody".
//
// Deliberately conservative. A false positive here hides a real event, so a
// grade only counts when it is unambiguously a grade: the word kindergarten or
// TK, an explicit "3rd grade" / "grades 4-6", or an ordinal range like "K-2nd".
// A bare "1st" is left alone — it is far more often a place or a date.
function gradesMentionedIn(text) {
  const t = String(text || '').toLowerCase();
  const found = new Set();
  const add = g => { if (g !== null) found.add(g); };
  const expand = (a, b) => { if (a !== null && b !== null && b >= a) for (let g = a; g <= b; g++) found.add(g); };

  if (/\btransitional kindergarten\b/.test(t)) add(-1);
  if (/\bkindergarten\b|\bkinder\b/.test(t)) add(0);
  if (/\btk\b/.test(t)) add(-1);
  if (/\bpre-?k\b/.test(t)) add(-1);

  const ORD = '(tk|k|\\d{1,2}(?:st|nd|rd|th))';
  // Ranges: "K-2nd", "3rd-5th", "grades 4 through 6".
  for (const m of t.matchAll(new RegExp(`\\b${ORD}\\s*(?:-|–|—|to|through)\\s*${ORD}\\b`, 'g'))) {
    expand(normalizeGrade(m[1]), normalizeGrade(m[2]));
  }
  // "grades 6 through 8" — bare digits, so the ordinal pattern above misses it.
  // Safe to read loosely here because the word "grades" already disambiguates.
  const N = '(\\d{1,2})(?:st|nd|rd|th)?';
  for (const m of t.matchAll(new RegExp(`\\bgrades?\\s+${N}\\s*(?:-|–|—|to|through)\\s*${N}\\b`, 'g'))) {
    expand(normalizeGrade(m[1]), normalizeGrade(m[2]));
  }
  // "grades 6 and 8" lists two grades; it does not span the ones between.
  for (const m of t.matchAll(new RegExp(`\\bgrades?\\s+${N}\\s*(?:and|&|,)\\s*${N}\\b`, 'g'))) {
    add(normalizeGrade(m[1])); add(normalizeGrade(m[2]));
  }
  // Explicit singles: "3rd grade", "grade 3".
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+grade\b/g)) add(normalizeGrade(m[1]));
  for (const m of t.matchAll(/\bgrades?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) add(normalizeGrade(m[1]));

  return found;
}

// Does this event concern anyone in the family?
// Returns { relevant, reason }. Anything uncertain is relevant: the cost of
// showing one extra event is far below the cost of silently withholding one.
function gradeRelevance(text, members) {
  const mentioned = gradesMentionedIn(text);
  if (!mentioned.size) return { relevant: true, reason: null };

  const ourGrades = (members || [])
    .map(m => normalizeGrade(m.grade))
    .filter(g => g !== null);
  // No grades on file means no basis to exclude anything.
  if (!ourGrades.length) return { relevant: true, reason: null };

  if (ourGrades.some(g => mentioned.has(g))) return { relevant: true, reason: null };

  const label = g => g === -1 ? 'TK' : g === 0 ? 'K' : `${g}`;
  return {
    relevant: false,
    reason: `For grade ${[...mentioned].sort((a, b) => a - b).map(label).join(', ')} — nobody in your family is in that grade`,
  };
}

// ── Negative facts (exclusion rules) ──────────────────────────────────────
//
// Everything else Criba stores is an association that exists: this child plays
// this sport, this domain means this person. Nothing could say "not this", so
// dismissing an event taught it nothing and the same wrong event arrived again
// the following week, forever.
//
// A rule is only ever written from an explicit answer to an explicit question
// ("Stop showing grade 3 events?"), never inferred from the dismissal itself.
// Dismissing is a discard; a rule is a decision, and the two must not be the
// same gesture — otherwise a tired thumb builds a filter nobody chose.
//
// Rules are household-level rather than per-member because that is what they
// actually mean: "nobody here is in 3rd grade" is a fact about the family.
const EXCLUSION_TYPES = new Set(['grade', 'tier', 'sender', 'activity']);

function exclusionLabel(type, value) {
  if (type === 'grade') {
    const g = Number(value);
    return g === -1 ? 'TK events' : g === 0 ? 'Kindergarten events' : `grade ${g} events`;
  }
  if (type === 'sender') return `events from ${value}`;
  return `${value} events`;
}

// Canonicalises a rule so the same exclusion cannot be stored twice under two
// spellings. Returns null for anything it cannot make sense of rather than
// storing a rule that will never match — an inert rule in the list would read
// as "Criba is hiding this" while hiding nothing.
function normalizeExclusion(raw) {
  const type = String(raw?.type || '').toLowerCase().trim();
  if (!EXCLUSION_TYPES.has(type)) return null;
  let value = String(raw?.value ?? '').toLowerCase().trim();
  if (!value) return null;

  if (type === 'grade') {
    // Accepts both what the user types ("3rd", "K") and what gradesMentionedIn
    // already returns (a number, where TK is -1 and K is 0).
    const n = Number(value);
    const g = Number.isInteger(n) && n >= -1 && n <= 12 ? n : normalizeGrade(value);
    if (g === null) return null;
    value = String(g);
  } else if (type === 'tier') {
    const t = normalizeTier(value);
    if (!t) return null;
    value = t;
  } else if (type === 'sender') {
    value = value.replace(/^@/, '').split('@').pop();
    if (!value.includes('.')) return null;
  }

  return {
    id: `${type}:${value}`,
    type,
    value,
    label: exclusionLabel(type, value),
    confidence: 'confirmed',
    created_at: new Date().toISOString(),
  };
}

// A confirmed positive fact always beats a negative one. Grades change, teams
// change, and a stale exclusion that outlives the truth would silently hide a
// real child's real event — the one failure this whole feature must not cause.
function familyHasPositive(members, type, value) {
  const list = Array.isArray(members) ? members : [];
  const acts = m => (Array.isArray(m.activities) ? m.activities : []);
  if (type === 'grade') return list.some(m => normalizeGrade(m.grade) === Number(value));
  if (type === 'sender') return list.some(m => (Array.isArray(m.senders) ? m.senders : [])
    .some(s => s.domain === value && s.confidence === 'confirmed'));
  if (type === 'activity') return list.some(m => acts(m)
    .some(a => a.sport_or_type === value && a.confidence === 'confirmed'));
  if (type === 'tier') return list.some(m => acts(m)
    .some(a => a.team_tier === value && a.confidence === 'confirmed'));
  return false;
}

// A consumer mailbox domain identifies no organisation. "Events from gmail.com"
// is not a rule about a school or a club — it is a rule that hides every friend,
// every relative and every note the user sends herself. One such rule was
// created and only failed to empty the inbox because an unrelated confirmed
// sender chip happened to override it; removing that chip would have armed it.
// These must never be offered as exclusions, however the dismissal is worded.
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com',
  'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'zoho.com', 'yandex.com', 'mail.com',
]);

// What could this dismissal honestly become a rule about?
//
// Returns the narrowest defensible group, or [] when the text supports nothing
// — in which case the user is never asked at all. A question whose only honest
// answer is "I can't tell what you meant" is worse than no question.
function exclusionCandidates(event, reason, members) {
  const text = [event?.title, event?.location, event?.notes, event?.subject].filter(Boolean).join(' ');
  const mk = (type, value) => normalizeExclusion({ type, value });
  // Never offer to exclude something the family is confirmed to be part of.
  const ok = c => !!c && !familyHasPositive(members, c.type, c.value);

  if (reason === 'wrong-grade-tier') {
    // Grade first: it is the more concrete of the two and the one the existing
    // relevance check already understands.
    const grades = [...gradesMentionedIn(text)].map(g => mk('grade', String(g))).filter(ok);
    if (grades.length) return grades;
    return [...tiersMentionedIn(text)].map(t => mk('tier', t)).filter(ok);
  }
  if (reason === 'wrong-sender-activity') {
    const domain = String(event?.sender_email || '').toLowerCase().split('@').pop();
    const sender = domain && domain.includes('.') && !FREEMAIL_DOMAINS.has(domain)
      ? mk('sender', domain) : null;
    if (ok(sender)) return [sender];
    // No usable sender, or the sender is one we have confirmed belongs to a
    // child — an upload, or the school both kids attend. Fall back to the
    // activity, which is narrower than the domain anyway.
    return [...activityTypesIn(text)].map(t => mk('activity', t)).filter(ok);
  }
  return [];
}

function exclusionPrompt(candidates) {
  const labels = candidates.map(c => c.label);
  const list = labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
    : labels[0];
  return `Stop showing ${list}?`;
}

// The relevance gate, now answering two questions instead of one: is anyone in
// this family in the grade this event is for, and has the user asked Criba to
// stop showing events like it. Both hold the event back rather than discard it
// — it still reaches the queue with the reason attached, one click from added.
function eventRelevance(text, members, exclusions = [], senderEmail = null, audience = 'you') {
  // A digest carries other people's business next to the reader's own. The two
  // previous questions could not tell them apart: a neighbour's ticket sale
  // mentions no grade and comes from a newsletter the user deliberately
  // subscribes to, so it passed both checks and was written straight to her
  // calendar. Ownership is a third question, and it has to be asked first —
  // an event that is not hers is not made hers by matching a grade.
  if (audience === 'third_party') {
    return { relevant: false, reason: 'this looks like someone else\u2019s event, mentioned in a newsletter' };
  }
  // An opportunity is a date that only matters if she opts in. Three film
  // festival submission deadlines, a fellowship application and a class action
  // claim were written to her calendar in one afternoon, none of them anything
  // she had signed up for. Extraction is asked to miss nothing, which is right
  // for a school newsletter and catastrophic for an industry one: every issue
  // carries a fresh crop of real dates that are not hers.
  // Gmail promotions are dropped before they are ever stored. This is the
  // backstop for any other path (an upload, a future source) where one gets
  // this far: held, not written, so the failure mode is a stray review card
  // rather than a discount code on the calendar.
  if (audience === 'promotion') {
    return { relevant: false, reason: 'a promotional offer, not something on your calendar' };
  }
  if (audience === 'opportunity') {
    return { relevant: false, reason: 'an opportunity from a newsletter, not something you signed up for' };
  }
  const base = gradeRelevance(text, members);
  if (!base.relevant) return base;

  const rules = Array.isArray(exclusions) ? exclusions : [];
  if (!rules.length) return base;

  const held = rule => ({ relevant: false, reason: `you asked Criba to stop showing ${rule.label}` });
  const hit = (type, values) => rules.find(r =>
    r.type === type && values.has(r.value) && !familyHasPositive(members, r.type, r.value));

  const g = hit('grade', new Set([...gradesMentionedIn(text)].map(String)));
  if (g) return held(g);

  const domain = String(senderEmail || '').toLowerCase().split('@').pop();
  // Rules of this shape should never have been creatable, but one already
  // exists in production. Refuse to honour it rather than waiting for the
  // accident that currently neutralises it to be tidied away.
  const s = domain && domain.includes('.') && !FREEMAIL_DOMAINS.has(domain)
    ? hit('sender', new Set([domain])) : null;
  if (s) return held(s);

  const t = hit('tier', tiersMentionedIn(text));
  if (t) return held(t);

  const a = hit('activity', activityTypesIn(text));
  if (a) return held(a);

  return base;
}

// Who is an event about, when nobody's name appears in it?
//
// matchFamilyMember needs a name written down somewhere. For the mail that
// actually fills a family calendar there usually isn't one: "Frosh Home Game vs
// Redwood" names a school and an opponent, "Regular Early Release Day" names
// neither. So attribution failed on exactly the events that matter, and the
// user picked a colour by hand — then picked the same colour for the next mail
// from the same school, and the next, forever. Criba had every one of those
// decisions on record and consulted none of them.
//
// This reads them back. Keyed on sender domain rather than address because a
// school speaks through many mailboxes — newsletters@, the coach, the athletic
// director are all siprep.org, and all about the same child.
//
// Only explicit user choices count as evidence. event.member_id is written when
// the user approves or edits an event, never by a guess; feeding automatic
// suggestions back in would let one wrong guess confirm itself indefinitely.
function learnSenderAttribution(allEvents) {
  const byDomain = new Map();
  for (const e of allEvents || []) {
    if (!e?.member_id || !e?.sender_email) continue;
    const domain = String(e.sender_email).toLowerCase().split('@')[1];
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, new Map());
    const counts = byDomain.get(domain);
    counts.set(e.member_id, (counts.get(e.member_id) || 0) + 1);
  }

  const out = new Map();
  for (const [domain, counts] of byDomain) {
    let top = null, topN = 0, total = 0;
    for (const [id, n] of counts) { total += n; if (n > topN) { topN = n; top = id; } }
    // Two decisions minimum and the user has to have been consistent. One pick
    // is an anecdote. A sender split evenly between two children is a sender
    // that genuinely serves both, and guessing there would be worse than the
    // blank the user can fill in.
    if (total >= 2 && topN / total >= 0.75) out.set(domain, { memberId: top, n: topN, total });
  }
  return out;
}

// ── Structured activity facts ─────────────────────────────────────────────────
//
// learnSenderAttribution above keys on sender domain alone, which is too coarse
// for the case that actually breaks: one school, one sport, two teams. A frosh
// football mail and a varsity football mail both come from siprep.org and both
// say "football", so domain attribution colours them identically. If the frosh
// one is your child's and the varsity one is not, the calendar is quietly wrong
// and nothing on screen says a guess was made.
//
// An activity record carries the discriminators that tell those apart:
//   { sport_or_type, org, team_tier, sender_domain, confidence }
// team_tier is a HARD requirement — see tierRelation. Everything else narrows.

// Tokens that name a competitive tier. "junior varsity" is consumed before
// "varsity" is tested, otherwise every JV mail would also read as varsity.
const TIER_PATTERNS = [
  { tier: 'frosh-soph', re: /\b(frosh[-\s/]?soph(?:omore)?|f\/s)\b/ },
  { tier: 'frosh', re: /\b(frosh|freshman|freshmen)\b/ },
  { tier: 'jv', re: /\b(junior varsity|jv)\b/ },
  { tier: 'varsity', re: /\bvarsity\b/ },
];

// Tiers that should not be treated as contradicting each other. A frosh-soph
// team is the team a freshman plays on, so a parent who wrote "frosh" and a
// coach who wrote "frosh/soph" mean the same thing and must not collide.
const TIER_COMPATIBLE = [new Set(['frosh', 'frosh-soph'])];

function normalizeTier(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return null;
  for (const { tier, re } of TIER_PATTERNS) if (re.test(s)) return tier;
  return null;
}

// Which tiers does this text name? Empty set means the text is silent on tier,
// which is "unknown", never "none" — see tierRelation.
function tiersMentionedIn(text) {
  let t = String(text || '').toLowerCase();
  const found = new Set();
  for (const { tier, re } of TIER_PATTERNS) {
    if (re.test(t)) {
      found.add(tier);
      // Consume the match so a longer alias cannot also satisfy a shorter one
      // ("junior varsity" must not additionally register as varsity).
      t = t.replace(new RegExp(re.source, 'g'), ' ');
    }
  }
  return found;
}

// 'match' | 'conflict' | 'unknown'. Only 'conflict' excludes, and it requires
// positive evidence on both sides: a tier written in the email and a different
// tier recorded on the activity. Silence never excludes anyone.
function tierRelation(activityTier, mentionedTiers) {
  const at = normalizeTier(activityTier);
  if (!at) return 'unknown';
  if (!mentionedTiers || !mentionedTiers.size) return 'unknown';
  for (const mt of mentionedTiers) {
    if (mt === at) return 'match';
    if (TIER_COMPATIBLE.some(g => g.has(mt) && g.has(at))) return 'match';
  }
  return 'conflict';
}

// Activity types Criba can recognise unprompted in email text. Kept to things
// that are unambiguously an activity when they appear next to a date; a word
// like "band" or "chess" is far more often prose, so those have to be typed in
// by the user rather than detected.
const ACTIVITY_TYPE_PATTERNS = [
  ['football', /\bfootball\b/], ['soccer', /\bsoccer\b/], ['basketball', /\bbasketball\b/],
  ['baseball', /\bbaseball\b/], ['softball', /\bsoftball\b/], ['volleyball', /\bvolleyball\b/],
  ['lacrosse', /\blacrosse\b/], ['hockey', /\bhockey\b/], ['tennis', /\btennis\b/],
  ['swimming', /\bswim(?:ming|\s*team|\s*meet)\b/],
  ['cross country', /\bcross[-\s]country\b/], ['water polo', /\bwater\s*polo\b/],
  ['track', /\btrack(?:\s*(?:and|&)\s*field)?\b/],
  ['golf', /\bgolf\b/], ['wrestling', /\bwrestling\b/], ['rowing', /\b(rowing|crew)\b/],
];

function activityTypesIn(text) {
  const t = String(text || '').toLowerCase();
  const found = new Set();
  for (const [type, re] of ACTIVITY_TYPE_PATTERNS) if (re.test(t)) found.add(type);
  return found;
}

// Normalise whatever the client sent into storable activity records. Unknown
// keys are dropped rather than persisted, and an activity with no type is
// meaningless so it is discarded outright.
function normalizeActivities(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    const type = String(a?.sport_or_type || '').toLowerCase().trim();
    if (!type) continue;
    const rec = {
      sport_or_type: type,
      org: String(a?.org || '').trim() || null,
      team_tier: normalizeTier(a?.team_tier),
      sender_domain: String(a?.sender_domain || '').toLowerCase().trim().replace(/^@/, '') || null,
      confidence: a?.confidence === 'confirmed' ? 'confirmed' : 'inferred',
    };
    // Same type, org, tier and domain twice is the same fact twice.
    const dupe = out.some(x => x.sport_or_type === rec.sport_or_type
      && x.org === rec.org && x.team_tier === rec.team_tier && x.sender_domain === rec.sender_domain);
    if (!dupe) out.push(rec);
  }
  return out;
}

// Who does this event belong to?
//
// Returns { memberId, reason, ambiguous, ambiguityReason }. Exactly one of
// memberId / ambiguous is meaningful: an ambiguous result must not be coloured,
// because a wrong colour shown confidently is worse than no colour at all.
//
// Silence is never grounds for exclusion, but a stated contradiction is.
function attributeByActivity(members, text, senderDomain) {
  const domain = String(senderDomain || '').toLowerCase().split('@').pop() || null;
  const tiers = tiersMentionedIn(text);
  const types = activityTypesIn(text);

  // A candidate is an activity this email could plausibly be about: it names
  // the activity, or it comes from the address that activity arrives from.
  const candidates = [];
  for (const m of members || []) {
    for (const a of Array.isArray(m.activities) ? m.activities : []) {
      const typeHit = !!(a.sport_or_type && types.has(a.sport_or_type));
      const domainHit = !!(a.sender_domain && domain && a.sender_domain === domain);
      if (!typeHit && !domainHit) continue;
      candidates.push({ member: m, activity: a, typeHit, domainHit, rel: tierRelation(a.team_tier, tiers) });
    }
  }
  if (!candidates.length) return { memberId: null, reason: null, ambiguous: false, ambiguityReason: null };

  const viable = candidates.filter(c => c.rel !== 'conflict');

  // Every candidate contradicted. This is the varsity-mail-to-a-frosh-parent
  // case: we know enough to be sure it is NOT the recorded activity, and not
  // enough to say whose it is. Falling back to domain attribution here would
  // undo the whole point, so this returns without one.
  if (!viable.length) {
    const named = [...tiers].join('/') || 'another team';
    const rec = candidates[0];
    return {
      memberId: null, reason: null, ambiguous: true,
      ambiguityReason: `Looks like ${named} ${rec.activity.sport_or_type} — ${rec.member.name} is recorded as ${rec.activity.team_tier}`,
    };
  }

  // Narrow before declaring a collision. Two children in the same sport is the
  // normal case, not an impasse — what separates them is which league the mail
  // came from ("SI Prep for Aarav and Next Level for Arin"). Positive tier
  // evidence outranks a domain match, and a domain match outranks the bare fact
  // that both children play the sport.
  let pool = viable;
  const tierMatched = pool.filter(c => c.rel === 'match');
  if (tierMatched.length) pool = tierMatched;
  else {
    const domainMatched = pool.filter(c => c.domainHit);
    if (domainMatched.length) pool = domainMatched;
  }

  const distinct = [...new Set(pool.map(c => c.member.id))];
  if (distinct.length > 1) {
    const names = distinct.map(id => pool.find(c => c.member.id === id).member.name);
    return {
      memberId: null, reason: null, ambiguous: true,
      ambiguityReason: `Could be ${names.join(' or ')} — both have a matching activity`,
    };
  }

  const best = pool.find(c => c.rel === 'match') || pool[0];
  // An inferred fact acted on without positive tier evidence is a guess resting
  // on a guess. Confirmed facts may act on silence; inferred ones may not.
  if (best.activity.confidence !== 'confirmed' && best.rel !== 'match') {
    return {
      memberId: null, reason: null, ambiguous: true,
      ambiguityReason: `${best.member.name}'s ${best.activity.sport_or_type} is a guess Criba hasn't had confirmed`,
    };
  }

  // The member records two teams in this sport and the mail names neither.
  const sameType = pool.filter(c => c.activity.sport_or_type === best.activity.sport_or_type);
  if (best.rel === 'unknown' && new Set(sameType.map(c => c.activity.team_tier)).size > 1) {
    return {
      memberId: null, reason: null, ambiguous: true,
      ambiguityReason: `${best.member.name} has more than one ${best.activity.sport_or_type} team and this doesn't say which`,
    };
  }

  const bits = [best.activity.team_tier, best.activity.sport_or_type].filter(Boolean).join(' ');
  return {
    memberId: best.member.id,
    reason: `${best.member.name} plays ${bits}`,
    ambiguous: false, ambiguityReason: null,
  };
}

// ── Confirmed sender facts ────────────────────────────────────────────────────
//
// Activities answer "what does this person do". They cannot answer "who is this
// sender about", and that turned out to be the question most real mail asks.
// Tested against the five events actually attributed by hand in this account —
// "West Parent Newsletter", "New Families Welcome Coffee", "What to Expect in
// Middle School", a St. Ignatius open house — the activity writer stored nothing
// for any of them, because none contains a sport. A confirmation UI built on
// that alone would look like it was learning and record nothing at all.
//
// So a member also carries confirmed senders: { domain, confidence }. This is
// deliberately NOT learnSenderAttribution, which derives the same shape by
// counting and is therefore always a guess. This one is only ever written by an
// explicit human answer, and outranks the counted version wherever they differ.

function normalizeSenders(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    const domain = String(s?.domain || '').toLowerCase().trim().replace(/^@/, '').split('@').pop();
    if (!domain || !domain.includes('.')) continue;
    if (out.some(x => x.domain === domain)) continue;
    out.push({ domain, confidence: s?.confidence === 'confirmed' ? 'confirmed' : 'inferred' });
  }
  return out;
}

// ── Circles ───────────────────────────────────────────────────────────────
//
// A "circle" is which group of people a member belongs to — the household, the
// friend group, the extended family, work. It is a grouping label on the member
// record, not a new store: attribution, colour and learning all continue to key
// on the member, so an event tagged to a member is automatically tagged to that
// member's circle.
//
// Every member predates this field, so the absence of a circle must read as the
// default rather than as an error — that is why normalizeCircle never returns
// empty and everything falls back to 'family'.
const CIRCLE_PRESETS = ['family', 'friends', 'extended', 'work', 'other'];
function normalizeCircle(raw) {
  const s = String(raw || '').toLowerCase().trim();
  return s || 'family';
}

// Resolve who an event is about, in evidence order.
//
// Activities first: they carry the tier discriminators, so they are the only
// thing that can tell a frosh mail from a varsity one. Confirmed senders next.
// An ambiguous verdict at either level is returned as-is and stops the search —
// the caller must not fall through to the counted guess, which is precisely the
// evidence we have just established is not good enough.
function resolveAttribution(members, text, senderEmail) {
  const act = attributeByActivity(members, text, senderEmail);
  if (act.ambiguous || act.memberId) return act;

  const domain = String(senderEmail || '').toLowerCase().split('@').pop() || null;
  if (!domain) return act;

  const hits = (members || []).filter(m =>
    (Array.isArray(m.senders) ? m.senders : [])
      .some(s => s.domain === domain && s.confidence === 'confirmed'));

  if (!hits.length) return act;

  // Two children at the same school is the ordinary case, not a contradiction:
  // the sender genuinely serves both. Criba cannot pick, and picking one would
  // be wrong half the time, so it says so instead.
  if (hits.length > 1) {
    return {
      memberId: null, reason: null, ambiguous: true,
      ambiguityReason: `${hits.map(m => m.name).join(' and ')} both get mail from ${domain}`,
    };
  }

  return {
    memberId: hits[0].id,
    reason: `you've filed mail from ${domain} as ${hits[0].name}`,
    ambiguous: false, ambiguityReason: null,
  };
}

// The user just told us whose event this is. Turn that into a durable fact so
// the next mail like it does not have to be asked about again.
//
// Only ever called from an explicit user action (approving or editing an event
// onto a member). Nothing derived from Criba's own guesses is written here —
// that is what would let a single bad guess confirm itself forever.
function recordActivityFromEvent(member, text, senderDomain) {
  const types = activityTypesIn(text);
  if (!types.size) return false;
  const domain = String(senderDomain || '').toLowerCase().split('@').pop() || null;
  const tiers = tiersMentionedIn(text);
  const tier = tiers.size === 1 ? [...tiers][0] : null;

  const list = Array.isArray(member.activities) ? member.activities : [];
  let changed = false;
  for (const type of types) {
    const existing = list.find(a => a.sport_or_type === type
      && (!a.sender_domain || !domain || a.sender_domain === domain)
      && (!a.team_tier || !tier || a.team_tier === tier));
    if (existing) {
      // Fill in blanks and harden a guess into a confirmed fact.
      if (!existing.sender_domain && domain) { existing.sender_domain = domain; changed = true; }
      if (!existing.team_tier && tier) { existing.team_tier = tier; changed = true; }
      if (existing.confidence !== 'confirmed') { existing.confidence = 'confirmed'; changed = true; }
    } else {
      list.push({ sport_or_type: type, org: null, team_tier: tier, sender_domain: domain, confidence: 'confirmed' });
      changed = true;
    }
  }
  if (changed) member.activities = list;
  return changed;
}

// The sender half of the same answer. Runs whether or not an activity was
// recognised, which is the whole point: most confirmations carry no sport word,
// and before this they wrote nothing at all.
function recordSenderFromEvent(member, senderEmail) {
  const domain = String(senderEmail || '').toLowerCase().split('@').pop() || null;
  // Uploads have no sender. Nothing to learn here; the activity path may still
  // have found something.
  if (!domain || !domain.includes('.')) return false;

  const list = Array.isArray(member.senders) ? member.senders : [];
  const existing = list.find(s => s.domain === domain);
  if (existing) {
    if (existing.confidence === 'confirmed') return false;
    existing.confidence = 'confirmed';
    member.senders = list;
    return true;
  }
  list.push({ domain, confidence: 'confirmed' });
  member.senders = list;
  return true;
}

// Called wherever the user assigns an event to a family member. Persists the
// activity fact that assignment implies, so the same question is not asked
// twice. Never throws into the caller: failing to learn is a worse outcome than
// failing to save the event, but only slightly, and the event must still save.
async function learnFromMemberAssignment(email, memberId, event) {
  if (!memberId || !event) return;
  try {
    const fam = getUserFamily(email);
    const member = await fam.get(memberId);
    if (!member) return;
    const text = [event.title, event.location, event.notes, event.subject].filter(Boolean).join(' ');
    // Both, and deliberately not short-circuited: an event can teach us the
    // activity, the sender, or both, and the activity writer silently declines
    // on anything without a sport in it — which is most school mail.
    const learnedActivity = recordActivityFromEvent(member, text, event.sender_email);
    const learnedSender = recordSenderFromEvent(member, event.sender_email);
    if (learnedActivity || learnedSender) await fam.set(memberId, member);
  } catch (err) {
    console.error('[learn] activity fact not recorded:', err.message);
  }
}

// Resolve event color by matching name strings (from Claude attendees) to family records
async function resolveEventColorByNames(email, nameStrings, text = '') {
  const members = await getUserFamily(email).values();
  const match = matchFamilyMember(members, nameStrings, text);
  return match?.eventColor || match?.color || null;
}

// Shared helper: build GCal resource and insert event. Returns calEventId string,
// or null when the event is already on the calendar and was therefore not written
// (in which case ev.duplicate_of is set to the event we found).
// Used by all auto-write paths (Gmail, backfill, group-approve, confirm-categories).
//
// The duplicate check lives here rather than in each caller because this is the
// single chokepoint every write passes through. Putting it in one caller — which
// is what we had — left the live Gmail path writing blind.
// Everything Claude extracted beyond a date has, until now, been stored in
// Redis and thrown away at the calendar boundary — every event got the string
// "Added via Criba" and nothing else. The attire rules, what to bring, the
// amount owed, who sent it: all of it existed and none of it reached the place
// the user actually looks. This builds the description every write path uses.
//
// Claude sometimes emits a literal backslash-n inside notes rather than a real
// newline; Google Calendar renders that as visible "\n" text, so unescape it.
function buildEventDescription(ev) {
  const parts = [];
  const notes = String(ev?.notes || '').replace(/\\r\\n|\\n/g, '\n').trim();
  if (notes) parts.push(notes);

  const recurringNote = ev?.recurring_note;
  if (recurringNote && (ev.recurrence_rule || ev.type === 'recurring')) {
    parts.push(`Repeats: ${recurringNote}`);
  }

  const from = ev?.sender_name || ev?.sender_email;
  const provenance = [];
  if (from) provenance.push(`From ${from}`);
  if (ev?.subject) provenance.push(`Re: ${ev.subject}`);
  if (provenance.length) parts.push(provenance.join('\n'));

  // A deep link back to the source email. This is the difference between a
  // calendar entry and a calendar manager: the answer to "wait, what did that
  // email say about parking?" is one click away instead of a Gmail search.
  if (ev?.gmail_message_id) {
    parts.push(`Original email: https://mail.google.com/mail/u/0/#all/${ev.gmail_message_id}`);
  }

  parts.push('Added via Criba');
  return parts.join('\n\n');
}

async function autoWriteToCalendar(calendarApi, targetCalId, ev, colorId, opts = {}) {
  if (!opts.skipDuplicateCheck) {
    const dup = await findExistingOnAnyCalendar(calendarApi, targetCalId, ev);
    if (dup) {
      ev.duplicate_of = dup;
      console.log(`[calendar-dedup] SKIP "${ev.title}" on ${ev.date} — already on "${dup.calendarName}" as "${dup.title}"`);
      return null;
    }
  }
  const span = resolveRecurringSpan(ev.recurrence_rule, ev.date, ev.end_date || '', ev.recurrence_end_date);
  const { start, end } = buildCalendarTimes(ev.date, ev.time || '', span.endDate, ev.end_time || '', opts.timezone);
  const description = buildEventDescription(ev);
  const resource = {
    summary: ev.title,
    location: ev.location || '',
    start, end, description,
    attendees: (ev.attendees || []).filter(a => a?.email).map(a => ({ email: a.email })),
  };
  if (ev.recurrence_rule) resource.recurrence = [ensureRecurrenceEnd(ev.recurrence_rule, ev.date, span.recurrenceEndDate)];
  if (colorId) resource.colorId = String(colorId);

  // Last look before writing, deliberately uncached and against the calendar we
  // are about to write to. The check above may have been answered from a
  // snapshot taken up to a minute ago — which is exactly how two overlapping
  // runs both concluded an event was absent and both added it. One extra read
  // per write is a cheap price for not putting a second copy on a real
  // calendar, and this is the only moment the answer is authoritative.
  if (!opts.skipDuplicateCheck) {
    const fresh = await eventsOnDate(calendarApi, targetCalId, ev.date, { fresh: true });
    const late = findCalendarDuplicate(fresh, ev.title, ev.date, ev.time || '');
    if (late) {
      ev.duplicate_of = { ...late, calendarId: targetCalId, calendarName: targetCalId };
      console.log(`[calendar-dedup] LATE-SKIP "${ev.title}" on ${ev.date} — appeared between the first check and the write`);
      return null;
    }
  }

  // Persistent write-guard — the most reliable defence against a second copy.
  // The calendar reads above can be stale (cached, or a lookup that failed and
  // returned "no duplicate"); this does not depend on them. Criba remembers every
  // (date, title) it has auto-written for this user in Redis and refuses to write
  // the same one twice, across runs and restarts. Keyed per user; the title is
  // normalised so trivial punctuation/spacing differences still collide.
  const guardEmail = opts.email || null;
  const guardKey = guardEmail ? `gcalWritten:${guardEmail}` : null;
  const guardSig = guardEmail ? `${ev.date || ''}|${String(ev.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}` : null;
  if (guardSig && !opts.skipDuplicateCheck) {
    try {
      if (await redis.sismember(guardKey, guardSig)) {
        ev.duplicate_of = ev.duplicate_of || { title: ev.title, date: ev.date, calendarId: targetCalId, calendarName: 'your calendar', via: 'write-guard' };
        console.log(`[calendar-dedup] GUARD-SKIP "${ev.title}" on ${ev.date} — Criba already auto-added this once`);
        return null;
      }
    } catch (gErr) { console.error('[calendar-dedup] write-guard read failed, writing anyway:', gErr.message); }
  }

  const result = await calendarApi.events.insert({ calendarId: targetCalId, sendUpdates: 'none', resource });
  // Record the signature only after a successful insert, so a failed write does
  // not permanently block a later retry of the same event.
  if (guardSig) {
    try {
      await redis.sadd(guardKey, guardSig);
      await redis.expire(guardKey, 400 * 24 * 60 * 60);
    } catch (gErr) { console.error('[calendar-dedup] write-guard record failed:', gErr.message); }
  }
  // Make this write visible to the next check in this process immediately.
  noteWrittenToCache(targetCalId, ev.date, {
    id: result.data.id,
    recurringEventId: null,
    title: ev.title,
    date: ev.date,
    time: ev.time || '',
    end_time: ev.end_time || '',
    is_all_day: !ev.time,
  });
  return result.data.id;
}

// Shared event-classification rules used by the iCal extraction prompt.
// PDF and Gmail now use the richer FULL_EXTRACTION_PROMPT below.
const EVENT_CLASSIFICATION_RULES = `Classify every event into exactly one "type" and follow its rules:
- "break": a multi-day break or vacation (Thanksgiving Break, Winter Break, Spring Break, or any other span of consecutive non-school days). Output ONE event for the whole break: "date" = first day, "end_date" = last day. Never output one event per day of a break.
- "holiday": a single-day public/federal holiday (Columbus Day, Veterans Day, MLK Day, Labor Day, etc). Output one all-day event on that date. Leave "time", "end_time" and "end_date" null.
- "timed": a school event with a specific time (Back to School Night, Open House, Picture Day with a time, concerts, games). Set "time" to the start time. Set "end_time" to the given end time, or exactly one hour after "time" if no end time is stated.
- "minimum_day": a minimum/early-dismissal day or a late-start day tied to one specific date. Set "time" if a dismissal/start time is given, otherwise leave it null (all-day).
- "recurring": a pattern that repeats on a schedule rather than fixed one-off dates (e.g. "every Tuesday is a late start day", "early dismissal every first Friday"). Output ONE event with "recurring_note" describing the pattern in plain English (e.g. "Every Tuesday"). Never expand this into one event per occurrence.
- "other": anything that doesn't fit the above — treat as a normal single event, all-day unless a specific time is stated.`;

const EVENT_JSON_SCHEMA = `{"categories":[{"name":"Category name","events":[{"title":"Event name","type":"holiday|break|timed|minimum_day|recurring|other","date":"YYYY-MM-DD","end_date":"YYYY-MM-DD or null (only for type=break)","time":"HH:MM or null (24hr)","end_time":"HH:MM or null (only for type=timed/minimum_day)","location":"string or null","recurring_note":"string or null (only for type=recurring)","notes":"string or null","source_type":"event|deadline|action_item|financial_reminder"}]}]}`;

// Full-detail extraction prompt used for PDF calendars and Gmail emails.
// Returns a flat JSON array (not grouped by category) so the caller can
// store source_type / notes / family member tags without losing information.
// NOTE: attendees here are family-member name strings (not {name,email} objects);
// the caller injects the sender as a proper {name,email} invite attendee separately.
const FULL_EXTRACTION_PROMPT = `You are a calendar extraction expert for busy people. Extract every single calendar-worthy item from this content — not just obvious events, but also deadlines, action items, financial reminders, and time-sensitive tasks.

Rules for extraction:

1. Extract everything time-bound. If something has a date, a deadline, or a time, extract it. This includes:
- Events (meetings, parties, ceremonies, games, practices)
- Deadlines ("submit by June 1", "due Monday", "sign up before May 14")
- Action items with dates ("return library books before last day", "register by June 1")
- Financial reminders ("$3,907 auto-charged June 3 — verify card is current")
- All-day events (minimum days, last day of school, all school events)
- Multi-day events (camps, breaks, vacations)

2. Get the full address. If a location is mentioned, extract the complete street address if available. "Episcopal Day School" is not enough — "Episcopal Day School, 16 Baldwin Avenue, San Mateo, CA 94401" is correct. If only a venue name is given, use that.

3. Tag family members. If the content mentions specific people (children's names, family members), tag which person each event belongs to. Use the names as found in the content.

4. Capture all details in notes. Everything that isn't a date/time/location but is relevant goes in the notes field:
- Attire requirements ("White dress, knee to ankle length, no spaghetti straps")
- What to bring ("return athletic uniforms", "bring library books")
- RSVP requirements ("RSVP via evite")
- Volunteer needs ("volunteers needed for setup and cleanup")
- Action required ("check lost and found before June 4")
- Seating ("seating assigned randomly — check mail for pew number")
- Any other important context a person would want to remember

5. Don't summarize — extract. If an event has multiple sub-events on the same day, extract each one separately. June 4 with three things happening at different times = three separate calendar events.

6. Smart interpretation:
- "Minimum day" → all-day event, note the early dismissal time in notes
- "No morning school" → note this explicitly
- "All day" → is_all_day: true
- Date ranges → start_date and end_date
- "Due by X" or "before X" → create a deadline event on that date
- Financial auto-charges → create a reminder event on the charge date with amount and action required in notes

7. Arrival and prep instructions are not durations. "Arrive 30 minutes early",
"call time 2:30", "doors open at 6", "check in one hour before" describe a
SEPARATE, SHORT event that ends when the main one starts — not an earlier start
time for the main event, and never a longer block that swallows it.
- "Practice 3:30-4:30, arrive 30 minutes early for jersey handout" → TWO events:
  "Jersey Handout" 15:00-15:30, and "Practice" 15:30-16:30.
- Never extend an event backwards past its stated start time. If the source
  states a start time, that is the start time.
- If the prep instruction names no distinct activity, do not create a second
  event — put it in the main event's notes instead.

8. Never miss an event because it seems minor. "Return library books" is on the calendar. "Submit grad photo" is on the calendar. "Verify card is current" is on the calendar. Busy people miss these exactly because they seem small.

9. Recurring events. If something repeats on a schedule ("every Tuesday at 4pm", "weekly practice", "meets every Monday and Wednesday"), output ONE event with:
- date = the first occurrence (YYYY-MM-DD)
- recurrence = the Google Calendar RRULE string (e.g. "RRULE:FREQ=WEEKLY;BYDAY=TU" for every Tuesday, "RRULE:FREQ=WEEKLY;BYDAY=MO,WE" for Monday+Wednesday, "RRULE:FREQ=DAILY" for daily)
- recurrence_end_date = the last date the series runs (YYYY-MM-DD), whenever the content says or implies one: "through December", "for the fall semester", "8-week session", "until the end of the school year", a session end date, or a term end. Use null ONLY if there is genuinely no indication of when it stops.
- Do NOT expand recurring events into individual occurrences.
- For non-recurring events, recurrence = null.

For each extracted item return a JSON object with:
- title (clear, specific — not generic)
- date (YYYY-MM-DD)
- end_date (YYYY-MM-DD, only if multi-day, else null)
- start_time (HH:MM 24hr format, null if all-day)
- end_time (HH:MM 24hr format, null if all-day or unknown — default 1 hour after start if timed)
- timezone (IANA name, e.g. "America/New_York", ONLY when the content explicitly states a timezone that the time is given in — "10pm ET", "3pm Eastern", "14:00 GMT". Report the time exactly as written along with the zone it was written in; do NOT convert it yourself. Use null when no timezone is stated, which is the normal case for local school and club events.)
- location (full address if available, venue name if not, null if none)
- is_all_day (boolean)
- attendees (array of family member name strings tagged to this event, empty array if none specified)
- notes (all relevant details — attire, what to bring, action required, financial amounts, RSVP info; null if nothing extra)
- source_type ("event", "deadline", "action_item", or "financial_reminder")
- recurrence (Google Calendar RRULE string if recurring, null if one-time)
- recurrence_end_date (YYYY-MM-DD last date the series runs, null if not stated or one-time)
- intent ("new_event" | "cancellation" | "reschedule") — classify the email's intent:
  * "new_event": the email announces or confirms a new event
  * "cancellation": the email cancels or calls off a previously scheduled event
  * "reschedule": the email changes the date/time of a previously scheduled event
- old_title (string | null) — for cancellation/reschedule: the title of the event being cancelled or changed, as stated in the email; null for new_event
- old_date (YYYY-MM-DD | null) — for cancellation/reschedule: the original date of the event being changed; null if not stated or new_event
- old_time (HH:MM 24hr | null) — for cancellation/reschedule: the original time of the event being changed; null if not stated or new_event
- audience ("you" | "open" | "third_party" | "opportunity" | "promotion") — see Rule 10. Default to "you" when unsure.

Rule 10: Whose event is this? A newsletter, digest or mailing list carries
other people's business alongside the reader's own. A neighbourhood digest
saying "I have two tickets to sell for a show tomorrow at 16:00" is a real
timed item — for the person selling them. It is not the reader's event and
must never land on the reader's calendar as though it were.

Still extract it. Do not skip it. Label it instead, with the "audience" field:
- "you" — the reader or their family is invited, expected, affected, or
  responsible. Anything addressed to them, their child, their class, their
  team, their household, or their subscription. This is the normal case.
- "open" — a genuine community happening the reader could choose to attend:
  a school field day, a town fair, a library event, a public meeting.
- "third_party" — belongs to a specific OTHER person and involves the reader
  only as a bystander reading about it. Classified ads and items for sale,
  someone else's appointment, garage sales, "my daughter's recital", a
  stranger's request for help at a stated time, another household's plans.
- "opportunity" — an opening or deadline the reader has NOT signed up for but
  which could genuinely matter to them if they chose to act. Submission
  windows and application deadlines from an industry newsletter, fellowship
  and grant deadlines, contests, webinars, early-bird pricing on a real event,
  class-action claim deadlines, "last chance to register".
- "promotion" — a business marketing a commercial offer. A discount code, a
  sale ending, free delivery, loyalty points expiring, "30% off back to
  school", a subscription renewal push. The "date" is a marketing deadline
  invented to create urgency, and nothing in the reader's life happens on it.
  Unlike the categories above, these are DISCARDED outright rather than shown
  for review — so use it only when the entire message is a commercial offer.
  If the email is from a school, employer, doctor, team or anyone the reader
  has a real relationship with, it is not a promotion, even if it mentions a
  price.

The test that separates "opportunity" from "you" is whether the reader has
already committed. Homework for their child, a form their team asked them to
fill in, an appointment they booked, their school's PE day — committed, so
"you". A film festival submission deadline in a newsletter they subscribe to
is an opportunity however real the date is: nothing happens to them if they
ignore it. When a deadline would only matter if the reader chose to take part,
and nothing in the content shows they already have, it is "opportunity".

When genuinely unsure between "you" and "third_party", choose "you". Holding
back one of the reader's own events is worse than showing one extra.

Rule 9: Cancellations and reschedules. If the email says "cancelled", "called off", "postponed", "rescheduled", "moved to", "new date", etc., set intent accordingly. For cancellations, title/date/time should reflect the event as it was (what is being cancelled). For reschedules, title/date/time should reflect the NEW event details, and old_title/old_date/old_time should reflect what it was before.

Return a JSON array only. No other text. If nothing calendar-worthy is found, return [].`;

// Applies defaults/safety-net rules server-side in case the model's
// output doesn't perfectly follow the schema (e.g. a timed event missing
// end_time, or a break missing end_date).
function normalizeExtractedEvent(ev) {
  const validTypes = ['break', 'holiday', 'timed', 'minimum_day', 'recurring', 'other'];
  const type = validTypes.includes(ev.type) ? ev.type : 'other';
  // A break or a public holiday is all-day by definition. When the model
  // attaches school hours to one anyway, honouring them turns "Christmas Break"
  // into a 9am-2:50pm appointment on a single day.
  const allDayType = type === 'break' || type === 'holiday';
  // The extraction prompt asks for "start_time". This read "time" only, so the
  // clock time was never found and every timed event from an upload was stored
  // with no time — which downstream means all-day. An invitation stating
  // "EVENT START TIME: 10:30 AM" landed on the calendar as an all-day banner.
  // The two names are a known wart, documented and handled in
  // shiftMidnightToMorning; the normalizer simply never got the same treatment.
  const rawStart = ev.start_time ?? ev.time ?? '';
  const time = allDayType ? '' : (rawStart || '');
  let endTime = allDayType ? '' : (ev.end_time || '');
  // The model was explicit that this is an all-day event. Believe it over any
  // stray clock time it also emitted.
  if (ev.is_all_day === true) { return normalizeExtractedEvent({ ...ev, is_all_day: false, start_time: '', time: '', end_time: '', type: 'holiday' }); }
  // FULL_EXTRACTION_PROMPT returns no "type" field at all, so everything from
  // an upload normalizes to "other" — and "other" used to have its end time
  // stripped and no fallback applied. A 10:30 start with a stated 12:00 finish
  // therefore lost its end. Anything with a clock time gets an end time.
  if (time && !endTime && type !== 'break' && type !== 'holiday') {
    const [h, m] = time.split(':').map(Number);
    const endHour = h + 1 > 23 ? 23 : h + 1;
    endTime = `${String(endHour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return {
    type,
    date: ev.date,
    // Multi-day spans are not exclusive to breaks — a four-day exam week is
    // one all-day span too. Keep an end date whenever there is no clock time.
    end_date: type === 'break' ? (ev.end_date || ev.date) : (!time && ev.end_date ? ev.end_date : ''),
    time,
    end_time: time ? endTime : '',
    location: ev.location || '',
    recurring_note: type === 'recurring' ? (ev.recurring_note || '') : '',
    notes: ev.notes || null,
    source_type: ev.source_type || null,
    // Anything the model did not label, or labelled with a value we do not
    // recognise, is treated as the user's own. An unknown value must never be
    // the reason an event is withheld.
    audience: ['you', 'open', 'third_party', 'opportunity', 'promotion'].includes(ev.audience) ? ev.audience : 'you',
    recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null,
  };
}

// ---------------------------------------------------------------------------
// Closures: applying an uploaded "we are shut on these dates" list to events
// that are already on the calendar.
//
// A closure list is not a set of events to add. Its effect depends entirely on
// what the user already has scheduled: the same RSM holiday table means five
// skipped Thursdays for a Thursday class and a different set for a Tuesday one.
// So the unit of work is "closure range ∩ existing series", which is pure
// logic and therefore testable without touching Google.
// ---------------------------------------------------------------------------

const RRULE_DAY_TO_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Every date a series lands on, between two bounds. Deliberately supports only
// the shapes extraction actually produces — weekly (optionally on named days)
// and daily. An unrecognised rule returns no dates, so a closure simply
// proposes nothing rather than guessing wrong about someone's calendar.
function expandSeriesDates(rule, startDate, rangeStart, rangeEnd, hardLimit = 400) {
  if (!rule || !/^\d{4}-\d{2}-\d{2}$/.test(startDate || '')) return [];
  const up = String(rule).toUpperCase();
  const freq = up.match(/FREQ=([A-Z]+)/)?.[1];
  if (freq !== 'WEEKLY' && freq !== 'DAILY') return [];

  const interval = parseInt(up.match(/INTERVAL=(\d+)/)?.[1] || '1', 10) || 1;
  const untilRaw = up.match(/UNTIL=(\d{8})/)?.[1];
  const until = untilRaw ? `${untilRaw.slice(0, 4)}-${untilRaw.slice(4, 6)}-${untilRaw.slice(6, 8)}` : null;
  const count = parseInt(up.match(/COUNT=(\d+)/)?.[1] || '0', 10) || 0;

  const byday = (up.match(/BYDAY=([A-Z,]+)/)?.[1] || '')
    .split(',').map(d => RRULE_DAY_TO_INDEX[d.trim()]).filter(d => d !== undefined);
  // "Weekly" with no BYDAY repeats on the start date's own weekday.
  const days = freq === 'WEEKLY'
    ? (byday.length ? byday : [new Date(startDate + 'T00:00:00Z').getUTCDay()])
    : null;

  const out = [];
  let emitted = 0;
  let cursor = startDate;
  const stop = until && until < rangeEnd ? until : rangeEnd;
  for (let guard = 0; guard < hardLimit && cursor <= stop; guard++) {
    const dow = new Date(cursor + 'T00:00:00Z').getUTCDay();
    const hits = freq === 'DAILY' ? true : days.includes(dow);
    if (hits) {
      emitted++;
      if (count && emitted > count) break;
      if (cursor >= rangeStart) out.push(cursor);
    }
    // INTERVAL on a weekly rule counts weeks, not days; stepping a day at a
    // time and filtering by weekday would silently ignore it.
    cursor = freq === 'WEEKLY' && interval > 1 && dow === 6
      ? addDaysToDateStr(cursor, 1 + 7 * (interval - 1))
      : addDaysToDateStr(cursor, 1);
  }
  return out;
}

// Which dates of which existing events fall inside the uploaded closures.
// Returns one proposal per affected event, never a bare list of dates, so the
// user approves "skip these 5 Thursdays of RSM Math" rather than "apply this
// holiday list" — a claim they can actually check.
function matchClosuresToEvents(closures, events) {
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const ranges = (closures || [])
    .map(c => ({
      label: String(c.title || c.label || 'Closure').trim(),
      from: c.start_date || c.date,
      to: c.end_date || c.start_date || c.date,
    }))
    .filter(c => isDate(c.from) && isDate(c.to) && c.to >= c.from);
  if (!ranges.length) return [];

  const rangeStart = ranges.reduce((m, r) => (r.from < m ? r.from : m), ranges[0].from);
  const rangeEnd = ranges.reduce((m, r) => (r.to > m ? r.to : m), ranges[0].to);
  const labelFor = date => ranges.find(r => date >= r.from && date <= r.to)?.label || null;

  const proposals = [];
  for (const ev of events) {
    if (!isDate(ev.date)) continue;
    const already = new Set(ev.skipped_dates || []);

    if (ev.recurrence_rule) {
      const hits = expandSeriesDates(ev.recurrence_rule, ev.date, rangeStart, rangeEnd)
        .filter(d => labelFor(d) && !already.has(d));
      if (hits.length) {
        proposals.push({
          eventId: ev.id, title: ev.title, isSeries: true,
          dates: hits.map(d => ({ date: d, reason: labelFor(d) })),
        });
      }
      continue;
    }

    // A one-off event inside a closure is affected too — a single class on a
    // day the school turns out to be shut.
    const label = labelFor(ev.date);
    if (label && !already.has(ev.date)) {
      proposals.push({
        eventId: ev.id, title: ev.title, isSeries: false,
        dates: [{ date: ev.date, reason: label }],
      });
    }
  }
  return proposals;
}

// The prompt says a break is ONE event spanning first day to last, but the
// model routinely ignores it and emits one event per day — "Christmas Break"
// arrived as 13 separate records. Collapse runs of the same title on
// consecutive dates back into a single event with an end_date.
//
// Only same-titled events are merged, and only when the dates are contiguous,
// so two genuinely separate occurrences of the same thing stay separate.
function collapseMultiDayRuns(events) {
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const key = ev => String(ev.title || '').trim().toLowerCase();
  // Only span-like entries are candidates. A timed event repeating on
  // consecutive days is a real series, not one long event.
  const mergeable = ev => (ev.type === 'break' || ev.type === 'holiday' || ev.type === 'other') && !ev.time && isDate(ev.date);

  // School calendars list only school days, so a break that runs across a
  // weekend arrives as Dec 21-25 and Dec 28-Jan 1 with a hole in between.
  // Treat a gap made up purely of Saturdays and Sundays as contiguous.
  const bridges = (from, to) => {
    let cursor = addDaysToDateStr(from, 1);
    for (let i = 0; i < 4 && cursor <= to; i++) {
      if (cursor === to) return true;
      const day = new Date(cursor + 'T00:00:00').getDay();
      if (day !== 0 && day !== 6) return false;
      cursor = addDaysToDateStr(cursor, 1);
    }
    return false;
  };

  const groups = new Map();
  const out = [];
  for (const ev of events) {
    if (!mergeable(ev)) { out.push(ev); continue; }
    if (!groups.has(key(ev))) groups.set(key(ev), []);
    groups.get(key(ev)).push(ev);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.date.localeCompare(b.date));
    let run = null;
    const flush = () => { if (run) out.push(run.ev); run = null; };
    for (const ev of group) {
      const last = run ? (run.ev.end_date || run.lastDate) : null;
      if (run && (ev.date === last || bridges(last, ev.date))) {
        run.lastDate = ev.date;
        run.ev.end_date = ev.date;
        continue;
      }
      flush();
      run = { ev: { ...ev, end_date: ev.end_date || ev.date }, lastDate: ev.end_date || ev.date };
    }
    flush();
  }
  return out;
}

function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Builds Google Calendar start/end objects, honoring an explicit end date
// (multi-day all-day events, e.g. a school break) and/or end time (timed
// events). Falls back to the original single-day / start+1hr behavior
// when no end date/time is supplied, so existing callers keep working.
// Deadlines and action items usually arrive with no clock time, and the model
// fills that in as "00:00". Written literally that puts a reminder at midnight,
// where it sits at the very top of the day and is easy to sleep through — and
// on some views reads as belonging to the night before. 6am is the start of a
// realistic day, so a reminder is the first thing seen rather than the last.
//
// Tradeoff: an event genuinely at midnight (a New Year countdown) also moves to
// 6am. Rare enough, and correctable in the editor, to be worth it.
const MIDNIGHT_REMINDER_TIME = '06:00';

// Gmail extraction emits start_time; the PDF/iCal path emits time. Normalize
// whichever is present so the stored record matches what lands on the calendar.
function shiftMidnightToMorning(ev) {
  for (const key of ['start_time', 'time']) {
    if (ev[key] === '00:00' || ev[key] === '0:00') ev[key] = MIDNIGHT_REMINDER_TIME;
  }
  return ev;
}

// Every user used to be assumed to live in Pacific time. For anyone else that
// is not a cosmetic problem: a 4pm practice is written to their calendar at the
// wrong hour, and an emailed "10pm ET" is converted into the wrong zone twice.
//
// The zone now comes from the user's own browser, captured at sign-in and
// stored per account. This deliberately avoids reading it from the Google
// Calendar API: that would need another OAuth scope, and adding a scope forces
// every existing user back through the consent screen.
//
// DEFAULT_TZ is only the fallback for an account we have not heard from yet.
const DEFAULT_TZ = 'America/Los_Angeles';
const LOCAL_TZ = DEFAULT_TZ;

// An unknown zone name throws inside Intl and would take the whole write down,
// so anything we store is validated first.
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function getUserTimezone(email) {
  if (!email) return DEFAULT_TZ;
  try {
    const tz = await redis.get(`userTz:${email}`);
    return isValidTimezone(tz) ? tz : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

// What UTC instant is "2026-08-18 22:00" in the given timezone?
//
// Intl can format an instant into a zone but not parse a wall-clock time out of
// one, so: treat the wall clock as if it were UTC, see how that instant renders
// in the target zone, and subtract the difference. Handles DST correctly because
// the offset is measured at the actual date rather than assumed.
function zonedWallClockToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(naive)).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const asSeen = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return naive - (asSeen - naive);
}

// Rewrite a date/time stated in another timezone into local wall-clock time.
// A 10pm Eastern webinar has to land at 7pm on a Pacific calendar; storing 22:00
// and labelling it Pacific — which is what we did — is simply the wrong time.
function convertToLocalTime(date, time, fromTz, localTz = DEFAULT_TZ) {
  if (!date || !time || !fromTz || fromTz === localTz) return { date, time };
  try {
    const instant = new Date(zonedWallClockToUtc(date, time, fromTz));
    if (isNaN(instant)) return { date, time };
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: localTz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(instant).reduce((acc, x) => (acc[x.type] = x.value, acc), {});
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(+p.hour % 24).padStart(2, '0')}:${p.minute}` };
  } catch {
    // An unrecognised timezone name must not lose the event.
    return { date, time };
  }
}

// Applies the conversion across whichever field names the caller uses (Gmail
// extraction emits start_time, the PDF path emits time) and returns a note
// describing what changed, or null if nothing did.
function normalizeEventTimezone(ev, localTz = DEFAULT_TZ) {
  const tz = ev.timezone || ev.time_zone || null;
  if (!tz || tz === localTz || !ev.date) return null;
  const startKey = ev.start_time !== undefined && ev.start_time !== null ? 'start_time' : 'time';
  const startVal = ev[startKey];
  if (!startVal) return null;
  const start = convertToLocalTime(ev.date, startVal, tz, localTz);
  if (start.time === startVal && start.date === ev.date) return null;
  if (ev.end_time) {
    const end = convertToLocalTime(ev.end_date || ev.date, ev.end_time, tz, localTz);
    ev.end_time = end.time;
    if (ev.end_date) ev.end_date = end.date;
  }
  ev[startKey] = start.time;
  ev.date = start.date;
  return `Stated as ${startVal} ${tz.split('/').pop().replace(/_/g, ' ')} time.`;
}

function buildCalendarTimes(date, time, endDate, endTime, localTz = DEFAULT_TZ) {
  const tz = isValidTimezone(localTz) ? localTz : DEFAULT_TZ;
  if (time === '00:00' || time === '0:00') time = MIDNIGHT_REMINDER_TIME;
  if (time && time.trim() !== '') {
    const start = { dateTime: `${date}T${time}:00`, timeZone: tz };
    let finalEndTime = endTime && endTime.trim() !== '' ? endTime : null;
    if (!finalEndTime) {
      const [h, m] = time.split(':').map(Number);
      const endHour = h + 1 > 23 ? 23 : h + 1;
      finalEndTime = `${String(endHour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    const finalEndDate = endDate && endDate.trim() !== '' ? endDate : date;
    const end = { dateTime: `${finalEndDate}T${finalEndTime}:00`, timeZone: tz };
    return { start, end };
  }
  if (endDate && endDate.trim() !== '' && endDate !== date) {
    // Multi-day all-day event (e.g. a school break). Google Calendar's
    // end.date for all-day events is EXCLUSIVE, so the last inclusive day
    // needs +1.
    return { start: { date }, end: { date: addDaysToDateStr(endDate, 1) } };
  }
  return { start: { date }, end: { date } };
}

// A repeating event whose end_date lands on a later day is saying two different
// things at once: how long one occurrence runs, and when the whole series stops.
// Google only hears the first. So "HIVE Summer Camp, 8:15am-3:30pm, weekdays
// Aug 20-24" became a single five-day block that then repeated — every copy
// running five days from its own start, smearing camp across the following week.
//
// The span nearly always describes the series, so move it to recurrence_end_date
// and clamp the occurrence back to its own day. When both are present the later
// date wins: a span lifted from the text is better evidence than a
// recurrence_end_date the extractor guessed, and erring long leaves spare
// occurrences to delete rather than missing ones nobody notices.
function resolveRecurringSpan(recurrenceRule, date, endDate, recurrenceEndDate) {
  const span = String(endDate || '').trim();
  const current = String(recurrenceEndDate || '').trim();
  // Not recurring, no span, or a span ending on the start day: nothing to
  // reinterpret. Multi-day one-off events (school breaks) fall through here
  // untouched — their end_date genuinely is the occurrence length.
  if (!recurrenceRule || !span || !date || span <= date) {
    return { endDate: span, recurrenceEndDate: current || null };
  }
  return { endDate: '', recurrenceEndDate: current && current > span ? current : span };
}

function signData(data) {
  const str = JSON.stringify(data);
  const encoded = Buffer.from(str).toString('base64');
  const sig = crypto.createHmac('sha256', SECRET).update(encoded).digest('hex');
  return `${encoded}.${sig}`;
}

function verifyData(token) {
  if (!token) return null;
  try {
    const [encoded, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SECRET).update(encoded).digest('hex');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(encoded, 'base64').toString());
  } catch { return null; }
}

function setUserCookie(res, user) {
  const token = signData({ id: user.id, email: user.email, name: user.name, access_token: user.access_token, refresh_token: user.refresh_token });
  res.cookie('criba_user', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', secure: false });
}

function getUser(req) {
  return verifyData(req.cookies?.criba_user);
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

function getOAuthClient(user) {
  const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  client.setCredentials({ access_token: user.access_token, refresh_token: user.refresh_token });
  return client;
}

// Prefer the refresh token we persisted at first consent over the one in the
// session. Google only returns a refresh token on the FIRST authorization, so
// every later login stores '' in the JWT — meaning the session client cannot
// renew itself and every Google call fails once the access token expires an
// hour after login. Redis has held the working token the whole time.
async function getUserOAuthClient(user) {
  const stored = await redis.get(`refreshToken:${user.email}`);
  if (stored) {
    const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    client.setCredentials({ refresh_token: stored, access_token: user.access_token || undefined });
    return client;
  }
  return getOAuthClient(user);
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Which callback URL to hand Google for this request.
//
// Production is unchanged: when the request arrives on the same host as the
// configured GOOGLE_REDIRECT_URI, that exact URI is used. For any OTHER host —
// a Vercel preview/staging alias, or a fresh local domain — the callback is
// derived from the request's own host, so sign-in completes on whatever domain
// is actually serving the app instead of bouncing to production.
//
// This cannot be abused to steal tokens: Google only issues a code to a
// redirect_uri that is registered on the OAuth client, so a spoofed Host header
// just produces a URI Google refuses. The one operational requirement is that
// each host you sign in on (production, and the stable staging alias) has its
// /api/auth/google/callback registered on the OAuth client.
function redirectUriFor(req) {
  const envUri = process.env.GOOGLE_REDIRECT_URI || '';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (!host) return envUri;
  if (envUri) {
    try { if (new URL(envUri).host === host) return envUri; } catch {}
  }
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  return `${proto}://${host}/api/auth/google/callback`;
}

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  // Read-only list of which calendars the user subscribes to. calendar.events
  // alone cannot call calendarList.list, and without it duplicate detection is
  // blind to anything living on a second calendar — which is exactly where
  // subscribed club/school feeds put their copy of an event we also wrote.
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

function requireAuth2(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

app.get('/api/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent', redirect_uri: redirectUriFor(req) });
  res.redirect(url);
});

// Sign-in setup helper. Renders a plain-English page with the one URL to copy
// and where to paste it, so enabling sign-in on a new deployment needs no
// technical knowledge. Add ?format=json for the raw values. No secrets — the
// client_id is public and only its head is shown.
app.get('/api/auth/debug', (req, res) => {
  const redirectUri = redirectUriFor(req);
  const clientHead = (process.env.GOOGLE_CLIENT_ID || '').slice(0, 24) || 'unknown';
  if (req.query.format === 'json') {
    return res.json({
      redirect_uri_to_register: redirectUri,
      host_seen: req.headers['x-forwarded-host'] || req.headers.host || null,
      proto_seen: req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http'),
      configured_GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || null,
      client_id_head: clientHead,
    });
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.set('Content-Type', 'text/html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Criba — enable sign-in here</title></head>
<body style="margin:0;background:#F0DAD8;color:#111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.55">
<div style="max-width:620px;margin:0 auto;padding:32px 20px 64px">
  <div style="font-weight:800;font-size:22px;letter-spacing:.04em;text-transform:uppercase">CRIBA</div>
  <h1 style="font-size:24px;margin:18px 0 6px">Enable sign-in for this site</h1>
  <p style="color:#555;margin:0 0 24px">This is a staging copy of Criba. To let people sign in here, do these two quick steps in Google — about a minute. Nothing here is sensitive.</p>

  <div style="background:#fff;border:1.5px solid #111;padding:18px;margin-bottom:16px">
    <div style="font-weight:700;margin-bottom:8px">Step 1 · Add this web address to Google</div>
    <p style="margin:0 0 10px;color:#555">Copy the address below, then open the Google settings link and paste it under <b>“Authorized redirect URIs”</b> on the client named <b>Criba</b> (the one ending <code>${esc(clientHead)}…</code>).</p>
    <div style="display:flex;gap:8px;align-items:stretch;flex-wrap:wrap">
      <input id="u" readonly value="${esc(redirectUri)}" style="flex:1;min-width:220px;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:10px;border:1.5px solid #111;background:#F0DAD8;color:#111">
      <button onclick="navigator.clipboard.writeText(document.getElementById('u').value).then(()=>{this.textContent='Copied ✓'})" style="border:1.5px solid #111;background:#111;color:#F0DAD8;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;text-transform:uppercase;letter-spacing:.04em">Copy</button>
    </div>
    <p style="margin:12px 0 0"><a href="https://console.cloud.google.com/apis/credentials?project=criba-496102" target="_blank" rel="noopener" style="color:#1a73e8;font-weight:600">Open Google credentials settings →</a></p>
  </div>

  <div style="background:#fff;border:1.5px solid #111;padding:18px;margin-bottom:16px">
    <div style="font-weight:700;margin-bottom:8px">Step 2 · Allow the person to sign in</div>
    <p style="margin:0;color:#555">On the <a href="https://console.cloud.google.com/apis/credentials/consent?project=criba-496102" target="_blank" rel="noopener" style="color:#1a73e8;font-weight:600">OAuth consent screen</a>, add their Google address under <b>Test users</b>. Save.</p>
  </div>

  <p style="color:#555;font-size:13px">Done both? Go back to the app and click <b>Continue with Google</b>. Google can take a minute to catch up — if it still blocks, wait 2 minutes and retry.</p>
</div>
</body></html>`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    // Must be the SAME redirect_uri that /api/auth/google sent Google, or the
    // token exchange fails — redirectUriFor derives both from the request host.
    const { tokens } = await oauth2Client.getToken({ code, redirect_uri: redirectUriFor(req) });
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    const user = { id: randomUUID(), email: data.email, name: data.name, access_token: tokens.access_token, refresh_token: tokens.refresh_token || '' };
    setUserCookie(res, user);

    // Persist refresh token in Redis so the webhook can make Gmail API calls
    // without the user being logged in. tokens.refresh_token is only returned
    // on the first consent or when prompt=consent is forced (which we always do).
    if (tokens.refresh_token) {
      await redis.set(`refreshToken:${data.email}`, tokens.refresh_token);
      // Register Gmail push notifications (fire-and-forget — don't block login)
      registerGmailWatch(data.email, tokens.refresh_token).catch(e =>
        console.error('Gmail watch registration failed:', e.message)
      );
    }

    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/me', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: user.id, email: user.email, name: user.name });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('criba_user');
  res.json({ ok: true });
});

app.get('/api/contacts/search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    const auth = await getUserOAuthClient(req.user);
    const people = google.people({ version: 'v1', auth });
    // Collected rather than swallowed. Every branch below used to fall back to
    // an empty result list, which made "your token has no contacts scope" and
    // "nobody matched" indistinguishable — the dropdown simply never appeared
    // and the feature looked broken with nothing to go on.
    const apiErrors = [];

    // The People API's searchContacts/otherContacts.search endpoints both use
    // a lazy, per-account cache: the first search after login (or after the
    // cache expires) silently returns zero results until a "warmup" request
    // with an empty query has synced it. See:
    // https://developers.google.com/people/api/rest/v1/people/searchContacts
    // https://developers.google.com/people/api/rest/v1/otherContacts/search
    // https://github.com/googleapis/google-api-nodejs-client/issues/3277
    // We warm each at most once every 10 minutes per user (tracked in Redis)
    // so normal keystroke-by-keystroke searches don't pay for it every time.
    const warmKey = `contacts_warm:${req.user.email}`;
    const alreadyWarm = await redis.get(warmKey);
    if (!alreadyWarm) {
      try {
        const warmup = await people.people.searchContacts({ query: '', readMask: 'names,emailAddresses', pageSize: 1 });
        console.log('Contacts (My Contacts) warmup response:', JSON.stringify(warmup.data));
      } catch (warmErr) {
        console.error('Contacts (My Contacts) warmup error:', JSON.stringify(warmErr.response?.data || warmErr.message));
      }
      try {
        const otherWarmup = await people.otherContacts.search({ query: '', readMask: 'names,emailAddresses', pageSize: 1 });
        console.log('Contacts (Other Contacts) warmup response:', JSON.stringify(otherWarmup.data));
      } catch (warmErr) {
        console.error('Contacts (Other Contacts) warmup error:', JSON.stringify(warmErr.response?.data || warmErr.message));
      }
      await redis.set(warmKey, '1', 'EX', 600);
    }

    // "My Contacts" — people explicitly saved in the user's Google Contacts.
    const myContactsPromise = people.people.searchContacts({
      query: q,
      readMask: 'names,emailAddresses',
      pageSize: 10,
    }).catch(err => {
      console.error('Contacts (My Contacts) search error:', JSON.stringify(err.response?.data || {}), err.message);
      apiErrors.push({ source: 'myContacts', code: err?.code || err?.response?.status, message: err.message });
      return { data: { results: [] } };
    });

    // "Other contacts" — people auto-collected from Gmail correspondence
    // that the user never explicitly saved. This is what makes Gmail/Google
    // Calendar's guest-autocomplete feel complete, and requires the
    // separate contacts.other.readonly scope.
    const otherContactsPromise = people.otherContacts.search({
      query: q,
      readMask: 'names,emailAddresses',
      pageSize: 10,
    }).catch(err => {
      console.error('Contacts (Other Contacts) search error:', JSON.stringify(err.response?.data || {}), err.message);
      apiErrors.push({ source: 'otherContacts', code: err?.code || err?.response?.status, message: err.message });
      return { data: { results: [] } };
    });

    // Google Workspace / G Suite domain directory — surfaces co-workers and
    // org members that aren't in the user's personal contacts. Returns an
    // empty list (not an error) for personal @gmail.com accounts, so it's
    // safe to call unconditionally. Requires directory.readonly scope.
    const directoryPromise = people.people.searchDirectoryPeople({
      query: q,
      readMask: 'names,emailAddresses',
      pageSize: 10,
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
    }).catch(err => {
      console.error('Contacts (Directory) search error:', JSON.stringify(err.response?.data || {}), err.message);
      apiErrors.push({ source: 'directory', code: err?.code || err?.response?.status, message: err.message });
      return { data: { people: [] } };
    });

    const [myContactsRes, otherContactsRes, directoryRes] = await Promise.all([myContactsPromise, otherContactsPromise, directoryPromise]);
    console.log(`Contacts search "${q}" My Contacts raw response:`, JSON.stringify(myContactsRes.data));
    console.log(`Contacts search "${q}" Other Contacts raw response:`, JSON.stringify(otherContactsRes.data));
    console.log(`Contacts search "${q}" Directory raw response:`, JSON.stringify(directoryRes.data));

    // searchContacts / otherContacts.search return { results: [{ person }] }
    // searchDirectoryPeople returns { people: [Person] } (no wrapper object)
    const toContact = r => ({
      name: r.person?.names?.[0]?.displayName || '',
      email: r.person?.emailAddresses?.[0]?.value || '',
    });
    const toDirContact = p => ({
      name: p.names?.[0]?.displayName || '',
      email: p.emailAddresses?.[0]?.value || '',
    });
    // Saved people first, and matched locally. These are the two or three
    // addresses that actually get used — a partner, a nanny — and making them
    // depend on a Google API call that needs three extra scopes and a warmup
    // cache is why "add guests" could stop working at all. This part cannot
    // fail.
    const ql = String(q).toLowerCase();
    const savedMatches = (await getSavedRecipients(req.user.email)).filter(r =>
      String(r.name || '').toLowerCase().includes(ql) || String(r.email || '').toLowerCase().includes(ql));

    const all = [
      ...savedMatches.map(r => ({ name: r.name || r.email, email: r.email })),
      ...(myContactsRes.data.results || []).map(toContact),
      ...(otherContactsRes.data.results || []).map(toContact),
      ...(directoryRes.data.people || []).map(toDirContact),
    ].filter(c => c.email);

    const seen = new Set();
    const contacts = [];
    for (const c of all) {
      const key = c.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      contacts.push(c);
    }
    // Tell the frontend the difference between "nobody matched" and "Google
    // wouldn't answer". Only the two personal-contact sources count: the
    // directory call 403s routinely on personal @gmail.com accounts and that
    // is normal, not a failure worth showing anyone.
    const authFailed = apiErrors.some(e =>
      e.source !== 'directory' && (e.code === 401 || e.code === 403));
    if (!contacts.length && authFailed) res.set('X-Contacts-Api-Error', '1');
    res.json(contacts);
  } catch (err) {
    console.error('Contacts error:', JSON.stringify(err.response?.data || {}), err.message, err.stack);
    res.set('X-Contacts-Api-Error', '1');
    res.json([]);
  }
});
app.get('/api/events/pending', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const nowTs = Date.now();
  const isPast = (ev) => {
    if (!ev.date) return true;
    const cutoff = ev.time
      ? new Date(`${ev.date}T${ev.time}:00`).getTime()
      : new Date(`${ev.date}T23:59:59`).getTime();
    return cutoff < nowTs;
  };
  const all = await events.values();

  // Bug #6: an iCal or PDF import is stored as 'draft' until its calendar write
  // succeeds, and 'draft' appeared in no feed's status filter — so a write that
  // failed left the event invisible everywhere, with no way to approve it, edit
  // it or throw it away. Drafts belonging to a calendar the user has since
  // deleted are deliberately left out: those are dead records (bug #7), and on
  // this account they are 79 of the 81, which would bury the queue rather than
  // fix anything. Deleting a calendar still needs to clean up its events.
  const liveCalIds = new Set((await getUserCalendars(req.user.email).entries()).map(([id]) => id));

  const pending = all.filter(e => {
    // A change notice ages out like anything else. These used to be exempt, so
    // a cancellation for a date three days gone sat in the queue permanently
    // and could only be cleared by hand — the queue filled with notices about
    // events that had already happened. Judge it on the date it concerns:
    // the original date for a cancellation, the new one for a reschedule.
    if (e.status === 'pending_cancellation' || e.status === 'pending_reschedule') {
      const when = e.status === 'pending_cancellation'
        ? { date: e.old_date || e.date, time: e.old_time || e.time }
        : { date: e.date || e.old_date, time: e.time || e.old_time };
      // isPast treats a missing date as past. That is right for an event, but
      // here it would silently swallow a notice we could not date — better to
      // show it and let the user judge than to hide it.
      if (!when.date) return true;
      return !isPast(when);
    }
    // Post-write review: 'added' events not yet reviewed and not yet past
    if ((e.status === 'added' || e.status === 'pending') && !e.reviewed && !isPast(e)) return true;
    // Never written to the calendar, and until now unreachable from anywhere.
    // It renders with the same "Not added yet" card as a pending event: Add,
    // Edit or Discard.
    if (e.status === 'draft' && !e.reviewed && !isPast(e) && liveCalIds.has(e.calendar_id)) return true;
    // Found on the calendar already and deliberately not written. Shown so the
    // user can see Criba noticed it rather than silently dropping it.
    if (e.status === 'duplicate' && !e.reviewed && !isPast(e)) return true;
    return false;
  }).sort((a, b) => (a.date || '') > (b.date || '') ? 1 : -1);

  // Tag each event with the family member it appears to belong to, so the review
  // card can show which colour it is heading for before anything is written.
  // Resolved on read rather than stored at extraction time: members and their
  // colours change, and a guess frozen weeks ago would be shown as fact.
  const members = await getUserFamily(req.user.email).values();
  if (members.length) {
    const learned = learnSenderAttribution(all);
    for (const ev of pending) {
      const text = [ev.title, ev.location, ev.notes, ev.subject].filter(Boolean).join(' ');
      const names = Array.isArray(ev.attendees) ? ev.attendees.map(a => a?.name || a?.email || '') : [];
      let match = matchFamilyMember(members, names, text);
      let reason = match ? 'named' : null;

      // A name written in the event still wins — it is the strongest evidence
      // there is. Below that, recorded activities are consulted before sender
      // history, because they carry the discriminators sender history lacks.
      // member_id is only ever written by an explicit user choice, so an event
      // that has one has already been answered. Asking again would make the
      // queue feel like it forgets what you told it.
      if (!match && !ev.member_id) {
        const act = resolveAttribution(members, text, ev.sender_email);
        if (act.ambiguous) {
          // Deliberately no suggested_member_id and no suggested_color. The card
          // renders in the calendar default with the reason shown, so the user
          // sees a question rather than a confident wrong answer.
          ev.attribution_ambiguous = true;
          ev.ambiguity_reason = act.ambiguityReason;
          continue;
        }
        if (act.memberId) {
          const m = members.find(x => x.id === act.memberId);
          if (m) { match = m; reason = act.reason; }
        }
      }

      // Nobody named. Fall back to what this sender has meant every other time.
      if (!match && ev.sender_email) {
        const domain = String(ev.sender_email).toLowerCase().split('@')[1];
        const hit = domain ? learned.get(domain) : null;
        // The member can have been deleted since those events were attributed.
        const m = hit && members.find(x => x.id === hit.memberId);
        if (m) {
          match = m;
          reason = `every other ${domain} event you've filed went to ${m.name}`;
        }
      }

      if (match) {
        ev.suggested_member_id = match.id;
        ev.suggested_color = match.eventColor || match.color || null;
        // The member carries a circle, so tagging the event to the member tags
        // it to the circle too — no separate resolution step. Falls back to the
        // default for members that predate the circle field.
        ev.suggested_circle = normalizeCircle(match.circle);
        // Shown on the card. A colour that appears with no stated reason is the
        // kind of thing that makes people distrust the whole queue.
        ev.suggested_reason = reason;
      }
    }
  }
  res.json(pending);
});

app.get('/api/events/recent', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const CALENDAR_STATUSES = new Set(['added', 'reviewed', 'approved', 'cancelled']);
  const all = (await events.values())
    .filter(e => CALENDAR_STATUSES.has(e.status))
    .sort((a, b) => {
      const ta = b.approved_at || b.created_at || '';
      const tb = a.approved_at || a.created_at || '';
      return ta > tb ? 1 : -1;
    })
    .slice(0, 100);
  res.json(all);
});

app.post('/api/events/approve', requireAuth, async (req, res) => {
  const { id, title, date, time, endDate, endTime, location, attendees } = req.body;
  const events = getUserEvents(req.user.email);
  const event = await events.get(id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = await getUserOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    if (!date) return res.status(400).json({ error: 'Date is required' });

    // Resolve the target Google Calendar (test mode overrides all member routing)
    const { targetMemberId } = req.body;
    const cals = getUserCalendars(req.user.email);
    const calSrc = event.calendar_id ? await cals.get(event.calendar_id) : null;
    const targetCalId = await resolveTargetCalendar(req.user.email);
    const colorId = await resolveEventColor(req.user.email, targetMemberId, calSrc);

    // A field the client sent must win even when blank — that is how the user
    // clears an end time or a location. /api/events/update learned this months
    // ago; this endpoint kept the `||` fallbacks, so the same edit made on the
    // review screen instead of the edit screen silently reverted.
    const has = k => Object.prototype.hasOwnProperty.call(req.body, k);
    const finalEndDate = has('endDate') ? (endDate || '') : (event.end_date || '');
    const finalEndTime = has('endTime') ? (endTime || '') : (event.end_time || '');
    const finalLocation = has('location') ? (location || '') : (event.location || '');
    const userTz = await getUserTimezone(req.user.email);

    // Use the RRULE from body if the user kept it, or fall back to the stored rule.
    // The frontend sends recurrenceRule: null to remove recurrence before adding.
    // Resolved here rather than further down because the span fix below needs it.
    const recurrenceRule = has('recurrenceRule') ? req.body.recurrenceRule : event.recurrence_rule;

    const span = resolveRecurringSpan(recurrenceRule, date, finalEndDate, req.body.recurrenceEndDate || event.recurrence_end_date);
    const { start, end } = buildCalendarTimes(date, time, span.endDate, finalEndTime, userTz);
    const eventAttendees = [];
    // Recipients ticked on the review card. Only addresses the user has already
    // saved are honoured — the request body is not a place to accept an
    // arbitrary invitee list, since these turn into real emails to real people.
    if (Array.isArray(req.body.recipientEmails) && req.body.recipientEmails.length) {
      const saved = new Set((await getSavedRecipients(req.user.email)).map(r => r.email));
      for (const raw of req.body.recipientEmails) {
        const addr = String(raw || '').trim().toLowerCase();
        if (saved.has(addr) && !eventAttendees.some(a => a.email === addr)) {
          eventAttendees.push({ email: addr });
        }
      }
    }
    if (attendees && Array.isArray(attendees)) {
      // Deduped against the ticked recipients above — a saved recipient who is
      // also in the guest list was being added to the invite twice.
      attendees.forEach(a => {
        const addr = String(a?.email || '').trim().toLowerCase();
        if (addr && !eventAttendees.some(x => x.email.toLowerCase() === addr)) {
          eventAttendees.push({ email: a.email });
        }
      });
    }
    const description = buildEventDescription(event);

    const calEventResource = { summary: title || event.title, location: finalLocation, start, end, attendees: eventAttendees, description };
    if (recurrenceRule) calEventResource.recurrence = [ensureRecurrenceEnd(recurrenceRule, date, span.recurrenceEndDate)];
    // "" is Google's documented way to clear a colour back to the calendar
    // default, which is what "No colour" has to mean. Only sent when the client
    // actually chose, so callers that omit the field leave the colour alone.
    if (has('targetMemberId')) calEventResource.colorId = colorId ? String(colorId) : '';
    else if (colorId) calEventResource.colorId = String(colorId);

    // Approving an event that is already on the calendar must update that event,
    // not add a second one. This path inserts directly rather than going through
    // autoWriteToCalendar, so it had neither the already-written guard nor the
    // duplicate check — a second click, or an edit-then-approve, produced a
    // visible duplicate.
    let calEvent;
    if (event.calEventId) {
      try {
        calEvent = await calendar.events.patch({
          calendarId: event.gcalId || targetCalId,
          eventId: event.calEventId,
          sendUpdates: 'all',
          resource: calEventResource,
        });
      } catch (err) {
        // The user deleted it from Google Calendar by hand. Our stored id is
        // stale, so approving should put it back rather than fail.
        if (err.code !== 404 && err.code !== 410) throw err;
        event.calEventId = null;
        calEvent = await calendar.events.insert({
          calendarId: targetCalId, sendUpdates: 'all', resource: calEventResource,
        });
      }
    } else {
      // Look the event up by what is ON the calendar, not by what the user is
      // changing it to. Searching with the edited title/date/time could never
      // match — the matcher requires the stored date and a loose title match —
      // so any edit fell through to insert and put a SECOND copy on the
      // calendar. Renaming an event is not the same as creating one.
      const dup = await findExistingOnAnyCalendar(calendar, targetCalId, {
        title: event.title || calEventResource.summary,
        date: event.date || date,
        time: event.time || '',
      });
      if (dup?.id) {
        event.gcalId = dup.calendarId || targetCalId;
        if (dup.recurringEventId) {
          // events.list(singleEvents:true) hands back one expanded occurrence,
          // but recurringEventId is the series itself. Patching THAT applies
          // every field to every occurrence, which is what the edit card
          // promises. This used to adopt the id and change nothing, so an edit
          // to a recurring event — an end date, a title, a location — was
          // accepted, reported as saved, and silently thrown away.
          //
          // The start/end of a series is the FIRST occurrence, not the one that
          // happened to match. Sending this occurrence's date would drag the
          // whole series forward, so date/time are only sent when the user
          // actually changed them.
          const seriesResource = { ...calEventResource };
          const dateUnchanged = !!event.date && event.date === date;
          const timeUnchanged = (event.time || '') === (time || '');
          if (dateUnchanged && timeUnchanged) {
            delete seriesResource.start;
            delete seriesResource.end;
          }
          calEvent = await calendar.events.patch({
            calendarId: event.gcalId,
            eventId: dup.recurringEventId,
            sendUpdates: 'all',
            resource: seriesResource,
          });
        } else {
          calEvent = await calendar.events.patch({
            calendarId: event.gcalId,
            eventId: dup.id,
            sendUpdates: 'all',
            resource: calEventResource,
          });
        }
      } else {
        calEvent = await calendar.events.insert({
          calendarId: targetCalId,
          sendUpdates: 'all',
          resource: calEventResource,
        });
      }
    }
    event.status = 'added';
    // The user just said yes; a recorded no for this date must not outlive it.
    await clearRefusal(req.user.email, { title: title || event.title, date });
    // Remember whose colour this is. Without it the Edit tab can only fall back
    // to Criba's original guess, so reopening an event the user had recoloured
    // showed the wrong person.
    if (targetMemberId !== undefined) event.member_id = targetMemberId || null;
    // The user just answered "whose is this". Record it as a fact.
    if (targetMemberId) await learnFromMemberAssignment(req.user.email, targetMemberId, event);
    event.reviewed = true; // manually approved events are already reviewed
    event.calEventId = calEvent.data.id;
    // Keep the calendar we actually wrote to. Overwriting it with the target
    // would strand an event we adopted or patched on a different calendar,
    // making later undo and update calls fail.
    event.gcalId = event.gcalId || targetCalId;
    event.approved_at = new Date().toISOString();
    // approved_at is stamped by auto-add and by feed imports too, so it cannot
    // answer "what did SHE do". This one is written only here and in
    // delete-from-calendar — the two endpoints a person reaches by clicking —
    // so the Recently added section can show a real 24-hour window instead of
    // filling up with a backfill the user never saw.
    event.user_action_at = new Date().toISOString();
    event.title = title || event.title;
    event.date = date;
    event.time = time || '';
    event.end_date = finalEndDate;
    event.end_time = finalEndTime;
    event.location = finalLocation;
    // The guests went to Google and nowhere else. Reopening the event on the
    // Edit screen then read event.attendees, found it empty, and the next save
    // patched the invite list back to empty — so adding a guest here and
    // editing anything later silently uninvited them.
    event.attendees = eventAttendees.map(a => ({ email: a.email }));
    if (has('recurrenceRule')) {
      event.recurrence_rule = recurrenceRule || null;
      event.recurrence_end_date = recurrenceRule ? span.recurrenceEndDate : null;
    }
    await events.set(id, event);
    res.json({ ok: true, calEventId: calEvent.data.id });
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.status(500).json({ error: 'Failed to add to Google Calendar: ' + err.message });
  }
});

app.post('/api/events/undo', requireAuth, async (req, res) => {
  const { id } = req.body;
  const events = getUserEvents(req.user.email);
  const event = await events.get(id);
  if (!event || !event.calEventId) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = await getUserOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    // An event the user already deleted by hand in Google Calendar makes this
    // call return 404/410. That is the goal state, not a failure — treating it
    // as one used to abort before the status reset below, stranding the event
    // as "added" with no route back to the review queue.
    try {
      await calendar.events.delete({ calendarId: event.gcalId || 'primary', eventId: event.calEventId });
    } catch (delErr) {
      const code = delErr?.code || delErr?.response?.status;
      if (code !== 404 && code !== 410) throw delErr;
      console.log(`[undo] "${event.title}" already gone from Google (${code}) — resetting anyway`);
    }
    event.status = 'pending';
    event.calEventId = null;
    event.approved_at = null;
    await events.set(id, event);
    res.json({ ok: true });
  } catch (err) {
    console.error('Undo error:', err.message);
    res.status(500).json({ error: 'Failed to undo: ' + err.message });
  }
});

app.post('/api/events/update', requireAuth, async (req, res) => {
  const { id, title, date, time, endDate, endTime, location, attendees } = req.body;
  const events = getUserEvents(req.user.email);
  const event = await events.get(id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = await getUserOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    // An event Criba found already on the calendar is stored with calEventId
    // null, because Criba did not write it. This used to 404 here, so the card
    // offered an edit form that could never save. Look the real event up and
    // edit that instead — preferring the series id over one expanded
    // occurrence, so the change lands on every occurrence.
    let adoptedSeries = false;
    // Set when the event Criba is holding no longer exists on Google. The edit
    // becomes a create rather than a dead end.
    let recreateOnCalendar = false;
    let recreateCalId = null;
    if (!event.calEventId) {
      const targetCalId = await resolveTargetCalendar(req.user.email);
      const found = await findExistingOnAnyCalendar(calendar, targetCalId, {
        title: event.title, date: event.date, time: event.time || '',
      });
      if (!found?.id) {
        // Deleting the event in Google used to strand it here permanently:
        // Criba still listed it as SYNCED, the edit form still opened, and
        // saving returned "could not find this event" with no way forward. The
        // user was told what was wrong and offered no means of fixing it.
        //
        // Criba is holding every detail needed to put it back, so put it back.
        // Re-creating something the user is actively trying to save is the
        // outcome she asked for; the worst case is a duplicate she can delete,
        // against a best case of a lost reminder she cannot recover.
        recreateOnCalendar = true;
        recreateCalId = targetCalId;
      } else {
        adoptedSeries = !!found.recurringEventId;
        event.calEventId = found.recurringEventId || found.id;
        event.gcalId = found.calendarId || targetCalId;
      }
    }
    // A field the client sent must win even when blank — that is how the user
    // clears an end date or turns a timed event into an all-day one. Falling
    // back to the stored value on every falsy input, which is what this did,
    // made those edits impossible: the old value simply came back.
    const has = k => Object.prototype.hasOwnProperty.call(req.body, k);
    const finalEndDate = has('endDate') ? (endDate || '') : (event.end_date || '');
    const finalEndTime = has('endTime') ? (endTime || '') : (event.end_time || '');
    const userTz = await getUserTimezone(req.user.email);

    const recurrenceRule = has('recurrenceRule') ? req.body.recurrenceRule : event.recurrence_rule;
    // Patching start/end on a recurring event would otherwise restore the
    // multi-day block the span fix exists to prevent.
    const span = resolveRecurringSpan(recurrenceRule, date, finalEndDate, event.recurrence_end_date);
    const { start, end } = buildCalendarTimes(date, time, span.endDate, finalEndTime, userTz);
    const eventAttendees = (attendees || []).filter(a => a.email).map(a => ({ email: a.email }));

    const resource = { summary: title, location: location || '', start, end, attendees: eventAttendees };

    // When the id we hold is a whole series, its start/end describe the FIRST
    // occurrence — not whichever one the user happened to open. Resending an
    // unchanged date would drag the entire series to that date, so start/end
    // go only when the user actually moved the event. Every other field still
    // applies to every occurrence, which is the point of editing a series.
    if (adoptedSeries && event.date === date && (event.time || '') === (time || '')) {
      delete resource.start;
      delete resource.end;
    }

    // Recolouring after the fact. Editing an event used to strip the person it
    // belonged to — the patch omitted colorId entirely, so Google kept whatever
    // was there and there was no way to change it short of deleting and
    // re-adding. Only touched when the client actually sends the field, so
    // clients that don't (the review queue) leave the colour alone.
    if (has('targetMemberId')) {
      const cals = getUserCalendars(req.user.email);
      const calSrc = event.calendar_id ? await cals.get(event.calendar_id) : null;
      const colorId = await resolveEventColor(req.user.email, req.body.targetMemberId, calSrc);
      // "" is Google's documented way to clear a colour back to the calendar
      // default, which is what "No colour" has to mean.
      resource.colorId = colorId ? String(colorId) : '';
      event.member_id = req.body.targetMemberId || null;
      if (req.body.targetMemberId) await learnFromMemberAssignment(req.user.email, req.body.targetMemberId, event);
    }
    // Google only changes recurrence when the field is present, and an empty
    // array is how a series is turned back into a single event. Send it either
    // way, or "does not repeat" would silently do nothing.
    if (has('recurrenceRule')) {
      resource.recurrence = recurrenceRule
        ? [ensureRecurrenceEnd(recurrenceRule, date, span.recurrenceEndDate)]
        : [];
    }
    if (recreateOnCalendar) {
      // insert, not patch — there is nothing left on Google to patch. The new
      // id is stored so the next edit is an ordinary one.
      const remade = await calendar.events.insert({
        calendarId: recreateCalId, sendUpdates: 'none', resource,
      });
      event.calEventId = remade.data.id;
      event.gcalId = recreateCalId;
      event.status = 'added';
      console.log(`[update] re-created "${title}" on Google — it had been deleted there`);
    } else {
      await calendar.events.patch({
        calendarId: event.gcalId || 'primary',
        eventId: event.calEventId,
        sendUpdates: 'all',
        resource,
      });
    }
    event.title = title; event.date = date; event.time = time || '';
    event.end_date = finalEndDate; event.end_time = finalEndTime;
    event.location = location || '';
    // Same round-trip gap as /api/events/approve: the patch sent the guests to
    // Google but the store never kept them, so the next edit re-sent an empty
    // list and dropped everyone.
    if (has('attendees')) event.attendees = eventAttendees.map(a => ({ email: a.email }));
    if (has('recurrenceRule')) {
      event.recurrence_rule = recurrenceRule || null;
      event.recurrence_end_date = recurrenceRule ? span.recurrenceEndDate : null;
    }
    await events.set(id, event);
    res.json({ ok: true, recreated: recreateOnCalendar });
  } catch (err) {
    console.error('Update error:', err.message);
    res.status(500).json({ error: 'Failed to update: ' + err.message });
  }
});

// Dismissing meant one thing when this queue held drafts: forget a proposal
// that was never written anywhere. Under auto-write most cards are already on
// Google Calendar, and setting status to 'dismissed' on one of those was the
// worst of both worlds — the event stayed on the calendar and left every screen
// in Criba, since 'dismissed' appears in neither feed's status filter. Six of
// them accumulated that way before anyone noticed.
//
// So dismissal now branches on the only fact that matters: is this actually on
// the calendar? If it is, dismissing removes it, because that is what the user
// pressing the button believes is happening. If it is not, nothing to remove.
app.post('/api/events/dismiss', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const event = await events.get(req.body.id);
  if (!event) return res.json({ ok: true });

  if (!event.calEventId) {
    // Might be a genuine draft (never written) — or an event whose calEventId
    // was lost but which is still on the calendar. Look before concluding there
    // is nothing to delete, so "dismiss" reliably means "remove from the
    // calendar too" (mirrors /api/events/delete-from-calendar).
    try {
      const auth = await getUserOAuthClient(req.user);
      const calendar = google.calendar({ version: 'v3', auth });
      const targetCalId = await resolveTargetCalendar(req.user.email);
      const found = await findExistingOnAnyCalendar(calendar, targetCalId, {
        title: event.title, date: event.date, time: event.time || '',
      });
      if (found?.id) {
        await calendar.events.delete({ calendarId: found.calendarId || targetCalId, eventId: found.recurringEventId || found.id });
        event.status = 'cancelled';
        event.calEventId = null;
        await events.set(req.body.id, event);
        await recordRefusal(req.user.email, event, 'dismiss-removed-from-calendar');
        return res.json({ ok: true, removedFromCalendar: true });
      }
    } catch (err) {
      const gone = err.message?.includes('410') || err.message?.includes('404') || err.message?.includes('Resource has been deleted');
      if (!gone) console.error('dismiss search-delete error:', err.message);
    }
    // Genuinely nothing on the calendar — a real draft, or already gone.
    event.status = 'dismissed';
    await events.set(req.body.id, event);
    await recordRefusal(req.user.email, event, 'dismiss');
    return res.json({ ok: true, removedFromCalendar: false });
  }

  try {
    const auth = await getUserOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: event.gcalId || 'primary', eventId: event.calEventId });
  } catch (err) {
    // Already gone on Google is success, not failure — the end state is the
    // one the user asked for either way.
    const gone = err.message?.includes('410') || err.message?.includes('404')
      || err.message?.includes('Resource has been deleted');
    if (!gone) {
      console.error('dismiss delete error:', err.message);
      return res.status(500).json({ error: 'Could not remove this from your calendar: ' + err.message });
    }
  }

  // 'cancelled', not 'dismissed'. Both mean the event is off the calendar, but
  // 'cancelled' is in the edit feed's filter and 'dismissed' is in nothing. A
  // removal the user can still see is a removal she can still reverse.
  event.status = 'cancelled';
  event.calEventId = null;
  await events.set(req.body.id, event);
  await recordRefusal(req.user.email, event, 'dismiss-removed-from-calendar');
  res.json({ ok: true, removedFromCalendar: true });
});

// ── Why was that dismissed? ───────────────────────────────────────────────
//
// Strictly after the fact. The dismissal has already completed by the time this
// is called, and skipping the prompt is the default: no answer means exactly
// today's behaviour, nothing written, nothing inferred.
//
// This endpoint never writes an exclusion. It returns candidates and the
// sentence the user has to agree to; POST /api/exclusions writes. Splitting the
// two is the whole safeguard — a rule cannot come into existence without the
// user having read what it says.
const DISMISS_FEEDBACK_MAX = 300;

async function logDismissFeedback(email, entry) {
  const key = `dismissFeedback:${email}`;
  await redis.lpush(key, JSON.stringify({ ts: Date.now(), ...entry }));
  await redis.ltrim(key, 0, DISMISS_FEEDBACK_MAX - 1);
  await redis.expire(key, 90 * 24 * 60 * 60);
}

const DISMISS_REASONS = new Set(['wrong-grade-tier', 'wrong-sender-activity', 'duplicate', 'not-interested', 'other']);

app.post('/api/events/dismiss-reason', requireAuth, async (req, res) => {
  const { id, reason } = req.body || {};
  const note = String(req.body?.note || '').slice(0, 500).trim();
  if (!DISMISS_REASONS.has(reason)) return res.status(400).json({ error: 'Unknown reason' });
  const event = await getUserEvents(req.user.email).get(id);
  if (!event) return res.status(404).json({ error: 'Not found' });

  // Everything is logged, including the reasons that deliberately write no
  // fact. "Not interested" fifty times about the same sender is a pattern worth
  // seeing later, even though no single instance justifies a rule.
  await logDismissFeedback(req.user.email, {
    eventId: id, reason, note: note || null,
    title: event.title || null, sender: event.sender_email || null, subject: event.subject || null,
  });

  // Not a relevance signal at all — the event was wanted, dedup just failed to
  // spot the copy already on the calendar. Recorded where the scan pipeline's
  // other decisions are, so it shows up next to the run that let it through.
  if (reason === 'duplicate') {
    await traceEmail(req.user.email, {
      stage: 'DUPLICATE-MISSED', title: event.title || null, date: event.date || null,
      messageId: event.gmail_message_id || null, from: event.sender_email || null,
      subject: event.subject || null, calEventId: event.calEventId || null,
      note: 'user says this was already on their calendar',
    });
    return res.json({ ok: true, candidates: [] });
  }

  // Too ambiguous to convert. A dismissal can mean wrong child, wrong grade,
  // bad extraction or a bad week, and the text cannot tell those apart.
  if (reason === 'not-interested' || reason === 'other') return res.json({ ok: true, candidates: [] });

  const members = await getUserFamily(req.user.email).values();
  const candidates = exclusionCandidates(event, reason, members);
  if (!candidates.length) return res.json({ ok: true, candidates: [] });
  res.json({ ok: true, candidates, prompt: exclusionPrompt(candidates) });
});

// ── Exclusion rules ───────────────────────────────────────────────────────
//
// Listed in plain language and removable in one tap, because undoing a rule has
// to be exactly as easy as making one. This list is also the answer to "why did
// this sender's events stop appearing" — that has to be visible state in the
// product, not something you can only find by reading a log.
app.get('/api/exclusions', requireAuth, async (req, res) => {
  const rules = await getUserExclusions(req.user.email).values();
  const members = await getUserFamily(req.user.email).values();
  // A rule contradicted by a confirmed fact is shown as already overridden
  // rather than quietly dropped, so the user can see why it stopped biting.
  res.json(rules
    .map(r => ({ ...r, overridden: familyHasPositive(members, r.type, r.value) }))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))));
});

app.post('/api/exclusions', requireAuth, async (req, res) => {
  const raw = Array.isArray(req.body?.rules) ? req.body.rules : [req.body];
  const store = getUserExclusions(req.user.email);
  const written = [];
  for (const r of raw) {
    const rule = normalizeExclusion(r);
    if (!rule) continue;
    // Preserve the original creation date if this rule already exists, so
    // re-confirming does not make an old rule look new.
    const existing = await store.get(rule.id);
    if (existing?.created_at) rule.created_at = existing.created_at;
    rule.source_event_id = r?.source_event_id || existing?.source_event_id || null;
    await store.set(rule.id, rule);
    written.push(rule);
  }
  if (!written.length) return res.status(400).json({ error: 'No usable rule in that request' });
  res.json({ ok: true, rules: written });
});

app.delete('/api/exclusions/:id', requireAuth, async (req, res) => {
  await getUserExclusions(req.user.email).delete(req.params.id);
  res.json({ ok: true });
});

// Read-only view of the reasons that deliberately wrote nothing. The point is
// to notice, by hand and later, that a shape of dismissal keeps recurring — and
// then to design a real category for it rather than guessing one now.
app.get('/api/dismiss-feedback', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), DISMISS_FEEDBACK_MAX);
  const raw = await redis.lrange(`dismissFeedback:${req.user.email}`, 0, limit - 1);
  res.json(raw.map(r => JSON.parse(r)));
});

// Mark event as reviewed — removes from Review queue but keeps on calendar
app.post('/api/events/mark-reviewed', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const ev = await events.get(req.body.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  ev.reviewed = true;
  ev.status = 'reviewed';
  await events.set(req.body.id, ev);
  res.json({ ok: true });
});

// Mark every event ALREADY ON THE CALENDAR as reviewed.
//
// Most of the queue is post-write — already on the calendar — so the correct
// action on the whole list is usually "yes, fine". Without this the only way to
// empty a long queue was to press OK on each card, which is why the tab grew
// unbounded.
//
// Deliberately skips cancellations and reschedules, which need a decision, and
// drafts (status 'pending'), which were never written. Marking a draft
// "reviewed" claimed it was on the calendar when it wasn't, and dropped it out
// of the queue for good — a bulk OK quietly discarded every event Criba hadn't
// managed to add yet.
app.post('/api/events/review-all-ok', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const all = await events.values();
  let cleared = 0;
  for (const ev of all) {
    if (ev.status === 'pending_cancellation' || ev.status === 'pending_reschedule') continue;
    if (ev.status === 'added' && !ev.reviewed) {
      ev.reviewed = true;
      ev.status = 'reviewed';
      await events.set(ev.id, ev);
      cleared++;
    }
  }
  res.json({ ok: true, cleared });
});

// Delete event from Google Calendar (Dismiss in post-write review).
// The frontend shows an 8-second undo toast before calling this.
app.post('/api/events/delete-from-calendar', requireAuth, async (req, res) => {
  const { id } = req.body;
  const events = getUserEvents(req.user.email);
  const event = await events.get(id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = await getUserOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    // An event Criba found already on the calendar has no calEventId, because
    // Criba did not write it. This used to skip the Google call entirely and
    // still return ok — so the card vanished and the event stayed on the
    // calendar. Deleting must mean deleting.
    if (!event.calEventId) {
      const targetCalId = await resolveTargetCalendar(req.user.email);
      const found = await findExistingOnAnyCalendar(calendar, targetCalId, {
        title: event.title, date: event.date, time: event.time || '',
      });
      if (!found?.id) {
        return res.status(404).json({
          error: 'Could not find this event on your Google Calendar — nothing was deleted.',
        });
      }
      event.calEventId = found.recurringEventId || found.id;
      event.gcalId = found.calendarId || targetCalId;
    }
    await calendar.events.delete({ calendarId: event.gcalId || 'primary', eventId: event.calEventId });
    // See the note on /api/events/dismiss: 'dismissed' is invisible in both
    // feeds, so a deleted event became unfindable as well as gone.
    event.status = 'cancelled';
    event.calEventId = null;
    event.user_action_at = new Date().toISOString();
    await events.set(id, event);
    await recordRefusal(req.user.email, event, 'delete-from-calendar');
    res.json({ ok: true });
  } catch (err) {
    if (err.message?.includes('410') || err.message?.includes('Resource has been deleted') || err.message?.includes('404')) {
      // Already deleted from GCal — still record the removal in Redis
      event.status = 'cancelled';
      event.calEventId = null;
      event.user_action_at = new Date().toISOString();
      await events.set(id, event);
      await recordRefusal(req.user.email, event, 'delete-from-calendar');
      return res.json({ ok: true });
    }
    console.error('delete-from-calendar error:', err.message);
    res.status(500).json({ error: 'Failed to delete from Google Calendar: ' + err.message });
  }
});

// ── Full cleanup (dev/testing reset) ─────────────────────────────────────
// Deletes every Criba-tracked calendar event from Google Calendar and clears
// the corresponding Redis records. One-shot dev tool — no confirmation step.
app.post('/api/events/cleanup-all', requireAuth, async (req, res) => {
  const eventsStore = getUserEvents(req.user.email);
  const auth = await getUserOAuthClient(req.user);
  const calendar = google.calendar({ version: 'v3', auth });
  const CLEANUP_STATUSES = new Set(['added', 'approved', 'reviewed']);
  const all = await eventsStore.entries();
  const toDelete = all.filter(([, ev]) => CLEANUP_STATUSES.has(ev.status) && ev.calEventId);

  let deleted = 0;
  const results = [];
  const redisDeleteIds = [];

  for (const [id, ev] of toDelete) {
    try {
      await calendar.events.delete({ calendarId: ev.gcalId || 'primary', eventId: ev.calEventId });
      results.push({ title: ev.title, date: ev.date, status: 'deleted' });
      deleted++;
    } catch (err) {
      const gone = err.message?.includes('410') || err.message?.includes('404') || err.message?.includes('Resource has been deleted');
      results.push({ title: ev.title, date: ev.date, status: gone ? 'already-gone' : 'error', error: gone ? undefined : err.message });
      if (gone) deleted++; // count as cleaned up even if already removed
    }
    redisDeleteIds.push(id); // always clear from Redis
  }

  // Clear Redis records in one pipeline
  if (redisDeleteIds.length) {
    const pipeline = redis.pipeline();
    for (const id of redisDeleteIds) pipeline.hdel(`events:${req.user.email}`, id);
    await pipeline.exec();
  }

  console.log(`[cleanup-all] email=${req.user.email} deleted=${deleted} total=${toDelete.length}`);
  res.json({ ok: true, deleted, total: toDelete.length, results });
});

// Cancel ONE date of a recurring series, leaving the rest of the series intact.
//
// Criba stores the series id, so deleting that id removes every occurrence —
// an email saying "no class on Nov 26" would silently wipe the whole year.
// Google models a single skipped date as its own instance, so the safe move is
// to find that date's instance and cancel only it.
//
// Returns true when one occurrence was cancelled, false when the caller should
// fall back to deleting the whole event.
async function cancelOneOccurrence(calendarApi, calendarId, seriesId, date, localTz = DEFAULT_TZ) {
  if (!seriesId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  try {
    const resp = await calendarApi.events.instances({
      calendarId, eventId: seriesId,
      // The window is expressed in UTC while `date` is a local calendar day, so
      // the two disagree by up to a day in either direction — a Tokyo evening
      // class sits in the previous UTC day, a Los Angeles one in the next. The
      // comment here used to claim the window was widened to cover that; it was
      // not, so those instances were simply never found. Widen it for real and
      // let the local-date match below pick the right instance out.
      timeMin: new Date(`${addDaysToDateStr(date, -1)}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${addDaysToDateStr(date, 1)}T23:59:59Z`).toISOString(),
      maxResults: 10,
      timeZone: isValidTimezone(localTz) ? localTz : DEFAULT_TZ,
    });
    const items = resp.data.items || [];
    // Match the local date exactly. There used to be an `|| items[0]` fallback
    // here, which was survivable only while the window was a single day — now
    // that it spans three, falling back would delete a neighbouring week's
    // class. No confident match means we report failure and touch nothing.
    const hit = items.find(i => (i.start?.date || (i.start?.dateTime || '').slice(0, 10)) === date);
    if (!hit?.id) return false;
    await calendarApi.events.delete({ calendarId, eventId: hit.id, sendUpdates: 'none' });
    return true;
  } catch (err) {
    console.error('[cancel-occurrence] failed:', err.message);
    return false;
  }
}

// Approve a cancellation: delete the matched approved event from Google Calendar,
// then mark both the pending_cancellation record and the matched event as dismissed.
app.post('/api/events/approve-cancellation', requireAuth, async (req, res) => {
  const { id } = req.body;
  const eventsStore = getUserEvents(req.user.email);
  const pendingEv = await eventsStore.get(id);
  if (!pendingEv) return res.status(404).json({ error: 'Event not found' });

  const matchedId = pendingEv.matched_event_id;
  let deletedFromGcal = false;
  let cancelledOccurrence = null;
  if (matchedId) {
    const matchedEv = await eventsStore.get(matchedId);
    if (matchedEv?.calEventId) {
      try {
        const auth = await getUserOAuthClient(req.user);
        const calendar = google.calendar({ version: 'v3', auth });
        const calId = matchedEv.gcalId || 'primary';
        // A cancellation naming one date of a repeating event cancels that
        // date, not the series. Only fall through to deleting everything when
        // the event does not repeat.
        const targetDate = pendingEv.old_date || pendingEv.date || '';
        const oneOff = matchedEv.recurrence_rule
          ? await cancelOneOccurrence(calendar, calId, matchedEv.calEventId, targetDate, await getUserTimezone(req.user.email))
          : false;
        if (oneOff) {
          cancelledOccurrence = targetDate;
        } else {
          if (matchedEv.recurrence_rule) {
            // Refusing is the right failure here. Deleting a whole series
            // because we could not isolate one date is not a recoverable
            // mistake for the user.
            return res.status(409).json({
              error: 'Could not cancel just that date',
              detail: `"${matchedEv.title}" repeats, and Criba could not isolate ${targetDate || 'the date'} to cancel. Nothing was changed.`,
            });
          }
          await calendar.events.delete({ calendarId: calId, eventId: matchedEv.calEventId });
        }
        deletedFromGcal = true;
      } catch (err) {
        console.error('[approve-cancellation] GCal delete error:', err.message);
        // If event is already gone from GCal (410), proceed anyway
        if (!err.message?.includes('410') && !err.message?.includes('Resource has been deleted')) {
          return res.status(500).json({ error: 'Failed to delete from Google Calendar: ' + err.message });
        }
        deletedFromGcal = true;
      }
      if (cancelledOccurrence) {
        // The series is still running, so it must not be marked cancelled —
        // that would hide it from the queue and strand every other date.
        matchedEv.skipped_dates = [...new Set([...(matchedEv.skipped_dates || []), cancelledOccurrence])];
      } else {
        matchedEv.status = 'cancelled';
        // It is not on Google any more, so the id must go with it. Leaving it
        // set made the row claim "Synced" on Edit Your Events for an event
        // Criba had just deleted, and — worse — hid the "Add to calendar"
        // button, which is the only way back if the cancellation was matched
        // to the wrong event.
        matchedEv.calEventId = null;
        // Approving a cancellation is a click, so it belongs in the 24-hour
        // "Recently added or removed" section, where the undo lives.
        matchedEv.user_action_at = new Date().toISOString();
      }
      await eventsStore.set(matchedId, matchedEv);
      // A confirmed cancellation is a decision too: if a later email
      // re-announces this date, it should come back as a question, not a write.
      if (matchedEv.status === 'cancelled') await recordRefusal(req.user.email, matchedEv, 'school-cancelled');
    }
  }

  pendingEv.status = 'dismissed';
  await eventsStore.set(id, pendingEv);
  res.json({ ok: true, deletedFromGcal, cancelledOccurrence });
});

// Dismiss a cancellation notice without acting on it.
app.post('/api/events/dismiss-cancellation', requireAuth, async (req, res) => {
  const eventsStore = getUserEvents(req.user.email);
  const ev = await eventsStore.get(req.body.id);
  // Reporting ok for an id that does not exist tells the caller the card
  // was dismissed when nothing was written, so it returns on the next
  // refresh and Dismiss looks broken. Say what actually happened.
  if (!ev) return res.status(404).json({ error: 'That notice no longer exists — refresh the page.' });
  ev.status = 'dismissed';
  await eventsStore.set(req.body.id, ev);
  res.json({ ok: true });
});

// Approve a reschedule: update the matched GCal event with new date/time/title.
app.post('/api/events/approve-reschedule', requireAuth, async (req, res) => {
  const { id } = req.body;
  const eventsStore = getUserEvents(req.user.email);
  const pendingEv = await eventsStore.get(id);
  if (!pendingEv) return res.status(404).json({ error: 'Event not found' });

  const matchedId = pendingEv.matched_event_id;
  if (!matchedId) return res.status(400).json({ error: 'No matched event to reschedule' });

  const matchedEv = await eventsStore.get(matchedId);
  if (!matchedEv?.calEventId) return res.status(400).json({ error: 'Matched event has no GCal ID' });

  try {
    const auth = await getUserOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    const reschedSpan = resolveRecurringSpan(matchedEv.recurrence_rule, pendingEv.date, pendingEv.end_date || '', matchedEv.recurrence_end_date);
    const { start, end } = buildCalendarTimes(pendingEv.date, pendingEv.time, reschedSpan.endDate, pendingEv.end_time || '', await getUserTimezone(req.user.email));
    await calendar.events.patch({
      calendarId: matchedEv.gcalId || 'primary',
      eventId: matchedEv.calEventId,
      sendUpdates: 'all',
      resource: { summary: pendingEv.title || matchedEv.title, start, end, location: pendingEv.location || matchedEv.location || '' },
    });
    // Update the approved event record with new details
    matchedEv.title = pendingEv.title || matchedEv.title;
    matchedEv.date = pendingEv.date;
    matchedEv.time = pendingEv.time || '';
    matchedEv.end_date = pendingEv.end_date || '';
    matchedEv.end_time = pendingEv.end_time || '';
    matchedEv.location = pendingEv.location || matchedEv.location || '';
    matchedEv.approved_at = new Date().toISOString();
    await eventsStore.set(matchedId, matchedEv);

    pendingEv.status = 'dismissed';
    await eventsStore.set(id, pendingEv);
    res.json({ ok: true, calEventId: matchedEv.calEventId });
  } catch (err) {
    console.error('[approve-reschedule] GCal patch error:', err.message);
    res.status(500).json({ error: 'Failed to update Google Calendar: ' + err.message });
  }
});

// Dismiss a reschedule notice without acting on it.
app.post('/api/events/dismiss-reschedule', requireAuth, async (req, res) => {
  const eventsStore = getUserEvents(req.user.email);
  const ev = await eventsStore.get(req.body.id);
  // Reporting ok for an id that does not exist tells the caller the card
  // was dismissed when nothing was written, so it returns on the next
  // refresh and Dismiss looks broken. Say what actually happened.
  if (!ev) return res.status(404).json({ error: 'That notice no longer exists — refresh the page.' });
  ev.status = 'dismissed';
  await eventsStore.set(req.body.id, ev);
  res.json({ ok: true });
});
app.get('/api/calendars', requireAuth, async (req, res) => {
  const cals = getUserCalendars(req.user.email);
  const list = (await cals.values()).sort((a,b) => b.created_at > a.created_at ? 1 : -1);
  // Self-healing enrolment: feeds added before nightly sync existed are not in
  // the subscriber set, so they would never be re-read. Loading the page is
  // enough to enrol them rather than needing a one-off migration script.
  if (list.some(c => c.source === 'ical' && c.url)) await redis.sadd('icalSubscribers', req.user.email);
  res.json(list);
});

// How many of this calendar's events are still ahead of the user. Deleting a
// finished season should leave the games that already happened alone; deleting
// mid-season is a different decision, and the count is what tells them apart.
app.get('/api/calendars/:id/upcoming-count', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const todayStr = new Date().toLocaleDateString('en-CA');
  const upcoming = (await events.values()).filter(ev =>
    ev.calendar_id === req.params.id && ev.status === 'added' && ev.calEventId && ev.date >= todayStr);
  res.json({ upcomingCount: upcoming.length });
});

app.delete('/api/calendars/:id', requireAuth, async (req, res) => {
  const calId = req.params.id;
  const removeUpcoming = req.query.removeUpcoming === '1';
  const cals = getUserCalendars(req.user.email);
  const events = getUserEvents(req.user.email);
  const todayStr = new Date().toLocaleDateString('en-CA');

  let removedFromCalendar = 0;
  if (removeUpcoming) {
    // Only ever future events Criba itself wrote from this calendar. Past
    // events stay put — a season that happened, happened, and wiping the
    // history is not what "the season is over" means.
    const calendar = google.calendar({ version: 'v3', auth: await getUserOAuthClient(req.user) });
    for (const [, ev] of await events.entries()) {
      if (ev.calendar_id !== calId || ev.status !== 'added' || !ev.calEventId) continue;
      if (!ev.date || ev.date < todayStr) continue;
      try {
        await calendar.events.delete({ calendarId: ev.gcalId, eventId: ev.calEventId, sendUpdates: 'none' });
        removedFromCalendar++;
      } catch (err) {
        // Already gone from Google is a success, not a failure.
        if ([404, 410].includes(err?.code)) removedFromCalendar++;
        else console.error(`[calendar delete] ${ev.calEventId}:`, err.message);
      }
    }
  }

  await cals.delete(calId);
  // Every record for this calendar goes, not just the pending ones. Leaving
  // them behind orphaned rows that the dedup and sync passes still walked.
  for (const [eid, ev] of await events.entries()) {
    if (ev.calendar_id === calId) await events.delete(eid);
  }

  // Stop the nightly sync visiting a user with no feeds left.
  const remaining = await cals.values();
  if (!remaining.some(c => c.source === 'ical' && c.url)) await redis.srem('icalSubscribers', req.user.email);

  res.json({ ok: true, removedFromCalendar });
});

// Deterministically turns a parsed VEVENT into {date, end_date, time, end_time,
// all_day} using the feed's own DTSTART/DTEND — this is the source of truth
// for dates/times. AI is only used afterward to classify *type*, never to
// invent or rewrite dates, so a bad model response can't corrupt calendar data.
function parseIcalEventDates(ev) {
  const tz = 'America/Los_Angeles';
  const start = new Date(ev.start);
  const isAllDay = ev.datetype === 'date';
  const date = start.toLocaleDateString('en-CA', { timeZone: tz });
  const time = isAllDay ? '' : start.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: tz });
  let end_date = '';
  let end_time = '';
  if (ev.end) {
    const end = new Date(ev.end);
    if (isAllDay) {
      // iCal all-day DTEND is exclusive (the day after the last day).
      const inclusiveEnd = addDaysToDateStr(end.toLocaleDateString('en-CA', { timeZone: tz }), -1);
      if (inclusiveEnd > date) end_date = inclusiveEnd;
    } else {
      end_time = end.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: tz });
    }
  }
  return { date, end_date, time, end_time, all_day: isAllDay };
}

// Sends the feed's own events (already date/time-accurate) to Claude purely
// for semantic classification — type, grouping category, and recurring-note
// detection — referenced by index so the model can't alter the real dates.
// Falls back to the old heuristic (ics `categories` field, type "other") if
// the AI call fails or returns something unparseable, so an Anthropic outage
// doesn't break a previously-reliable, non-AI import path.
// Pull the text out of a Claude response.
//
// Do NOT assume content[0] is the text block. Extended-thinking models put a
// `thinking` block first, which has no `.text` property — indexing blindly
// threw "Cannot read properties of undefined (reading 'trim')" on every single
// extraction, after the model had already spent ~20s thinking.
function getResponseText(response) {
  const blocks = response?.content;
  if (!Array.isArray(blocks)) throw new Error('Claude response had no content array');
  const textBlock = blocks.find(b => b?.type === 'text' && typeof b.text === 'string');
  if (!textBlock) {
    const types = blocks.map(b => b?.type).join(',') || 'none';
    throw new Error(`Claude response had no text block (types: ${types})`);
  }
  return textBlock.text;
}

async function classifyIcalEventsWithAI(rawEvents, ownerEmail = null) {
  const compact = rawEvents.map((r, index) => ({
    index,
    title: r.title,
    date: r.date,
    end_date: r.end_date || undefined,
    time: r.time || undefined,
    end_time: r.end_time || undefined,
    all_day: r.all_day,
    source_category: r.source_category,
  }));
  const prompt = `Here is a list of events from a school calendar feed, as JSON. The dates/times are already correct — do not change them. For each event, classify it and choose a review-queue category grouping.

${EVENT_CLASSIFICATION_RULES}

Events:
${JSON.stringify(compact)}

Return ONLY valid JSON, no markdown, in this shape: {"results":[{"index":0,"type":"holiday|break|timed|minimum_day|recurring|other","category":"Category name for grouping in the review queue","recurring_note":"string or null (only for type=recurring)"}]}. Include every index exactly once.`;
  const response = await callClaude(ownerEmail, {
    model: 'claude-opus-4-5',
    max_tokens: Math.min(8192, 1000 + rawEvents.length * 40),
    messages: [{ role: 'user', content: prompt }],
  }, 'ical-classify');
  const text = getResponseText(response);
  const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  if (!Array.isArray(parsed.results)) throw new Error('AI classification response missing results array');
  return parsed.results;
}

// "Subscribe to calendar" links hand out webcal:// URLs — it is the scheme that
// makes a desktop calendar app open instead of a browser tab. Over the wire it
// is plain HTTP, but fetch() refuses the scheme outright, so a user pasting the
// link straight from a school or team site hit "Unsupported protocol webcal:".
// Swap the scheme and the same URL works.
function normalizeIcalUrl(url) {
  const trimmed = String(url || '').trim();
  return /^webcal:\/\//i.test(trimmed) ? trimmed.replace(/^webcal:\/\//i, 'https://') : trimmed;
}

// The Google event body for one stored Criba event. Extracted so the import
// path, the approve path and the subscription re-sync all build events the
// same way — three copies of this drifted apart is exactly how a synced event
// ends up losing its colour or its recurrence rule.
function buildGoogleResource(ev, { colorId, tz, extraAttendees = [] }) {
  if (!ev.date) throw new Error('Missing date');
  const span = resolveRecurringSpan(ev.recurrence_rule, ev.date, ev.end_date, ev.recurrence_end_date);
  const { start, end } = buildCalendarTimes(ev.date, ev.time, span.endDate, ev.end_time, tz);
  const attendees = (ev.attendees || []).filter(a => a.email).map(a => ({ email: a.email }));
  for (const addr of extraAttendees) {
    if (!attendees.some(a => String(a.email).toLowerCase() === addr)) attendees.push({ email: addr });
  }
  const description = buildEventDescription(ev);
  const resource = { summary: ev.title, location: ev.location || '', start, end, attendees, description };
  if (ev.recurrence_rule) resource.recurrence = [ensureRecurrenceEnd(ev.recurrence_rule, ev.date, span.recurrenceEndDate)];
  if (colorId) resource.colorId = String(colorId);
  return resource;
}

// How far ahead a feed import or re-sync looks. A feed can carry years of
// history; only the part of it that is still ahead of the user matters.
function icalWindow() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(today); end.setFullYear(end.getFullYear() + 2);
  return { today, end };
}

// Fetch a feed and reduce it to the upcoming VEVENTs we care about, keyed by
// the feed's own UID. UID is what makes re-sync possible: it is stable across
// fetches, so "the school moved Week 4" reads as a change to a known event
// rather than as a brand new one plus an orphan.
async function fetchIcalEvents(url) {
  const parsed = await ical.async.fromURL(normalizeIcalUrl(url));
  const { today, end } = icalWindow();
  const out = [];
  for (const ev of Object.values(parsed)) {
    if (ev.type !== 'VEVENT') continue;
    const start = ev.start ? new Date(ev.start) : null;
    if (!start || start < today || start > end) continue;
    // Cancelled entries stay in many feeds rather than disappearing; treating
    // one as a live event would put a cancelled game back on the calendar.
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
    out.push({
      uid: String(ev.uid || '') || null,
      title: ev.summary || 'Untitled Event',
      location: ev.location || '',
      source_category: ev.categories?.[0] || 'School Events',
      ...parseIcalEventDates(ev),
    });
  }
  return out;
}

// The fields that decide whether an already-written event still matches the
// feed. Title, when, and where — the things a parent would notice.
function icalFingerprint(ev) {
  return [ev.title || '', ev.date || '', ev.time || '', ev.end_date || '', ev.end_time || '', ev.location || '']
    .map(s => String(s).trim()).join('|');
}

// Classification is best-effort. If Anthropic is down the import still
// succeeds using the feed's own categories — a previously non-AI path should
// not start failing just because it gained an AI step.
async function classifyIcalEvents(rawEvents, ownerEmail = null) {
  let classifications;
  try {
    classifications = await classifyIcalEventsWithAI(rawEvents, ownerEmail);
  } catch (aiErr) {
    console.error('iCal AI classification failed, falling back to raw categories:', aiErr.message);
    classifications = rawEvents.map((r, index) => ({ index, type: 'other', category: r.source_category, recurring_note: null }));
  }
  const byIndex = new Map(classifications.map(c => [c.index, c]));
  return rawEvents.map((r, index) => {
    const cls = byIndex.get(index) || { type: 'other', category: r.source_category, recurring_note: null };
    const norm = normalizeExtractedEvent({ ...r, type: cls.type, recurring_note: cls.recurring_note });
    // uid is carried through deliberately: normalizeExtractedEvent drops
    // anything it does not know about, and without the uid re-sync is blind.
    return { title: r.title, uid: r.uid, ...norm, category: cls.category || r.source_category };
  });
}

// Writes already-stored events to Google and marks them added. Used by the
// feed import and the nightly sync; the interactive approve path keeps its own
// copy because it also handles group invitees and per-request notification.
async function writeCalendarEvents(user, calendarId, eventIds, { auth: presetAuth } = {}) {
  const events = getUserEvents(user.email);
  const cals = getUserCalendars(user.email);
  const calSrc = await cals.get(calendarId);
  const auth = presetAuth || await getUserOAuthClient(user);
  const calendar = google.calendar({ version: 'v3', auth });
  const targetCalId = await resolveTargetCalendar(user.email);
  const colorId = await resolveEventColor(user.email, null, calSrc);
  const tz = await getUserTimezone(user.email);

  let addedCount = 0;
  const failed = [];
  const updates = [];
  for (const id of eventIds) {
    const ev = await events.get(id);
    if (!ev || ev.status === 'added') continue;
    try {
      // Feed imports and the nightly sync used to insert without ever asking
      // whether the event was already on the calendar — they bypassed the
      // duplicate check that every other write path goes through. Re-importing
      // a feed, or a sync that could not match uids, therefore wrote a second
      // copy of every game. Adopt what is already there instead of adding to it.
      const already = await findExistingOnAnyCalendar(calendar, targetCalId, {
        title: ev.title, date: ev.date, time: ev.time || '',
      });
      if (already?.id) {
        ev.status = 'added';
        ev.reviewed = false;
        ev.calEventId = already.recurringEventId || already.id;
        ev.gcalId = already.calendarId || targetCalId;
        ev.approved_at = new Date().toISOString();
        updates.push([id, ev]);
        console.log(`[calendar-dedup] SKIP (writeCalendarEvents) "${ev.title}" on ${ev.date} — already on ${already.calendarName || already.calendarId}`);
        continue;
      }
      const resource = buildGoogleResource(ev, { colorId, tz });
      const created = await calendar.events.insert({ calendarId: targetCalId, sendUpdates: 'none', resource });
      noteWrittenToCache(targetCalId, ev.date, {
        id: created.data.id, recurringEventId: null, title: ev.title, date: ev.date,
        time: ev.time || '', end_time: ev.end_time || '', is_all_day: !ev.time,
      });
      ev.status = 'added';
      ev.reviewed = false;
      ev.calEventId = created.data.id;
      ev.gcalId = targetCalId;
      ev.approved_at = new Date().toISOString();
      updates.push([id, ev]);
      addedCount++;
    } catch (err) {
      console.error(`Calendar write failed for event ${id}:`, err.message);
      failed.push({ id, title: ev.title, error: err.message });
    }
  }
  if (updates.length) await events.setMany(updates);
  return { addedCount, failed };
}

// Re-reads one subscribed feed and makes the user's calendar match it.
// Deliberately silent: the user chose no notifications, on the reasoning that a
// November game moving in August is noise. Three outcomes per event —
//   in feed, not ours      -> add it
//   in both, changed       -> patch the existing Google event in place
//   ours, gone from feed   -> delete it (the source dropped it)
// Patching rather than delete+insert keeps the Google event id stable, so
// anything the user did to it by hand (a reminder, an invitee) survives.
async function syncIcalCalendar(userEmail, cal) {
  const refreshToken = await redis.get(`refreshToken:${userEmail}`);
  if (!refreshToken) throw new Error('No stored refresh token');
  const auth = getOAuthClientFromRefreshToken(refreshToken);
  const calendar = google.calendar({ version: 'v3', auth });
  const user = { email: userEmail };

  const feed = await fetchIcalEvents(cal.url);
  // An empty parse is far more likely to be a server hiccup or a moved URL
  // than a school deleting its whole year. Wiping the calendar on that guess
  // is unrecoverable, so treat it as nothing-to-do.
  if (!feed.length) return { added: 0, updated: 0, removed: 0, skipped: 'empty feed' };

  const events = getUserEvents(userEmail);
  const all = await events.entries();
  const ours = all.filter(([, ev]) => ev.calendar_id === cal.id);
  const oursByUid = new Map(ours.filter(([, ev]) => ev.ical_uid).map(([id, ev]) => [ev.ical_uid, { id, ev }]));

  // Adoption pass for feeds imported before uids were stored. Without this the
  // first sync sees zero known uids, calls every event new, and duplicates the
  // entire calendar. Match those older events to the feed on title+when+where
  // and stamp the uid onto them so they are recognised from here on.
  const orphans = ours.filter(([, ev]) => !ev.ical_uid);
  if (orphans.length) {
    const byPrint = new Map();
    for (const [id, ev] of orphans) byPrint.set(icalFingerprint(ev), { id, ev });
    const adopted = [];
    for (const f of feed) {
      if (!f.uid || oursByUid.has(f.uid)) continue;
      const match = byPrint.get(icalFingerprint(f));
      if (!match) continue;
      byPrint.delete(icalFingerprint(f));
      match.ev.ical_uid = f.uid;
      match.ev.ical_fingerprint = icalFingerprint(f);
      oursByUid.set(f.uid, match);
      adopted.push([match.id, match.ev]);
    }
    if (adopted.length) await events.setMany(adopted);
  }

  const { today, end } = icalWindow();
  const feedUids = new Set(feed.map(f => f.uid).filter(Boolean));
  const targetCalId = await resolveTargetCalendar(userEmail);
  const colorId = await resolveEventColor(userEmail, null, cal);
  const tz = await getUserTimezone(userEmail);

  let added = 0, updated = 0, removed = 0;

  // 1. Changed events — patch in place.
  const changed = [];
  for (const f of feed) {
    if (!f.uid) continue;
    const match = oursByUid.get(f.uid);
    if (!match) continue;
    if (icalFingerprint(f) === match.ev.ical_fingerprint) continue;
    changed.push({ f, ...match });
  }
  if (changed.length) {
    const reclassified = await classifyIcalEvents(changed.map(c => c.f), userEmail);
    const updates = [];
    for (let i = 0; i < changed.length; i++) {
      const { id, ev } = changed[i];
      const priorTitle = ev.title, priorDate = ev.date, priorTime = ev.time || '';
      Object.assign(ev, reclassified[i], { ical_fingerprint: icalFingerprint(changed[i].f) });
      try {
        // An event Criba adopted rather than wrote has no calEventId. This used
        // to skip the Google patch and still stamp the new fingerprint — so the
        // event was permanently recorded as in sync while the calendar still
        // showed the old time, and no later sync would ever try again. Look it
        // up by what is ON the calendar (the values before this change), and if
        // it genuinely cannot be found, leave the fingerprint alone so the next
        // sync retries instead of declaring victory.
        if (!ev.calEventId) {
          const found = await findExistingOnAnyCalendar(calendar, targetCalId, {
            title: priorTitle, date: priorDate, time: priorTime,
          });
          if (found?.id) {
            ev.calEventId = found.recurringEventId || found.id;
            ev.gcalId = found.calendarId || targetCalId;
          }
        }
        if (!ev.calEventId) {
          console.error(`[ical sync] cannot locate "${priorTitle}" on ${priorDate} — leaving unsynced for retry`);
          continue;
        }
        await calendar.events.patch({
          calendarId: ev.gcalId || targetCalId, eventId: ev.calEventId,
          sendUpdates: 'none', resource: buildGoogleResource(ev, { colorId, tz }),
        });
        updated++;
        updates.push([id, ev]);
      } catch (err) {
        console.error(`[ical sync] patch failed for ${id}:`, err.message);
      }
    }
    if (updates.length) await events.setMany(updates);
  }

  // 2. New events — classify, store, write.
  const fresh = feed.filter(f => f.uid && !oursByUid.has(f.uid));
  if (fresh.length) {
    const classified = await classifyIcalEvents(fresh, userEmail);
    const pairs = classified.map(ev => {
      const evId = randomUUID();
      return [evId, {
        id: evId, calendar_id: cal.id, ...ev, attendees: [], source: cal.name,
        ical_uid: ev.uid || null, ical_fingerprint: icalFingerprint(ev),
        status: 'draft', created_at: new Date().toISOString(),
      }];
    });
    await events.setMany(pairs);
    const res = await writeCalendarEvents(user, cal.id, pairs.map(([id]) => id), { auth });
    added = res.addedCount;
  }

  // 3. Dropped events — the feed no longer has them. Only ever remove events
  // Criba itself put there from this feed, still in the window we fetched, so
  // a shrunken feed window can never delete a user's own entries.
  const removals = [];
  for (const [id, ev] of ours) {
    if (!ev.ical_uid || feedUids.has(ev.ical_uid)) continue;
    if (!ev.date) continue;
    const when = new Date(`${ev.date}T00:00:00`);
    if (when < today || when > end) continue;
    removals.push([id, ev]);
  }
  for (const [id, ev] of removals) {
    try {
      if (ev.calEventId) {
        await calendar.events.delete({ calendarId: ev.gcalId || targetCalId, eventId: ev.calEventId, sendUpdates: 'none' });
      }
      await events.delete(id);
      removed++;
    } catch (err) {
      // A 404/410 means it is already gone from Google — drop our record too.
      if ([404, 410].includes(err?.code)) { await events.delete(id); removed++; continue; }
      console.error(`[ical sync] delete failed for ${id}:`, err.message);
    }
  }

  return { added, updated, removed };
}

app.post('/api/calendars/add-ical', requireAuth, async (req, res) => {
  const { name, url, memberId } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL are required' });
  try {
    const rawEvents = await fetchIcalEvents(url);
    if (rawEvents.length === 0) return res.status(400).json({ error: 'No upcoming events found in this calendar' });

    const finalEvents = await classifyIcalEvents(rawEvents, req.user.email);

    const categoryMap = new Map();
    for (const ev of finalEvents) {
      if (!categoryMap.has(ev.category)) categoryMap.set(ev.category, 0);
      categoryMap.set(ev.category, categoryMap.get(ev.category) + 1);
    }
    const categories = [...categoryMap.entries()].map(([catName, count]) => ({ name: catName, count }));

    const calId = randomUUID();
    const cals = getUserCalendars(req.user.email);
    const cal = { id: calId, name, source: 'ical', url, memberId: memberId || null, event_count: 0, created_at: new Date().toISOString() };
    await cals.set(calId, cal);

    // A subscription is not a suggestion. Pasting the link is the approval, so
    // these go straight onto the calendar — unlike PDF and image uploads, where
    // AI read a picture and could be wrong. Feeds are the source's own data.
    const events = getUserEvents(req.user.email);
    const eventPairs = finalEvents.map(ev => {
      const evId = randomUUID();
      return [evId, {
        id: evId, calendar_id: calId, ...ev, attendees: [], source: name,
        ical_uid: ev.uid || null, ical_fingerprint: icalFingerprint(ev),
        status: 'draft', created_at: new Date().toISOString(),
      }];
    });
    await events.setMany(eventPairs);

    const written = await writeCalendarEvents(req.user, calId, eventPairs.map(([id]) => id));

    // Remember this user has feeds so the nightly sync knows to visit them.
    await redis.sadd('icalSubscribers', req.user.email);
    cal.event_count = written.addedCount;
    cal.last_synced_at = new Date().toISOString();
    await cals.set(calId, cal);

    res.json({
      ok: true, calendarId: calId, totalEvents: finalEvents.length, categories,
      autoAdded: true, addedCount: written.addedCount, failed: written.failed,
    });
  } catch (err) {
    console.error('iCal error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar: ' + err.message });
  }
});

// Pull closure/no-activity date ranges out of an uploaded document.
//
// Run as its own call rather than folded into the event extraction: the two
// answer different questions ("what should I add" vs "when is nothing on"),
// and keeping them apart means a document with no closures cannot destabilise
// the extraction that already works. Best-effort by design — on any failure
// the upload behaves exactly as it does today.
const CLOSURES_PROMPT = `List every date or date range in this document on which regular scheduled activities do NOT take place — holidays, breaks, closures, no-class days, days off, cancelled sessions.

Return JSON only, in this shape:
{"closures":[{"title":"Winter Break","start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD"}]}

Rules:
- A single day has start_date === end_date.
- Ranges written like "Dec 21 - Jan 3" cross the year boundary; infer the correct years from context.
- Include the closure's own name as "title".
- Do NOT include events that simply happen on a date. Only dates when the regular activity is NOT running.
- If the document lists no closures at all, return {"closures":[]}.`;

async function extractClosures(contentBlock, todayStr, ownerEmail = null) {
  try {
    const resp = await callClaude(ownerEmail, {
      model: 'claude-fable-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: `Today is ${todayStr}.\n\n${CLOSURES_PROMPT}` }] }],
    }, 'closures');
    const raw = JSON.parse(getResponseText(resp).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    return Array.isArray(raw?.closures) ? raw.closures : [];
  } catch (err) {
    console.error('[closures] extraction failed, continuing without:', err.message);
    return [];
  }
}

// Events already on the user's calendar that a closure list could affect.
async function liveCalendarEvents(email) {
  const all = await getUserEvents(email).values();
  return all.filter(e => e.calEventId && e.status !== 'cancelled' && e.status !== 'dismissed');
}

// A schedule is just as often a screenshot as a PDF — school and league sites
// publish them as web tables with no feed and no download. Claude reads images
// natively, so the only thing that ever blocked this was the hardcoded PDF
// media type. Images use an "image" block; PDFs use a "document" block.
const UPLOAD_IMAGE_TYPES = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

function buildUploadBlock(mimetype, filename, base64) {
  const mime = String(mimetype || '').toLowerCase();
  const imageType = UPLOAD_IMAGE_TYPES[mime]
    || (/\.(png|jpe?g|gif|webp)$/i.test(filename || '')
        ? UPLOAD_IMAGE_TYPES['image/' + String(filename).split('.').pop().toLowerCase().replace(/^jpg$/, 'jpeg')]
        : null);
  if (imageType) {
    return { block: { type: 'image', source: { type: 'base64', media_type: imageType, data: base64 } }, kind: 'image' };
  }
  return { block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }, kind: 'pdf' };
}

app.post('/api/calendars/add-pdf', requireAuth, upload.single('pdf'), async (req, res) => {
  const { name, memberId } = req.body;
  const instructions = String(req.body.instructions || '').trim();
  // Three ways in now: a file, a typed instruction, or both. Only the
  // combination of neither is an error.
  if (!req.file && !instructions) return res.status(400).json({ error: 'Attach a file or describe the event' });
  if (!name) return res.status(400).json({ error: 'Calendar name is required' });
  const pdfPath = req.file?.path;
  // Declared out here because the catch block needs it too, and it is derived
  // from the request rather than from anything parsed inside the try.
  const sourceNoun = !req.file ? 'instruction'
    : /^image\//i.test(req.file.mimetype || '') || /\.(png|jpe?g|gif|webp)$/i.test(req.file.originalname || '') ? 'image'
    : 'PDF';
  try {
    let pdfBlock = null;
    let kind = 'text';
    if (req.file) {
      const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
      ({ block: pdfBlock, kind } = buildUploadBlock(req.file.mimetype, req.file.originalname, pdfBase64));
    }
    const label = kind === 'image' ? 'screenshot of a school/family/league calendar' : 'school/family calendar PDF';
    const today = new Date().toISOString().split('T')[0];

    // The user's own words outrank anything read out of the document. If they
    // say "1pm-2pm, weekly" and the flyer says otherwise, they are correcting
    // the flyer — that is the entire reason the box exists.
    const instructionText = instructions ? `
The user typed this instruction, and it takes priority over anything in the attached file. Apply it to every event you produce unless they clearly meant it for only one:

"${instructions}"

If they gave a time, a duration, or said the event repeats, use that. If they named people to invite, put each of their names in the "attendees" array. If they described an event that is not in any attached file, create it from their words alone.
` : '';

    const sourceText = req.file
      ? `This is a ${label}. Today is ${today}. Only include events from today onward.\n\nIf the source shows dates without a year, infer the year from the weekday when one is given (for example "Saturday, January 9th" only matches a year in which January 9th is a Saturday), and otherwise choose the next occurrence after today.\n${instructionText}`
      : `Today is ${today}. Create calendar events from the user's instruction below. There is no attached file — their words are the only source. Only include events from today onward, and if they name a date without a year choose the next occurrence after today.\n${instructionText}`;

    const content = [];
    if (pdfBlock) content.push(pdfBlock);
    content.push({ type: 'text', text: `${sourceText}\n\n${FULL_EXTRACTION_PROMPT}` });

    const response = await callClaude(req.user.email, {
      model: 'claude-fable-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    }, 'upload-extract');
    // Closure detection reads a document for "school closed" ranges. With no
    // document there is nothing to read, so skip the call rather than spend a
    // round trip proving a typed sentence contains no closure calendar.
    const closures = pdfBlock ? await extractClosures(pdfBlock, today, req.user.email) : [];
    const removals = closures.length
      ? matchClosuresToEvents(closures, await liveCalendarEvents(req.user.email))
      : [];

    const text = getResponseText(response);
    let flatEvents;
    try {
      const raw = JSON.parse(text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim());
      flatEvents = Array.isArray(raw) ? raw : [];
    } catch { return res.status(500).json({ error: `AI could not parse this ${sourceNoun}.` }); }
    // A closure list produces no additions and that is a success, not a
    // failure — it is the whole point of uploading one. Only error when the
    // document had no effect on the calendar at all.
    if (!flatEvents.length && !removals.length) {
      return res.status(400).json({ error: sourceNoun === 'instruction'
        ? 'Could not work out an event from that. Try including a date, like "lunch with Maya Aug 30 at 2pm".'
        : `No events found in this ${sourceNoun}` });
    }
    if (!flatEvents.length) {
      return res.json({ ok: true, calendarId: null, totalEvents: 0, categories: [], removals });
    }
    flatEvents = collapseMultiDayRuns(flatEvents);

    // Group flat events into categories by source_type for the category-selection screen
    const catMap = new Map();
    for (const ev of flatEvents) {
      const catName = ev.source_type === 'deadline' ? 'Deadlines'
        : ev.source_type === 'action_item' ? 'Action Items'
        : ev.source_type === 'financial_reminder' ? 'Financial Reminders'
        : 'Events';
      if (!catMap.has(catName)) catMap.set(catName, []);
      catMap.get(catName).push(ev);
    }
    const parsed = { categories: Array.from(catMap.entries()).map(([n, evs]) => ({ name: n, events: evs })) };

    // "add bharat to it" comes back as a bare name, and the calendar write only
    // keeps attendees that have an email — so without this the person the user
    // explicitly asked for is dropped without a word. Match names against the
    // people they have already saved; never invent an address for a name we do
    // not recognise, because that is a real email to a possibly wrong person.
    const savedPeople = await getSavedRecipients(req.user.email);
    // The account owner is not a guest. An invitation addressed to her comes
    // back with her own name as an attendee, which matched nobody in Family
    // (she is not in her own family list) and produced a warning that she had
    // not been invited to her own event — alarming, wrong, and it buried the
    // real problem underneath it. Never treat the owner as an unmatched name.
    const ownerNames = new Set([
      String(req.user.name || '').trim().toLowerCase(),
      String(req.user.email || '').split('@')[0].toLowerCase(),
    ].filter(Boolean));
    const unmatchedNames = new Set();
    const resolveAttendees = (list) => {
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const a of list) {
        const email = String(a?.email || '').trim().toLowerCase();
        if (email.includes('@')) { out.push({ email, name: a.name || '' }); continue; }
        const name = String(a?.name || a || '').trim().toLowerCase();
        if (!name) continue;
        const hit = savedPeople.find(p =>
          String(p.name || '').trim().toLowerCase() === name ||
          String(p.email || '').split('@')[0].toLowerCase() === name);
        if (hit) out.push({ email: hit.email, name: hit.name || '' });
        else if (ownerNames.has(name)) out.push({ email: req.user.email, name: req.user.name || '' });
        else unmatchedNames.add(String(a?.name || a || '').trim());
      }
      return out;
    };

    const calId = randomUUID();
    const totalEvents = flatEvents.length;
    const cals = getUserCalendars(req.user.email);
    await cals.set(calId, { id: calId, name, source: req.file ? 'pdf' : 'typed', url: req.file?.originalname || (instructions.slice(0, 80) || 'typed entry'), memberId: memberId || null, event_count: 0, created_at: new Date().toISOString() });
    const events = getUserEvents(req.user.email);
    const eventPairs = [];
    for (const cat of parsed.categories) {
      for (const ev of (cat.events || [])) {
        const evId = randomUUID();
        const norm = normalizeExtractedEvent(ev);
        const conflictNote = await findConflict(events, ev.date, norm.time, norm.end_time);
        // The conflict is stored separately in conflict_note and rendered on its own
        // line, so folding it into notes as well printed the same warning twice.
        const combinedNotes = norm.notes || null;
        eventPairs.push([evId, { id: evId, calendar_id: calId, title: ev.title, ...norm, notes: combinedNotes, conflict_note: conflictNote || null, attendees: resolveAttendees(ev.attendees), category: cat.name, source: name, status: 'draft', created_at: new Date().toISOString() }]);
      }
    }
    await events.setMany(eventPairs);
    if (pdfPath) { try { fs.unlinkSync(pdfPath); } catch {} }
    res.json({
      ok: true, calendarId: calId, totalEvents,
      categories: parsed.categories.map(c => ({ name: c.name, count: c.events?.length || 0 })),
      removals,
      // Surfaced so the user finds out on the review page that the person they
      // named is not in their saved people, instead of discovering it when the
      // invite never arrives.
      unmatchedNames: [...unmatchedNames],
    });
  } catch (err) {
    console.error('Upload/instruction error:', err);
    if (pdfPath) { try { fs.unlinkSync(pdfPath); } catch {} }
    res.status(500).json({ error: `Failed to process this ${sourceNoun}: ` + err.message });
  }
});

// POST /api/calendars/apply-removals — skip the dates the user approved.
// Body: { removals: [{ eventId, dates: ["YYYY-MM-DD", ...] }] }
//
// Nothing is removed until this is called, and only the dates listed here are
// touched. A series keeps running; a one-off event is deleted outright.
app.post('/api/calendars/apply-removals', requireAuth, async (req, res) => {
  const removals = Array.isArray(req.body?.removals) ? req.body.removals : [];
  if (!removals.length) return res.status(400).json({ error: 'Nothing to apply' });

  const store = getUserEvents(req.user.email);
  const auth = await getUserOAuthClient(req.user);
  const calendar = google.calendar({ version: 'v3', auth });
  const removalTz = await getUserTimezone(req.user.email);

  let skipped = 0;
  const failures = [];
  for (const r of removals) {
    const ev = await store.get(r.eventId);
    if (!ev?.calEventId) { failures.push({ eventId: r.eventId, error: 'not on calendar' }); continue; }
    const calId = ev.gcalId || 'primary';
    const dates = (r.dates || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));

    for (const date of dates) {
      try {
        if (ev.recurrence_rule) {
          const ok = await cancelOneOccurrence(calendar, calId, ev.calEventId, date, removalTz);
          if (!ok) { failures.push({ title: ev.title, date, error: 'could not isolate that date' }); continue; }
        } else {
          await calendar.events.delete({ calendarId: calId, eventId: ev.calEventId, sendUpdates: 'none' });
          ev.status = 'cancelled';
        }
        ev.skipped_dates = [...new Set([...(ev.skipped_dates || []), date])];
        skipped++;
      } catch (err) {
        // 410 means it is already gone, which is the state we wanted anyway.
        if (err.code === 410 || err.code === 404) {
          ev.skipped_dates = [...new Set([...(ev.skipped_dates || []), date])];
          skipped++;
        } else {
          failures.push({ title: ev.title, date, error: err.message });
        }
      }
    }
    await store.set(r.eventId, ev);
  }
  res.json({ ok: true, skipped, failures });
});

app.post('/api/calendars/confirm-categories', requireAuth, async (req, res) => {
  const { calendarId, selectedCategories } = req.body;
  if (!calendarId || !selectedCategories) return res.status(400).json({ error: 'Missing data' });
  const events = getUserEvents(req.user.email);
  const auth = await getUserOAuthClient(req.user);
  const calendar = google.calendar({ version: 'v3', auth });
  const targetCalId = await resolveTargetCalendar(req.user.email);
  const cals = getUserCalendars(req.user.email);
  const calSrc = await cals.get(calendarId);
  const colorId = await resolveEventColor(req.user.email, null, calSrc);
  const catTz = await getUserTimezone(req.user.email);
  // A write that throws left the event as 'pending' and was reported nowhere:
  // the user approved ten events, was told ten were added, and found nine on
  // the calendar. Duplicates were equally invisible. Count both and say so.
  let addedCount = 0, failedCount = 0, duplicateCount = 0, lastWriteError = '';
  const updates = [];
  for (const [id, ev] of await events.entries()) {
    if (ev.calendar_id === calendarId && ev.status === 'draft') {
      if (selectedCategories.includes(ev.category)) {
        try {
          const calEventId = await autoWriteToCalendar(calendar, targetCalId, ev, colorId, { timezone: catTz });
          if (!calEventId) {
            // Already on a calendar — nothing written, so don't claim it was.
            ev.status = 'duplicate'; ev.reviewed = false;
            ev.duplicate_of_calendar = true;
            ev.conflict_note = calDupNote(ev.duplicate_of || { title: ev.title }, targetCalId);
            ev.calEventId = null; ev.gcalId = null;
            duplicateCount++;
          } else {
            ev.status = 'added'; ev.reviewed = false;
            ev.calEventId = calEventId; ev.gcalId = targetCalId;
            ev.approved_at = new Date().toISOString();
            addedCount++;
          }
          delete ev.duplicate_of;
        } catch (err) {
          console.error(`confirm-categories GCal write failed for "${ev.title}":`, err.message);
          ev.status = 'pending'; // fallback if GCal write fails
          failedCount++;
          lastWriteError = err.message || 'calendar write failed';
        }
      } else {
        ev.status = 'rejected';
        await recordRefusal(req.user.email, ev, 'category-rejected');
      }
      updates.push([id, ev]);
    }
  }
  await events.setMany(updates);
  const cal = await cals.get(calendarId);
  if (cal) { cal.event_count = addedCount; await cals.set(calendarId, cal); }
  res.json({ ok: true, addedCount, failedCount, duplicateCount, lastWriteError: summariseApiError(lastWriteError) });
});

// Returns the full draft event list for a calendar (not just name+count), so
// the category screen can render expandable, type-aware rows per group.
app.get('/api/calendars/:calendarId/draft-events', requireAuth, async (req, res) => {
  const { calendarId } = req.params;
  const events = getUserEvents(req.user.email);
  const draftEvents = (await events.values())
    .filter(e => e.calendar_id === calendarId && e.status === 'draft')
    .sort((a, b) => (a.date || '') > (b.date || '') ? 1 : -1);
  res.json(draftEvents);
});

// Adds a set of people to every draft event in one category, so a single
// "Add people" field on the group card applies to the whole group at once.
app.post('/api/calendars/group-add-people', requireAuth, async (req, res) => {
  const { calendarId, category, people } = req.body;
  if (!calendarId || !category || !Array.isArray(people)) return res.status(400).json({ error: 'Missing data' });
  const events = getUserEvents(req.user.email);
  const updates = [];
  for (const [id, ev] of await events.entries()) {
    if (ev.calendar_id === calendarId && ev.category === category && ev.status === 'draft') {
      const existing = ev.attendees || [];
      const merged = [...existing];
      for (const p of people) {
        if (p.email && !merged.find(m => m.email === p.email)) merged.push({ name: p.name || '', email: p.email });
      }
      ev.attendees = merged;
      updates.push([id, ev]);
    }
  }
  await events.setMany(updates);
  res.json({ ok: true, updatedCount: updates.length });
});

// Bulk-adds every draft event in one category straight to Google Calendar,
// skipping the individual review queue. Continues past per-event failures
// (e.g. a single bad date) so one bad event doesn't block the rest of the
// group — failures are reported back for the user to review individually.
// Apply one field to every draft event in a group.
//
// An imported schedule usually carries dates but no times — the times live on
// a different page of the same site. Without this the user retypes the same
// 1:00 PM into nine editors, which is slower than adding the events to Google
// Calendar by hand and destroys the reason to use Criba at all.
//
// This writes through to storage rather than just filling the forms, because
// group-approve reads the stored drafts and never sees the DOM.
const GROUP_APPLY_FIELDS = new Set(['time', 'end_time', 'location', 'title']);

app.post('/api/calendars/group-apply', requireAuth, async (req, res) => {
  const { calendarId, category, field, value } = req.body;
  if (!calendarId || !category) return res.status(400).json({ error: 'Missing data' });
  if (!GROUP_APPLY_FIELDS.has(field)) return res.status(400).json({ error: `Cannot apply "${field}" to a whole group` });

  const events = getUserEvents(req.user.email);
  const all = await events.entries();
  const groupEvents = all.filter(([, ev]) =>
    ev.calendar_id === calendarId && ev.category === category && ev.status === 'draft');
  if (!groupEvents.length) return res.status(404).json({ error: 'No draft events found for this category' });

  const clean = String(value ?? '').trim();
  const updates = [];
  for (const [id, ev] of groupEvents) {
    ev[field] = clean || null;
    // A start time turns an all-day entry into a timed one; clearing it turns
    // it back. Leaving the type stale would render the wrong editor fields and
    // write the wrong kind of calendar entry.
    if (field === 'time') {
      if (clean && (ev.type === 'all_day' || !ev.type)) ev.type = 'timed';
      if (!clean && ev.type === 'timed') { ev.type = 'all_day'; ev.end_time = null; }
    }
    updates.push([id, ev]);
  }
  await events.setMany(updates);
  res.json({ ok: true, updatedCount: updates.length, field, value: clean });
});

app.post('/api/calendars/group-approve', requireAuth, async (req, res) => {
  const { calendarId, category } = req.body;
  if (!calendarId || !category) return res.status(400).json({ error: 'Missing data' });

  // Invitees ticked once at the group level, applied to every event in the
  // group. Same rule as the single-event path: only addresses the user has
  // already saved are honoured, because these become real emails to real
  // people and the request body is not a trustworthy invitee list.
  const groupRecipients = [];
  if (Array.isArray(req.body.recipientEmails) && req.body.recipientEmails.length) {
    const saved = new Set((await getSavedRecipients(req.user.email)).map(r => r.email));
    for (const raw of req.body.recipientEmails) {
      const addr = String(raw || '').trim().toLowerCase();
      if (saved.has(addr) && !groupRecipients.includes(addr)) groupRecipients.push(addr);
    }
  }

  const events = getUserEvents(req.user.email);
  const all = await events.entries();
  const groupEvents = all.filter(([, ev]) => ev.calendar_id === calendarId && ev.category === category && ev.status === 'draft');
  if (!groupEvents.length) return res.status(404).json({ error: 'No draft events found for this category' });

  const auth = await getUserOAuthClient(req.user);
  const calendar = google.calendar({ version: 'v3', auth });

  // Resolve target calendar + event color (single-calendar model, test mode overrides)
  const cals = getUserCalendars(req.user.email);
  const calSrc = await cals.get(calendarId);
  const targetCalId = await resolveTargetCalendar(req.user.email);
  const colorId = await resolveEventColor(req.user.email, null, calSrc);
  const groupTz = await getUserTimezone(req.user.email);

  let addedCount = 0;
  const failed = [];
  const updates = [];
  for (const [id, ev] of groupEvents) {
    try {
      if (!ev.date) throw new Error('Missing date');
      const catSpan = resolveRecurringSpan(ev.recurrence_rule, ev.date, ev.end_date, ev.recurrence_end_date);
      const { start, end } = buildCalendarTimes(ev.date, ev.time, catSpan.endDate, ev.end_time, groupTz);
      const eventAttendees = (ev.attendees || []).filter(a => a.email).map(a => ({ email: a.email }));
      for (const addr of groupRecipients) {
        if (!eventAttendees.some(a => String(a.email).toLowerCase() === addr)) eventAttendees.push({ email: addr });
      }
      const description = buildEventDescription(ev);
      const resource = { summary: ev.title, location: ev.location || '', start, end, attendees: eventAttendees, description };
      if (ev.recurrence_rule) resource.recurrence = [ensureRecurrenceEnd(ev.recurrence_rule, ev.date, catSpan.recurrenceEndDate)];
      if (colorId) resource.colorId = String(colorId);
      // Ticking an invitee is a request to notify them — silent invites defeat
      // the point. Without invitees, stay quiet as before.
      const sendUpdates = groupRecipients.length ? 'all' : 'none';
      // Approving a whole category is still a write, and it skipped the
      // duplicate check every other write path performs — so approving the
      // same group twice put two of everything on the calendar. If it is
      // already there, adopt the existing event rather than adding a rival.
      const already = await findExistingOnAnyCalendar(calendar, targetCalId, {
        title: ev.title, date: ev.date, time: ev.time || '',
      });
      if (already?.id) {
        ev.status = 'added';
        ev.reviewed = false;
        ev.calEventId = already.recurringEventId || already.id;
        ev.gcalId = already.calendarId || targetCalId;
        ev.approved_at = new Date().toISOString();
        updates.push([id, ev]);
        console.log(`[calendar-dedup] SKIP (group-approve) "${ev.title}" on ${ev.date}`);
        continue;
      }
      const calEvent = await calendar.events.insert({ calendarId: targetCalId, sendUpdates, resource });
      noteWrittenToCache(targetCalId, ev.date, {
        id: calEvent.data.id, recurringEventId: null, title: ev.title, date: ev.date,
        time: ev.time || '', end_time: ev.end_time || '', is_all_day: !ev.time,
      });
      ev.status = 'added';
      ev.reviewed = false;
      ev.calEventId = calEvent.data.id;
      ev.gcalId = targetCalId;
      ev.approved_at = new Date().toISOString();
      updates.push([id, ev]);
      addedCount++;
    } catch (err) {
      console.error(`Group-approve failed for event ${id}:`, err.message);
      failed.push({ id, title: ev.title, error: err.message });
    }
  }
  await events.setMany(updates);
  if (addedCount > 0) {
    const cal = await cals.get(calendarId);
    if (cal) { cal.event_count = (cal.event_count || 0) + addedCount; await cals.set(calendarId, cal); }
  }
  res.json({ ok: true, addedCount, failed });
});

// group-review now writes to calendar immediately (same as group-approve) —
// there is no pre-write review queue in the new flow.
app.post('/api/calendars/group-review', requireAuth, async (req, res) => {
  const { calendarId, category } = req.body;
  if (!calendarId || !category) return res.status(400).json({ error: 'Missing data' });
  // Delegate to group-approve logic by forwarding as group-approve
  const events = getUserEvents(req.user.email);
  const all = await events.entries();
  const groupEvents = all.filter(([, ev]) => ev.calendar_id === calendarId && ev.category === category && ev.status === 'draft');
  if (!groupEvents.length) return res.status(404).json({ error: 'No draft events found for this category' });
  const auth = await getUserOAuthClient(req.user);
  const calendar = google.calendar({ version: 'v3', auth });
  const cals = getUserCalendars(req.user.email);
  const calSrc = await cals.get(calendarId);
  const targetCalId = await resolveTargetCalendar(req.user.email);
  const colorId = await resolveEventColor(req.user.email, null, calSrc);
  let count = 0, failedCount = 0, lastWriteError = '';
  const updates = [];
  for (const [id, ev] of groupEvents) {
    try {
      if (!ev.date) throw new Error('Missing date');
      const calEventId = await autoWriteToCalendar(calendar, targetCalId, ev, colorId, { timezone: groupTz });
      if (!calEventId) {
        ev.status = 'duplicate'; ev.reviewed = false;
        ev.duplicate_of_calendar = true;
        ev.conflict_note = `Already on your calendar as "${ev.duplicate_of?.title || ev.title}" — not added again`;
        ev.calEventId = null; ev.gcalId = null;
        delete ev.duplicate_of;
        updates.push([id, ev]);
        continue;
      }
      delete ev.duplicate_of;
      ev.status = 'added'; ev.reviewed = false;
      ev.calEventId = calEventId; ev.gcalId = targetCalId;
      ev.approved_at = new Date().toISOString();
      updates.push([id, ev]); count++;
    } catch (err) {
      console.error(`group-review write failed for "${ev.title}":`, err.message);
      // Logged to a console the user cannot see and reported nowhere, so a
      // write that failed was indistinguishable from an event that was never
      // selected. Count it and hand back the reason.
      failedCount++;
      lastWriteError = err.message || 'calendar write failed';
    }
  }
  await events.setMany(updates);
  if (count > 0) {
    const cal = await cals.get(calendarId);
    if (cal) { cal.event_count = (cal.event_count || 0) + count; await cals.set(calendarId, cal); }
  }
  res.json({ ok: true, count, failedCount, lastWriteError: summariseApiError(lastWriteError) });
});

// Dismisses every draft event in one category at once (category-level
// Dismiss button on the collapsed group card) — none of that group's
// events will ever reach Calendar or the review queue. No confirmation
// step by design; matches the single-event dismiss's "just gone" behavior.
app.post('/api/calendars/group-dismiss', requireAuth, async (req, res) => {
  const { calendarId, category } = req.body;
  if (!calendarId || !category) return res.status(400).json({ error: 'Missing data' });
  const events = getUserEvents(req.user.email);
  let count = 0;
  const updates = [];
  for (const [id, ev] of await events.entries()) {
    if (ev.calendar_id === calendarId && ev.category === category && ev.status === 'draft') {
      ev.status = 'dismissed';
      await recordRefusal(req.user.email, ev, 'group-dismiss');
      updates.push([id, ev]);
      count++;
    }
  }
  await events.setMany(updates);
  res.json({ ok: true, count });
});

// ── Family member management ───────────────────────────────────────────────
// Each user maintains a list of family members (e.g. Aarav, Arin). Each member
// gets a dedicated, color-coded Google Calendar so events are visually separated.

app.get('/api/family', requireAuth, async (req, res) => {
  res.json(await getUserFamily(req.user.email).values());
});

app.post('/api/family', requireAuth, async (req, res) => {
  const { name, color, eventColor, grade, circle, email, activities, senders } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = randomUUID();
  // Grade is stored as the user typed it ("3rd", "K", "TK", "9") and normalised
  // at comparison time, so nothing is lost if they type something unexpected.
  // email is optional — captured when a person is added from a Google contact, so
  // they can be invited to events later; null when the person was typed by hand.
  const member = { id, name: name.trim(), color: color || '7', eventColor: eventColor || color || '7', grade: (grade || '').trim() || null, circle: normalizeCircle(circle), email: (email || '').trim().toLowerCase() || null, googleCalendarId: null, activities: normalizeActivities(activities), senders: normalizeSenders(senders) };
  await getUserFamily(req.user.email).set(id, member);
  res.json(member);
});

app.patch('/api/family/:id', requireAuth, async (req, res) => {
  const fam = getUserFamily(req.user.email);
  const member = await fam.get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) member.name = req.body.name.trim();
  if (req.body.color) member.color = req.body.color;
  if (req.body.eventColor) member.eventColor = req.body.eventColor;
  // Explicit undefined check: '' is how the UI clears a grade back to unset,
  // and a truthiness test would make clearing impossible.
  if (req.body.grade !== undefined) member.grade = String(req.body.grade).trim() || null;
  // Same explicit-undefined rule as grade: a member can be moved between circles,
  // and normalizeCircle keeps the field from ever landing empty.
  if (req.body.circle !== undefined) member.circle = normalizeCircle(req.body.circle);
  if (req.body.email !== undefined) member.email = String(req.body.email).trim().toLowerCase() || null;
  // Same explicit-undefined rule: [] is how the UI removes every activity, and
  // a facts store you cannot empty is a facts store you cannot correct.
  if (req.body.activities !== undefined) member.activities = normalizeActivities(req.body.activities);
  if (req.body.senders !== undefined) member.senders = normalizeSenders(req.body.senders);
  await fam.set(req.params.id, member);
  res.json(member);
});

app.delete('/api/family/:id', requireAuth, async (req, res) => {
  await getUserFamily(req.user.email).delete(req.params.id);
  res.json({ ok: true });
});

// ── User settings (test mode, etc.) ───────────────────────────────────────

app.get('/api/settings', requireAuth, async (req, res) => {
  const settings = getUserSettings(req.user.email);
  const testCalendarId = (await settings.get('testCalendarId')) || null;
  const partnerEmail = (await settings.get('partnerEmail')) || null;
  const aheadDays = normalizeAheadDays(await settings.get('aheadDays'));
  res.json({ testCalendarId, partnerEmail, aheadDays, recipients: await getSavedRecipients(req.user.email) });
});

// ── What's Ahead ──────────────────────────────────────────────────────────
//
// Read live from Google Calendar, never from Criba's own event records.
//
// That is the whole point of this screen. People move a practice, shorten a
// dinner, delete the thing that got cancelled — all of it in Google, none of it
// back through Criba. A view built on what Criba once wrote would show a
// confident, tidy, wrong week, which is worse than showing nothing.
//
// Criba's records are still consulted, but only ever to answer "whose is this",
// which is a question about learning rather than about what is happening.
const AHEAD_WINDOWS = [7, 14, 30];
const AHEAD_DEFAULT_DAYS = 14;
// Only how much of the calendar this one screen displays. It has no effect on
// what gets extracted or written, which is deliberately uncapped.
function normalizeAheadDays(raw) {
  const n = parseInt(raw, 10);
  return AHEAD_WINDOWS.includes(n) ? n : AHEAD_DEFAULT_DAYS;
}

async function fetchCalendarWindow(calendarApi, cal, timeMin, timeMax) {
  try {
    const resp = await calendarApi.events.list({
      calendarId: cal.id,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,      // a weekly practice should appear on each of its
      orderBy: 'startTime',    // dates, not once as a rule
      maxResults: 250,
      fields: 'items(id,summary,location,start,end,colorId,status,htmlLink)',
    });
    return (resp.data.items || [])
      .filter(it => it.status !== 'cancelled')
      .map(it => ({
        id: it.id,
        title: it.summary || '(no title)',
        location: it.location || '',
        date: it.start?.date || (it.start?.dateTime || '').slice(0, 10),
        time: it.start?.dateTime ? it.start.dateTime.slice(11, 16) : '',
        end_time: it.end?.dateTime ? it.end.dateTime.slice(11, 16) : '',
        is_all_day: !!it.start?.date,
        colorId: it.colorId ? String(it.colorId) : null,
        htmlLink: it.htmlLink || null,
        calendarId: cal.id,
        calendarName: cal.name || cal.id,
      }))
      .filter(e => e.date);
  } catch (err) {
    // One unreadable calendar must not blank the whole screen.
    console.error(`[ahead] events.list failed for ${cal.id}:`, err.message);
    return [];
  }
}

// The same fixture published by a club feed and written by Criba is one thing
// happening, not two. Showing both would make a calm view look like a mess and
// would invent a conflict with itself.
function dedupeAheadEvents(events) {
  const out = [];
  for (const ev of events) {
    const twin = out.find(x => x.date === ev.date
      && x.is_all_day === ev.is_all_day
      && titlesLooselyMatch(x.title, ev.title)
      && (!x.time || !ev.time || Math.abs(timeToMinutes(x.time) - timeToMinutes(ev.time)) <= 30));
    if (!twin) { out.push({ ...ev, alsoOn: [] }); continue; }
    // Prefer the copy that carries a colour: that is the one Criba attributed,
    // and it is the only copy that can be shown against a person. Identity has
    // to move as a whole — keeping one copy's id beside the other's calendar
    // name would produce a row that links somewhere it says it is not.
    const swap = !twin.colorId && !!ev.colorId;
    const displaced = swap ? twin.calendarName : ev.calendarName;
    if (swap) {
      twin.colorId = ev.colorId;
      twin.id = ev.id;
      twin.htmlLink = ev.htmlLink;
      twin.calendarId = ev.calendarId;
      twin.calendarName = ev.calendarName;
    }
    if (displaced !== twin.calendarName && !twin.alsoOn.includes(displaced)) twin.alsoOn.push(displaced);
  }
  return out;
}

// Whose is it? Three signals, strongest first, and no new attribution logic:
// what the user explicitly filed, what colour it is wearing, and whether their
// name is written in it.
function attributeCalendarEvent(ev, members, storedByCalEventId) {
  const stored = storedByCalEventId.get(ev.id);
  if (stored?.member_id && members.some(m => m.id === stored.member_id)) {
    return { memberId: stored.member_id, basis: 'filed' };
  }
  if (ev.colorId) {
    const hits = members.filter(m => String(m.eventColor || m.color || '') === ev.colorId);
    // Two people sharing one colour makes the colour meaningless as evidence.
    if (hits.length === 1) return { memberId: hits[0].id, basis: 'colour' };
  }
  const named = matchFamilyMember(members, [], [ev.title, ev.location].filter(Boolean).join(' '));
  if (named) return { memberId: named.id, basis: 'named' };
  return { memberId: null, basis: null };
}

// Two timed things overlapping on the same day. Reported as pairs rather than
// as a note stuck on one event, because a clash belongs to both halves of it.
function findAheadConflicts(events) {
  const byDate = new Map();
  for (const ev of events) {
    if (ev.is_all_day || !ev.time) continue;   // an all-day marker clashes with nothing
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  }
  const out = [];
  for (const [date, list] of byDate) {
    const sorted = list.slice().sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const aEnd = a.end_time ? timeToMinutes(a.end_time) : timeToMinutes(a.time) + 60;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        const bStart = timeToMinutes(b.time);
        if (bStart >= aEnd) break;             // sorted, so nothing later can overlap either
        const bEnd = b.end_time ? timeToMinutes(b.end_time) : bStart + 60;
        if (timeToMinutes(a.time) < bEnd && aEnd > bStart) {
          out.push({ date, a: { id: a.id, title: a.title, time: a.time, memberId: a.memberId },
                            b: { id: b.id, title: b.title, time: b.time, memberId: b.memberId } });
        }
      }
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

// Builds the view. Shared verbatim with the digest — one query, two renderings,
// because a digest that can disagree with the screen is worse than no digest.
async function buildAheadView(user, days) {
  const auth = await getUserOAuthClient(user);
  const calendarApi = google.calendar({ version: 'v3', auth });
  const targetCalId = await resolveTargetCalendar(user.email);
  const timezone = await getUserTimezone(user.email);

  const now = new Date();
  const timeMax = new Date(now.getTime() + days * 86400000);
  // Capped: a household with forty subscribed feeds should not turn one screen
  // into forty API calls on every visit.
  const cals = (await visibleCalendars(calendarApi, targetCalId)).slice(0, 12);
  const raw = (await Promise.all(cals.map(c => fetchCalendarWindow(calendarApi, c, now, timeMax)))).flat();

  const members = await getUserFamily(user.email).values();
  const stored = await getUserEvents(user.email).values();
  const storedByCalEventId = new Map(stored.filter(e => e.calEventId).map(e => [e.calEventId, e]));

  const events = dedupeAheadEvents(raw)
    .map(ev => ({ ...ev, ...attributeCalendarEvent(ev, members, storedByCalEventId) }))
    .sort((a, b) => (a.date + (a.is_all_day ? '' : a.time)).localeCompare(b.date + (b.is_all_day ? '' : b.time)));

  const people = members.map(m => ({
    id: m.id, name: m.name, color: m.eventColor || m.color || null,
    count: events.filter(e => e.memberId === m.id).length,
  }));
  const unassigned = events.filter(e => !e.memberId).length;

  return {
    days, timezone,
    from: now.toISOString(), to: timeMax.toISOString(), generatedAt: now.toISOString(),
    calendarsRead: cals.length,
    people, unassigned,
    events,
    conflicts: findAheadConflicts(events),
  };
}

app.get('/api/ahead', requireAuth, async (req, res) => {
  const settings = getUserSettings(req.user.email);
  const days = req.query.days !== undefined
    ? normalizeAheadDays(req.query.days)
    : normalizeAheadDays(await settings.get('aheadDays'));
  try {
    res.json(await buildAheadView(req.user, days));
  } catch (err) {
    console.error('[ahead] failed:', err.message);
    res.status(502).json({ error: 'Could not read your calendar: ' + err.message });
  }
});

// ── Saved recipients ──────────────────────────────────────────────────────

app.get('/api/recipients', requireAuth, async (req, res) => {
  res.json(await getSavedRecipients(req.user.email));
});

app.post('/api/recipients', requireAuth, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  // These addresses become attendees on real invitations, so a typo mails a
  // stranger. Same guard the single partnerEmail had.
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Not a valid email address' });
  const list = await getSavedRecipients(req.user.email);
  if (list.some(r => r.email === email)) return res.status(409).json({ error: 'Already saved' });
  list.push({ name: name || email.split('@')[0], email });
  await getUserSettings(req.user.email).set('recipients', list);
  res.json(list);
});

app.delete('/api/recipients/:email', requireAuth, async (req, res) => {
  const target = String(req.params.email || '').trim().toLowerCase();
  const list = (await getSavedRecipients(req.user.email)).filter(r => r.email !== target);
  await getUserSettings(req.user.email).set('recipients', list);
  // Clear the legacy single setting too. getSavedRecipients falls back to it
  // when no list exists, so leaving it behind could resurrect the very person
  // just removed.
  await getUserSettings(req.user.email).delete('partnerEmail');
  res.json(list);
});

app.patch('/api/settings', requireAuth, async (req, res) => {
  const settings = getUserSettings(req.user.email);
  const { testCalendarId, partnerEmail, aheadDays } = req.body;
  // Purely a display preference for the What's Ahead screen. Nothing about
  // extraction or calendar writing reads it.
  if (aheadDays !== undefined) await settings.set('aheadDays', normalizeAheadDays(aheadDays));
  if (testCalendarId === null || testCalendarId === '') {
    await settings.delete('testCalendarId');
  } else if (typeof testCalendarId === 'string') {
    await settings.set('testCalendarId', testCalendarId.trim());
  }
  if (partnerEmail === null || partnerEmail === '') {
    await settings.delete('partnerEmail');
  } else if (typeof partnerEmail === 'string') {
    const trimmed = partnerEmail.trim();
    // This address ends up as an attendee on real calendar invites, so a typo
    // mails a stranger. Reject anything that isn't plausibly an address.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'Not a valid email address' });
    }
    await settings.set('partnerEmail', trimmed);
  }
  res.json({ ok: true });
});

// ── Single-calendar migration ──────────────────────────────────────────────
// Moves events from per-person GCal calendars onto the primary calendar with
// event-level color coding, de-duplicates by title+date, then deletes the old
// per-person calendars and clears googleCalendarId from family member records.
app.post('/api/migrate/single-calendar', requireAuth, async (req, res) => {
  const email = req.user.email;
  const auth = await getUserOAuthClient(req.user);
  const calendarApi = google.calendar({ version: 'v3', auth });
  const familyStore = getUserFamily(email);
  const eventsStore = getUserEvents(email);

  const members = await familyStore.values();
  const toMigrate = members.filter(m => m.googleCalendarId);
  if (!toMigrate.length) return res.json({ ok: true, message: 'No per-person calendars found — already using single calendar', moved: 0 });

  // Build de-dup index from existing primary-calendar events in Redis
  const existingEvents = await eventsStore.values();
  const existingKeys = new Set(
    existingEvents
      .filter(e => ['added','approved','reviewed'].includes(e.status))
      .map(e => `${(e.title||'').toLowerCase().trim()}:${e.date}`)
  );

  let moved = 0, skipped = 0;
  const results = [];

  for (const member of toMigrate) {
    const calId = member.googleCalendarId;
    const colorId = member.eventColor || member.color || null;
    let memberMoved = 0, memberSkipped = 0;

    try {
      // Fetch all events from the per-person calendar
      let pageToken;
      const gcalEvents = [];
      do {
        const listRes = await calendarApi.events.list({
          calendarId: calId,
          timeMin: new Date('2024-01-01').toISOString(),
          maxResults: 500,
          singleEvents: true,
          orderBy: 'startTime',
          ...(pageToken ? { pageToken } : {}),
        });
        gcalEvents.push(...(listRes.data.items || []));
        pageToken = listRes.data.nextPageToken;
      } while (pageToken);

      for (const gcalEv of gcalEvents) {
        if (gcalEv.status === 'cancelled') continue;
        const title = gcalEv.summary || 'Untitled';
        const dateStr = gcalEv.start?.date || gcalEv.start?.dateTime?.split('T')[0];
        if (!dateStr) continue;

        const dedupKey = `${title.toLowerCase().trim()}:${dateStr}`;
        if (existingKeys.has(dedupKey)) { memberSkipped++; skipped++; continue; }

        // Copy to primary with person's color
        const newEvResource = {
          summary: title,
          start: gcalEv.start,
          end: gcalEv.end,
          location: gcalEv.location || '',
          description: gcalEv.description || 'Migrated via Criba',
        };
        if (colorId) newEvResource.colorId = String(colorId);

        let newCalEventId = null;
        try {
          const inserted = await calendarApi.events.insert({ calendarId: 'primary', resource: newEvResource });
          newCalEventId = inserted.data.id;
        } catch (insertErr) {
          console.error(`[migrate] Insert failed for "${title}" on ${dateStr}:`, insertErr.message);
          continue;
        }

        // Record in Redis
        const evId = randomUUID();
        const timeStr = gcalEv.start?.dateTime
          ? new Date(gcalEv.start.dateTime).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' })
          : '';
        await eventsStore.set(evId, {
          id: evId, title, date: dateStr, time: timeStr,
          location: gcalEv.location || '',
          status: 'added', reviewed: false,
          calEventId: newCalEventId, gcalId: 'primary',
          source: `migrated:${member.name}`,
          approved_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        });
        existingKeys.add(dedupKey);
        memberMoved++; moved++;
      }

      // Delete the old per-person calendar
      try {
        await calendarApi.calendars.delete({ calendarId: calId });
        console.log(`[migrate] Deleted calendar ${calId} for ${member.name}`);
      } catch (delErr) {
        console.error(`[migrate] Could not delete calendar ${calId} for ${member.name}:`, delErr.message);
      }

      // Update member: set eventColor, clear googleCalendarId
      member.eventColor = member.eventColor || member.color || '7';
      member.googleCalendarId = null;
      await familyStore.set(member.id, member);
      results.push({ member: member.name, moved: memberMoved, skipped: memberSkipped });
    } catch (err) {
      console.error(`[migrate] Error processing ${member.name}:`, err.message);
      results.push({ member: member.name, error: err.message });
    }
  }

  res.json({ ok: true, moved, skipped, results });
});

// ── Gmail push notifications ───────────────────────────────────────────────

// Pre-filter keyword sets — only pay Claude if the email looks calendar-relevant.
// Words are matched as whole tokens (split on \W+); patterns are substring matches.
// The PRD extraction spec includes financial reminders and deadlines as first-class
// calendar events — the word lists below must cover their vocabulary.
const PREFILTER_WORDS = new Set([
  // ── Days / relative time ──────────────────────────────────────────────────
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
  'tomorrow','tonight','today','weekend',
  'next week','this week',

  // ── Months ────────────────────────────────────────────────────────────────
  'january','february','march','april','may','june','july','august',
  'september','october','november','december',

  // ── Events / activities ───────────────────────────────────────────────────
  'meeting','game','practice','rehearsal','appointment','coffee','lunch',
  'dinner','breakfast','pickup','dropoff','tournament','recital','concert',
  'performance','schedule','event','class','session','camp','tryout',
  'orientation','graduation','ceremony','celebration','party','fundraiser',
  'registration','signup','sign-up','open house','info night','information night',

  // ── Deadlines / action items ──────────────────────────────────────────────
  'reminder','deadline','due','overdue','return','submit','submission',
  'assignment','homework','permission','slip','form','rsvp','register',
  'sign up','sign-up','enroll','enrollment','apply','application',
  'last day','final day','cutoff','cut-off','by friday','by monday',

  // ── Financial reminders ───────────────────────────────────────────────────
  'invoice','payment','balance','statement','charge','charged','auto-charge',
  'autopay','auto-pay','bill','billing','tuition','fee','fees','deposit',
  'due date','past due','overdue','refund','receipt','transaction',
]);

// Patterns checked as substrings (not word-boundary matched).
// '$' catches dollar amounts in financial emails.
// 'am'/'pm' catch time references.
const PREFILTER_PATTERNS = ['am', 'pm', "o'clock", '$'];

function passesPreFilter(text) {
  const lower = text.toLowerCase();
  if (PREFILTER_PATTERNS.some(p => lower.includes(p))) return true;
  const words = lower.split(/\W+/);
  return words.some(w => PREFILTER_WORDS.has(w));
}

// Returns the full pre-filter diagnosis — which keyword matched (or why it failed).
// Used by checkPreFilter (for logging) and by the backfill dry-run (for reporting).
function diagnosePreFilter(text) {
  const lower = text.toLowerCase();
  const matchedPattern = PREFILTER_PATTERNS.find(p => lower.includes(p));
  if (matchedPattern) return { pass: true, matchType: 'pattern', matchValue: matchedPattern };
  const words = lower.split(/\W+/);
  const matchedWord = words.find(w => PREFILTER_WORDS.has(w));
  if (matchedWord) return { pass: true, matchType: 'word', matchValue: matchedWord };
  return { pass: false, matchType: null, matchValue: null };
}

// Wrapper used inside processNewGmailEmails — logs the pre-filter decision.
function checkPreFilter(text, subject, messageId, email) {
  const d = diagnosePreFilter(text);
  if (d.pass) {
    console.log(`[prefilter] PASS msg=${messageId} user=${email} subject="${subject}" matched ${d.matchType} "${d.matchValue}"`);
  } else {
    console.log(`[prefilter] SKIP msg=${messageId} user=${email} subject="${subject}" — no calendar keywords found`);
  }
  return d.pass;
}

// Parse "Name <email>" or "email" from a From header
function parseFrom(fromHeader) {
  const match = fromHeader.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) return { senderName: match[1].replace(/^"|"$/g, '').trim(), senderEmail: match[2].trim() };
  return { senderName: '', senderEmail: fromHeader.trim() };
}

// Recursively find plain-text body in Gmail message payload
function stripHtmlTags(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

function _extractEmailBodyInner(payload, htmlParts) {
  // Inline body on a single-part message
  if (payload.body?.data) {
    const text = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    if (payload.mimeType === 'text/html') {
      htmlParts.push(text);
      return '';
    }
    return text;
  }

  // Collect HTML parts at this level FIRST. The plain-text loop below returns
  // as soon as it finds a candidate, so collecting afterwards meant the caller
  // was handed an empty htmlParts and had no alternative to compare against —
  // exactly the case where the plain part is boilerplate and the HTML holds
  // the event.
  for (const part of (payload.parts || [])) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      htmlParts.push(Buffer.from(part.body.data, 'base64url').toString('utf-8'));
    }
  }

  // Usable plain-text part at this level
  for (const part of (payload.parts || [])) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      const text = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      if (text.trim().length > 50) return text;
    }
  }

  // Recurse into nested multipart containers
  for (const part of (payload.parts || [])) {
    if (part.mimeType && part.mimeType.startsWith('multipart/')) {
      const text = _extractEmailBodyInner(part, htmlParts);
      if (text) return text;
    }
  }

  // Recurse into other non-HTML leaf parts
  for (const part of (payload.parts || [])) {
    if (!part.mimeType?.startsWith('multipart/') && part.mimeType !== 'text/html') {
      const text = _extractEmailBodyInner(part, htmlParts);
      if (text) return text;
    }
  }

  return '';
}

// Picking between the plain-text and HTML alternatives of the same email is
// not a matter of preference — it decides whether the event details reach
// Claude at all.
//
// Transactional senders (clinics, ticketing, schools using a mail service)
// routinely ship a plain-text part that is pure boilerplate — "view this in a
// browser", an unsubscribe block, a privacy notice — while the appointment
// itself exists only in the HTML. That stub clears any length threshold, so
// taking the first plain-text part meant confidently handing Claude a body
// with no date in it and recording "no events found".
//
// So: take the plain text only when it actually carries date content, or when
// the HTML has none either. Otherwise fall through to the HTML.
// ── Quoted history ────────────────────────────────────────────────────────
//
// A forwarded thread arrives as one flat wall of text: the new message on top
// and every prior message underneath, with nothing marking where one ends and
// the next begins. Claude reads the lot and extracts from all of it, so a
// school chasing a form produces two events — the original request and the
// chase — which then land on the same date because a single inference is
// applied to a body whose real structure was invisible.
//
// It is worse than duplicates. Every forward re-presents old content as new, so
// events already handled come back.
//
// Markers are matched at line starts only. "On" and "From:" appear mid-sentence
// constantly; as the first thing on a line, followed by what a mail client puts
// there, they are reliable.
const QUOTE_MARKERS = [
  // Gmail/Apple: "On Mon, Aug 31, 2026 at 3:07 PM Someone <x@y.com> wrote:"
  // The attribution often wraps, so allow it to run across a line break.
  /^On\s[\s\S]{0,300}?\bwrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/mi,
  /^-{2,}\s*Forwarded message\s*-{2,}/mi,
  /^Begin forwarded message:/mi,
  // Outlook's divider, then its header block.
  /^_{5,}\s*$/m,
  /^From:\s.*\r?\n\s*(?:Sent|Date|To):/mi,
  // A run of quoted lines with no preceding marker.
  /^>{1,}\s?\S/m,
];

function firstQuoteIndex(text) {
  let best = -1;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

// Below this, what remains above the quote is a greeting and a signature — not
// something anyone forwarded for its own sake.
const MIN_NEW_CONTENT_CHARS = 40;

function stripQuotedHistory(text) {
  const src = String(text || '');
  const cut = firstQuoteIndex(src);
  if (cut === -1) return src;

  const head = src.slice(0, cut).trim();
  if (head.length >= MIN_NEW_CONTENT_CHARS) return head;

  // Nothing of substance on top — a bare forward, which for a school notice is
  // the ordinary case, not an edge case. Dropping these would lose real events.
  // So fall back to the newest quoted message alone: everything from the first
  // marker up to the second. The rest of the chain is older still and is
  // exactly what was generating repeats.
  const rest = src.slice(cut);
  const firstLineEnd = rest.indexOf('\n');
  const afterMarker = firstLineEnd === -1 ? '' : rest.slice(firstLineEnd + 1);
  // Strip the ">" prefixes BEFORE looking for the next boundary. One of the
  // markers is a run of quoted lines, so leaving them in place made the very
  // message being kept look like the start of the older chain — the boundary
  // landed at offset zero and the whole quote was discarded.
  const afterUnquoted = afterMarker.replace(/^\s*>+ ?/gm, '');
  const nextCut = firstQuoteIndex(afterUnquoted);
  const unquoted = (nextCut === -1 ? afterUnquoted : afterUnquoted.slice(0, nextCut)).trim();
  // Keep the short note as well as the quoted message. "Practice moved to 4pm"
  // is under the threshold and is the single most important line in the mail —
  // discarding it in favour of the thread it corrects would invert the point.
  if (!unquoted) return head || src;
  return head ? `${head}\n\n${unquoted}` : unquoted;
}

// Gmail wraps quoted history in a container. Removing it in HTML is far more
// reliable than pattern-matching the text after the tags are gone, so this runs
// first and the text-level markers act as backstop.
function stripQuotedHtml(html) {
  return String(html || '')
    .replace(/<blockquote[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i, '')
    .replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i, '')
    .replace(/<div[^>]*id="appendonsend"[\s\S]*$/i, '')
    .replace(/<div[^>]*id="divRplyFwdMsg"[\s\S]*$/i, '');
}

function extractEmailBody(payload) {
  const htmlParts = [];
  const plainTextRaw = _extractEmailBodyInner(payload, htmlParts);
  // Quoted history is removed before anything else looks at the body, so every
  // downstream decision — dates, relevance, attribution — sees only the message
  // that actually arrived.
  const plainText = stripQuotedHistory(plainTextRaw);
  const html = htmlParts.length
    ? stripQuotedHistory(stripHtmlTags(stripQuotedHtml(htmlParts.join('\n'))))
    : '';

  if (plainText && html) {
    const plainHasDate = scanForDateContent(plainText).pass;
    if (plainHasDate) return plainText;
    // The plain part looks like boilerplate. Use the HTML if it does better;
    // if neither has a date, the plain text is still the cleaner input.
    if (scanForDateContent(html).pass) return html;
    return plainText;
  }
  return plainText || html || '';
}

// Image MIME types Claude's vision API accepts
const VISION_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
// Claude reads a PDF as well as it reads a photo — the upload path has sent
// them as document blocks all along. Only the email path was image-only, so a
// school that attached its calendar as a PDF (most of them) had that PDF
// ignored, and if the covering note carried no date the whole mail was dropped
// without anything being read. The media type was the entire blind spot.
const VISION_DOC_TYPES = new Set(['application/pdf']);
const VISION_PART_TYPES = new Set([...VISION_IMAGE_TYPES, ...VISION_DOC_TYPES]);

// Recursively collect image parts from the MIME tree (inline + attached).
// Returns raw descriptor objects — no data fetching here.
// An email whose real content is a flyer image. The threshold used to be 300
// characters, which almost no real email clears: a school flyer arrives with
// a greeting, a sign-off and an unsubscribe footer wrapped around the image,
// and that boilerplate alone runs past 300. Such mail failed the text filter
// (no date in the words) AND failed this bypass (too much boilerplate), so it
// was dropped without the picture ever being looked at.
const IMAGE_HEAVY_BODY_MAX = 1500;

function collectImageParts(payload, parts = []) {
  const mime = (payload.mimeType || '').toLowerCase().split(';')[0].trim();
  if (VISION_PART_TYPES.has(mime) && (payload.body?.data || payload.body?.attachmentId)) {
    parts.push({
      mimeType: mime === 'image/jpg' ? 'image/jpeg' : mime,
      inlineData: payload.body.data || null,
      attachmentId: payload.body.attachmentId || null,
      size: payload.body.size || 0,
    });
  }
  for (const part of (payload.parts || [])) collectImageParts(part, parts);
  return parts;
}

// Fetch image data for a message's image parts, returning base64 strings ready
// for the Claude vision API. Caps at 3 images × 1 MB each to bound API call size.
async function fetchEmailImages(payload, gmail, messageId) {
  const MAX_IMAGES = 3;
  // 1 MB was chosen to reject large marketing graphics, on the assumption that
  // anything big is decoration. That is wrong for the case this feature exists
  // to serve: a phone screenshot of an invitation, or a photographed flyer, is
  // routinely 2-4 MB and is the entire content of the email. Such a message was
  // correctly identified as image-heavy, correctly bypassed the text filter,
  // and then had its only image dropped here for size — so Claude was handed an
  // empty body and no picture, returned nothing, and the trace recorded a
  // successful extraction that found no events. Anthropic accepts 5 MB per
  // image; base64 inflates by a third, so 3.5 MB of raw attachment is the
  // practical ceiling.
  const MAX_SIZE_BYTES = 3.5 * 1024 * 1024;
  // A one-megabyte ceiling suits inline images, where anything larger is almost
  // always a marketing graphic. A PDF newsletter is routinely bigger than that
  // and is exactly the thing worth reading, so it gets its own headroom.
  const MAX_DOC_BYTES = 4 * 1024 * 1024;
  const rawParts = collectImageParts(payload);
  const limitFor = (p) => VISION_DOC_TYPES.has(p.mimeType) ? MAX_DOC_BYTES : MAX_SIZE_BYTES;
  const eligible = rawParts
    .filter(p => p.size === 0 || p.size <= limitFor(p))
    // A document is the likelier place for a schedule than a signature logo, so
    // if both are attached the document must not lose its slot to the logo.
    .sort((a, b) => (VISION_DOC_TYPES.has(b.mimeType) ? 1 : 0) - (VISION_DOC_TYPES.has(a.mimeType) ? 1 : 0))
    .slice(0, MAX_IMAGES);
  if (!eligible.length) return [];

  const images = [];
  for (const part of eligible) {
    try {
      let base64data;
      if (part.inlineData) {
        // base64url → standard base64
        base64data = part.inlineData.replace(/-/g, '+').replace(/_/g, '/');
      } else if (part.attachmentId) {
        const res = await gmail.users.messages.attachments.get({
          userId: 'me', messageId, id: part.attachmentId,
        });
        base64data = res.data.data.replace(/-/g, '+').replace(/_/g, '/');
      }
      if (base64data) images.push({ mimeType: part.mimeType, base64data });
    } catch (err) {
      console.error(`[vision] Failed to fetch image for msg=${messageId}:`, err.message);
    }
  }
  const droppedForSize = rawParts.length - eligible.length;
  console.log(`[vision] msg=${messageId} fetched ${images.length} image(s) for vision extraction`
    + (droppedForSize ? ` — ${droppedForSize} attachment(s) skipped as oversized` : ''));
  // The caller needs to tell "there was nothing to read" apart from "there was
  // something and we threw it away", because those look identical downstream.
  images.droppedForSize = droppedForSize;
  return images;
}

// How much of an email body reaches the model. This was 8000 characters, which
// is roughly 2000 tokens — a fraction of the context available, and far less
// than a school newsletter. The West Welcome Back E-Packet was 18,724
// characters: Claude read the first 43% of it, found 11 events there, and never
// saw the deadlines and fees in the rest. The trace called that email a
// success, because everything Claude did return was stored.
//
// Bumping this is the whole fix for "reminders keep getting missed from long
// emails". The cap stays only as a guard against a pathological body.
const EXTRACTION_CHAR_LIMIT = 60000;

// The "have we already extracted this email" key. Three call sites built this
// string independently — the scan path, the cross-user guard and the dry-run
// diagnostic — so a change to one silently stopped matching the others, and the
// diagnostic could report an email as unprocessed while the scanner skipped it.
// One definition.
//
// Versioned by the extraction limit: see the fingerprint note in the scan loop.
function emailFingerprintKey(senderEmail, subject, dateSent) {
  const raw = `${String(senderEmail).toLowerCase()}:${String(subject).trim()}:${String(dateSent).trim()}:v${EXTRACTION_CHAR_LIMIT}`;
  return `processedEmail:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

// A second dedup key, checked before anything is fetched.
//
// emailFingerprintKey needs the sender, subject and date — all of which arrive
// only with the metadata fetch, so discovering "already done" cost the same
// ~450ms as doing the work. The collect loop stops on wall-clock, not on work
// completed, so that made a hard ceiling of roughly 37 messages per scan no
// matter how many scans ran: every scan spent its whole budget re-fetching
// headers for mail it had already processed, and anything deeper was never
// reachable. Gmail's message id comes back free in messages.list, so keying on
// it lets a skip cost nothing and the loop reach the full 150.
//
// This does NOT replace the fingerprint. The fingerprint is versioned on
// EXTRACTION_CHAR_LIMIT so that raising the limit re-reads emails that were
// truncated under the old one. This key therefore carries the same version: a
// bare message id would skip those emails before the fingerprint ever got the
// chance to let them through, silently cancelling the re-read. Both are written
// together, both expire together, and both invalidate together.
function processedMessageKey(email, messageId) {
  return `processedMsg:v${EXTRACTION_CHAR_LIMIT}:${email}:${messageId}`;
}

// Call Claude to extract calendar events from a single email.
// When images are supplied (image-heavy emails / flyers), uses multimodal API.
async function extractGmailEvents(body, senderName, senderEmail, subject, images = [], dateSent = '', familyNames = [], ownerEmail = null) {
  const textContent = [subject ? `Subject: ${subject}\n\n` : '', body].join('').slice(0, EXTRACTION_CHAR_LIMIT);

  // Anchor relative dates. Without this the model sees "Monday" or "August 12"
  // with no year and has to guess, which is what normalizeEventDate was left
  // cleaning up after. The sent date matters more than today's date: "this
  // Friday" means the Friday after the email was sent, not after the scan.
  const sentIso = dateSent ? new Date(dateSent) : null;
  const sentLine = sentIso && !isNaN(sentIso)
    ? `This email was sent on ${sentIso.toISOString().split('T')[0]} (${sentIso.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}).`
    : '';
  const dateContext = [
    `Today's date is ${new Date().toISOString().split('T')[0]}.`,
    sentLine,
    'Resolve every relative date ("Monday", "this Friday", "next week", "the 12th") against the email\'s sent date. Always output a full YYYY-MM-DD with an explicit year — never omit the year or guess one.',
  ].filter(Boolean).join(' ');

  // The prompt asks for "family member name strings", but until now it never
  // said who the family are — so the model had nothing to tag against and
  // returned an empty list, which is why events all came out the default colour.
  const rosterContext = familyNames.length
    ? `This person's family members are: ${familyNames.join(', ')}. For each event, put into "attendees" the names of the family members it concerns — the child whose team, class or activity it is. Infer from the team name, teacher, grade or context even when the name is not written out. Use the exact spelling listed above. Leave the array empty if the event concerns the whole family or you genuinely cannot tell.`
    : '';

  const context = [dateContext, rosterContext].filter(Boolean).join('\n\n');
  const promptText = images.length > 0
    ? `${FULL_EXTRACTION_PROMPT}\n\n${context}\n\nEmail text (may be minimal — event details may be in the attached image(s) or PDF):\n${textContent}`
    : `${FULL_EXTRACTION_PROMPT}\n\n${context}\n\nEmail:\n${textContent}`;

  const messageContent = images.length > 0
    ? [
        { type: 'text', text: promptText },
        ...images.map(img => (VISION_DOC_TYPES.has(img.mimeType)
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: img.base64data } }
          : { type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64data } })),
      ]
    : promptText;

  const response = await callClaude(ownerEmail, {
    model: 'claude-fable-5',
    // 2048 was not enough. The budget is shared with the model's thinking
    // tokens, so a multi-event email (a week of practices, a weekly digest)
    // could spend the whole allowance before finishing the JSON array. The
    // reply came back cut off mid-array and the parse below threw.
    max_tokens: 8192,
    messages: [{ role: 'user', content: messageContent }]
  }, 'gmail-extract');
  const text = getResponseText(response).trim();
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Claude response truncated at max_tokens (${text.length} chars) — event list too long to fit`);
  }
  try {
    const raw = JSON.parse(text.replace(/^```json\s*/,'').replace(/\s*```$/,''));
    const events = Array.isArray(raw) ? raw : [];
    // A promotion is the one class of extraction with no review value. Every
    // other audience is held rather than dropped, because Criba would rather
    // cost a click than miss a school event. That reasoning does not apply to
    // a discount code: there is no version of "Uber Eats 30% off expires" that
    // the user wants on a calendar or in a queue, so showing it held is just
    // noise in the one screen that has to stay worth reading. Dropped here,
    // the single point both the webhook and the backfill pass through.
    const kept = events.filter(ev => {
      if (ev.audience !== 'promotion') return true;
      console.log(`[gmail-extract] DROPPED promotion "${ev.title}" from ${senderEmail || 'unknown sender'}`);
      return false;
    });
    // Inject sender as attendee name string so it shows in the review card
    return kept.map(ev => ({
      ...ev,
      attendees: Array.isArray(ev.attendees)
        ? (ev.attendees.includes(senderName) || !senderName ? ev.attendees : [senderName, ...ev.attendees])
        : (senderName ? [senderName] : []),
    }));
  } catch (err) {
    // Do NOT swallow this into an empty array. An unparseable response is a
    // failure, but returning [] made it look like "this email had no events" —
    // so the caller wrote a 30-day fingerprint and the email was never retried.
    // Throwing records an ERROR in the trace and leaves it eligible next scan.
    console.error('Gmail extraction: JSON parse failed:', text.slice(0, 200));
    throw new Error(`Claude returned unparseable JSON: ${text.slice(0, 120)}`);
  }
}

// Check our Redis event store for an event with the same title+date.
// NOTE: This catches duplicates already managed by Criba. It does NOT check
// events added to Google Calendar outside of Criba (would need a slow GCal
// API call per event).
// Array-based variants. The backfill loop reloaded the entire event store
// three times per extracted event, which dominated its time budget. It now
// loads once and passes the array in, appending as it writes.
// Reduce an RRULE to the part that identifies the series: how often it repeats
// and on which days. "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130" and
// "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=16" describe the same Monday practice —
// they differ only in where the club chose to end it.
// An RRULE with no UNTIL and no COUNT repeats forever. Nobody signs their
// calendar up for a weekly class in perpetuity, and an unbounded series is
// painful to correct later because every future week is already claimed.
//
// So every recurring event gets an end: the one stated in the source when we
// have it, otherwise a conservative default. The default is deliberately short
// — an under-run series shows a gap the user can extend, while an over-run one
// quietly litters years of calendar.
const DEFAULT_RECURRENCE_MONTHS = 12;

function ensureRecurrenceEnd(rule, startDate, endDate) {
  if (!rule) return rule;
  const up = String(rule).toUpperCase();
  if (!/FREQ=/.test(up)) return rule;

  const explicit = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : null;

  // An end date we were given beats one already on the rule. Every recurring
  // event gets a 12-month UNTIL stamped on first write, so "already has an
  // end" was true for essentially every event — and this returned early,
  // silently discarding every end date the user set. A date the user typed
  // must win over one Criba guessed.
  if (explicit) {
    const stripped = String(rule)
      .replace(/;?\b(UNTIL|COUNT)=[^;]*/gi, '')
      .replace(/;+/g, ';')
      .replace(/^;|;$/g, '');
    return `${stripped};UNTIL=${explicit.replace(/-/g, '')}T235959Z`;
  }
  if (/UNTIL=|COUNT=/.test(up)) return rule;

  let until = null;
  if (!until) {
    const base = /^\d{4}-\d{2}-\d{2}$/.test(startDate || '') ? new Date(startDate + 'T00:00:00Z') : new Date();
    base.setUTCMonth(base.getUTCMonth() + DEFAULT_RECURRENCE_MONTHS);
    until = base.toISOString().slice(0, 10);
  }
  // UNTIL is inclusive; use end of day UTC so the final occurrence is kept
  // whatever time of day it falls at.
  return `${String(rule).replace(/;+$/, '')};UNTIL=${until.replace(/-/g, '')}T235959Z`;
}

function recurrenceShape(rule) {
  if (!rule) return null;
  const up = String(rule).toUpperCase();
  const freq = up.match(/FREQ=([A-Z]+)/)?.[1];
  if (!freq) return null;
  const byday = up.match(/BYDAY=([A-Z,]+)/)?.[1] || '';
  return `${freq}|${byday.split(',').sort().join(',')}`;
}

// A duplicate is either the same title on the same date, or — for recurring
// events — the same title at the same time on the same repeating schedule.
//
// The date-only check was not enough. Two emails restating one season's
// practices produced two weekly series with different start dates, so nothing
// matched and both were written. On any given Monday you then saw the same
// practice twice.
// Two extractions of the same real-world event rarely produce byte-identical
// titles. Claude may write "New Patient Visit with Vincent Mason, MD" once and
// "New Patient Visit with Vincent Mason, MD (Sutter Pediatrics)" the next time,
// and a reminder email describes the same appointment in its own words. An
// exact title comparison treats those as different events and the user gets the
// same appointment twice in the review queue.
//
// So titles are compared with titlesLooselyMatch — the same test already used
// to spot an event that is on the calendar. One notion of "same event" for both
// sides is the point: a pair the calendar check would merge must not be a pair
// the queue keeps apart.
// A stored row may only block a new event if that row still represents
// something the user can see and act on. Two ways to qualify:
//
//   1. calEventId is set — the event really is on Google Calendar. Adding it
//      again would be a visible duplicate.
//   2. The status is one the review queue actually renders, so the event is
//      sitting in front of the user awaiting a decision. Adding it again would
//      be a duplicate card.
//
// Everything else is a dead record: a `draft` stranded with no approval path,
// something `cancelled` or `dismissed` by hand, or a row marked `added` /
// `reviewed` whose calendar write never landed. None of those are on screen and
// none are on the calendar, so none can be duplicated — yet before this guard
// they all suppressed incoming email silently, with no queue entry and no log
// beyond a DEDUP SKIP line. That is how a school newsletter goes missing.
//
// Deliberately keyed on calEventId rather than status alone: status records
// what we intended, calEventId records what actually happened, and the 132 rows
// where those disagreed are the whole reason this exists.
const DEDUP_BLOCKING_STATUSES = new Set([
  'pending', 'duplicate', 'pending_cancellation', 'pending_reschedule',
]);

function blocksDuplicate(ev) {
  if (ev.calEventId) return true;
  return DEDUP_BLOCKING_STATUSES.has(ev.status);
}

// Same day counts when the clock time agrees, or when either side has no time
// at all — one extraction saying "9:00" and another saying all-day is still one
// event. Two different times on one day stay distinct, so a class that
// genuinely meets twice in a day survives as two entries.
function sameDayAndTime(ev, date, time) {
  if (ev.date !== date) return false;
  const evTime = ev.time || '';
  return !evTime || !time || evTime === time;
}

function isDuplicateEventIn(all, title, date, opts = {}) {
  const shape = recurrenceShape(opts.recurrence);
  const time = opts.time || '';
  const threadId = opts.threadId || '';
  return all.some(ev => {
    if (!blocksDuplicate(ev)) return false;

    // Same Gmail thread, same day, same time: one event, however it was worded.
    //
    // A reply is where title matching fails hardest. The school sends "Frosh
    // Football — Parents Pregame Gathering", a parent replies "reminder, pregame
    // is Friday at 6", and Claude extracts a title with almost no words in
    // common. titlesLooselyMatch rejects the pair, dedup passes, and the user
    // gets the same gathering twice. Stripping quoted history (0b878c4) does not
    // help: the reply restates the event in its own new words, which is exactly
    // the content we keep.
    //
    // The thread is the strongest same-event signal we have and it costs
    // nothing — Gmail returns threadId on every message and we were discarding
    // it. Deliberately still requires the date and time to agree, so a thread
    // that legitimately announces practice at 4 and team dinner at 7 on one day
    // keeps both. Rewording cannot defeat it; a genuinely different event on a
    // different day or hour is untouched.
    //
    // Runs behind blocksDuplicate like every other clause, so a dead record can
    // no more suppress mail via its thread than via its title.
    if (threadId && ev.thread_id === threadId && sameDayAndTime(ev, date, time)) return true;

    if (!titlesLooselyMatch(ev.title, title)) return false;
    if (sameDayAndTime(ev, date, time)) return true;
    if (!shape) return false;
    return recurrenceShape(ev.recurrence_rule) === shape && (ev.time || '') === time;
  });
}

function findConflictIn(all, date, startTime, endTime) {
  if (!date || !startTime) return null;
  const newStart = timeToMinutes(startTime);
  const newEnd = endTime ? timeToMinutes(endTime) : newStart + 60;
  for (const existing of all) {
    if (existing.date !== date) continue;
    if (existing.status === 'dismissed' || existing.status === 'rejected') continue;
    if (existing.is_all_day || !existing.time) continue;
    const exStart = timeToMinutes(existing.time);
    const exEnd = existing.end_time ? timeToMinutes(existing.end_time) : exStart + 60;
    if (newStart < exEnd && newEnd > exStart) {
      const fmtTime = existing.time.replace(/^0/, '');
      return `⚠️ Conflict: overlaps with "${existing.title}" at ${fmtTime}`;
    }
  }
  return null;
}

// Same rules as resolveEventColorByNames, against an already-loaded roster.
function resolveColorIn(members, nameStrings, text = '') {
  const match = matchFamilyMember(members, nameStrings, text);
  return match?.eventColor || match?.color || null;
}

async function isDuplicateEvent(eventsStore, title, date, opts = {}) {
  const all = await eventsStore.values();
  return isDuplicateEventIn(all, title, date, opts);
}

// Find an approved GCal-backed event that semantically matches a cancellation/reschedule signal.
// Strategy:
//   1. Fuzzy title match (one is a substring of the other, case-insensitive, or ≥60% word overlap)
//   2. Optional date proximity (within 7 days of oldDate if provided)
// Returns the best-matching event object, or null if nothing confident enough is found.
async function findMatchingApprovedEvent(eventsStore, oldTitle, oldDate) {
  if (!oldTitle) return null;
  const all = await eventsStore.values();
  const approved = all.filter(e => (e.status === 'approved' || e.status === 'added' || e.status === 'reviewed') && e.calEventId);
  if (!approved.length) return null;

  const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const needle = normalize(oldTitle);
  const needleWords = new Set(needle.split(' ').filter(w => w.length > 2));

  let best = null;
  let bestScore = 0;

  for (const ev of approved) {
    const haystack = normalize(ev.title);
    const haystackWords = new Set(haystack.split(' ').filter(w => w.length > 2));

    // Substring match
    let score = 0;
    if (haystack.includes(needle) || needle.includes(haystack)) {
      score = 0.9;
    } else {
      // Word overlap
      const intersection = [...needleWords].filter(w => haystackWords.has(w)).length;
      const union = new Set([...needleWords, ...haystackWords]).size;
      score = union > 0 ? intersection / union : 0;
    }

    // Date proximity bonus
    if (oldDate && ev.date) {
      const diff = Math.abs((new Date(oldDate) - new Date(ev.date)) / 86400000);
      if (diff <= 7) score += 0.15;
      else if (diff > 30) score -= 0.3;
    }

    if (score > bestScore) { bestScore = score; best = ev; }
  }

  // Require at least 50% confidence
  if (bestScore < 0.5) return null;
  return { event: best, score: Math.min(1, bestScore) };
}

// Convert "HH:MM" to minutes since midnight for overlap comparison
function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

// ── Existing Google Calendar awareness ─────────────────────────────────────
//
// Criba used to reason only about events it had written itself, so it could not
// see anything already on the calendar — most importantly subscribed feeds like
// a club's published iCal. The club publishes the practice, Criba reads the
// same practice out of the coach's email, and the user gets two identical bars.
// Nothing in Criba's own store looked duplicated, because only one copy was
// ever ours.
//
// One list call covers a whole scan: fetch the date window once, match in
// memory. Per-event API calls would not fit the 60s budget.
async function fetchExistingCalendarEvents(calendarApi, calendarId, dates) {
  const valid = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!valid.length) return [];
  const timeMin = new Date(`${valid[0]}T00:00:00Z`);
  const timeMax = new Date(`${valid[valid.length - 1]}T23:59:59Z`);
  // A window wider than a couple of months means something is wrong with the
  // extracted dates; don't pull the user's entire year in that case.
  const spanDays = (timeMax - timeMin) / 86400000;
  if (spanDays > 120) return [];
  try {
    const resp = await calendarApi.events.list({
      calendarId: calendarId || 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,          // expand recurrence into instances so a
      maxResults: 2500,            // weekly series matches on each date
      // id/recurringEventId let a caller that finds a duplicate act on the
      // existing event (update it) rather than only knowing one exists.
      fields: 'items(id,summary,start,end,recurringEventId)',
    });
    return (resp.data.items || []).map(it => ({
      id: it.id,
      recurringEventId: it.recurringEventId || null,
      title: it.summary || '',
      date: it.start?.date || (it.start?.dateTime || '').slice(0, 10),
      time: it.start?.dateTime ? it.start.dateTime.slice(11, 16) : '',
      end_time: it.end?.dateTime ? it.end.dateTime.slice(11, 16) : '',
      is_all_day: !!it.start?.date,
    })).filter(e => e.date);
  } catch (err) {
    // Never let this break a scan. Failing to read the calendar should mean
    // "no extra information", not "no events written".
    console.error('[calendar-scan] events.list failed:', err.message);
    return [];
  }
}

// Which calendars can we see? Checking only the calendar Criba writes to is
// not enough: a subscribed club or school feed puts its copy of the same
// practice on its own calendar, and that is the collision users actually see.
//
// Cached for a few minutes because one scan writes many events and they all
// need the same answer. Falls back to the write target alone if the user's
// session predates the calendarlist scope.
const _calListCache = new Map();
async function visibleCalendars(calendarApi, targetCalId) {
  const key = targetCalId || 'primary';
  const hit = _calListCache.get(key);
  if (hit && Date.now() - hit.at < 300000) return hit.cals;
  let cals = [{ id: key, name: key }];
  try {
    const list = await calendarApi.calendarList.list({ maxResults: 250, fields: 'items(id,summary)' });
    const items = (list.data.items || []).map(c => ({ id: c.id, name: c.summary || c.id }));
    if (items.length) {
      cals = items.some(c => c.id === key) ? items : [{ id: key, name: key }, ...items];
    }
  } catch (err) {
    console.error('[calendar-dedup] calendarList.list failed, using target only:', err.message);
  }
  _calListCache.set(key, { cals, at: Date.now() });
  return cals;
}

// Per-invocation cache of one calendar's events on one date. Without it, a scan
// writing ten events across eight calendars would make eighty events.list calls.
const _calDayCache = new Map();
async function eventsOnDate(calendarApi, calId, date, opts = {}) {
  const key = `${calId}|${date}`;
  if (!opts.fresh) {
    const hit = _calDayCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.events;
  }
  const events = await fetchExistingCalendarEvents(calendarApi, calId, [date, date]);
  _calDayCache.set(key, { events, at: Date.now() });
  return events;
}

// A write we just made must be visible to the very next duplicate check.
// Without this, a run writing two extractions of the same event moments apart
// checked a cache captured before either existed and wrote both.
function noteWrittenToCache(calId, date, written) {
  const key = `${calId}|${date}`;
  const hit = _calDayCache.get(key);
  if (hit) hit.events = [...hit.events, written];
  else _calDayCache.set(key, { events: [written], at: Date.now() });
}

// Is this event already on ANY calendar the user can see?
async function findExistingOnAnyCalendar(calendarApi, targetCalId, ev) {
  if (!ev?.date || !ev?.title) return null;
  try {
    const cals = await visibleCalendars(calendarApi, targetCalId);
    for (const cal of cals) {
      const existing = await eventsOnDate(calendarApi, cal.id, ev.date);
      const dup = findCalendarDuplicate(existing, ev.title, ev.date, ev.time || '');
      if (dup) return { ...dup, calendarId: cal.id, calendarName: cal.name };
    }
  } catch (err) {
    // A failed lookup must never block a write. Missing an event is worse than
    // occasionally writing a duplicate we could have caught.
    console.error('[calendar-dedup] lookup failed, writing anyway:', err.message);
  }
  return null;
}

// Do two event titles refer to the same thing?
//
// Exact matching is useless here: the club feed says "Burlingame SC U9B Pre-NPL
// Practice" and the coach's email yields "Practice: Burlingame SC U9B Pre-NPL
// (Washington Park)". Compare the significant words instead, and call it a
// match when one title's words are largely contained in the other's.
// Only genuine filler words. Words like "practice", "game" and "meeting" are
// deliberately NOT stripped — they are often the only thing distinguishing
// "Freshmen Football Practice" from "Freshmen Football Game".
const TITLE_STOPWORDS = new Set(['the','a','an','at','in','on','of','for','and','to','with','vs','v']);
function titleTokens(s) {
  return new Set(
    String(s || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !TITLE_STOPWORDS.has(w))
  );
}
// Words that say what kind of thing an event is, not which thing it is. Shared
// between two titles they mean nothing: every school email says "meeting" and
// every fixture says "game". Names — of schools, teams, opponents, people — are
// what actually identify an event, so they are what the token rule below counts.
//
// Kept separate from TITLE_STOPWORDS, which the Jaccard path needs to KEEP
// (there "practice" vs "game" is the only thing distinguishing two fixtures).
const GENERIC_TITLE_TOKENS = new Set([
  'game','games','match','meet','practice','scrimmage','tournament','event','events',
  'meeting','night','day','days','week','morning','afternoon','evening','lunch',
  'school','high','middle','elementary','college','preparatory','prep','academy','district',
  'home','away','team','teams','class','classes','session','parent','parents',
  'family','student','students','annual','first','back',
  'due','homework','assignment','deadline','reminder','form','forms','picture','photo',
  'field','gym','room','center','centre','vs','versus',
  'opener','season','all','st',
  // Placeholders and status words. A school that writes "Submit Child's Health
  // Form" is not naming a different child from the one that writes "Submit
  // Aarav's Health Form" — "child" is the blank where a name goes. Likewise
  // "(Overdue)" describes the state of a task, not which task it is. Both were
  // being counted as identifying names, so the two-sided test below concluded
  // that each title named something the other lacked and let the same
  // immunization form onto the calendar twice, coloured for two children.
  'child','childs','children','kid','kids',
  'overdue','late','urgent','required','action','new','updated','pending','submit',
  // Schedule words. "Weekly Thursdays" describes when a class recurs, not which
  // class it is, so it must not distinguish a series from its first session.
  'weekly','monthly','recurring','monday','tuesday','wednesday','thursday',
  'friday','saturday','sunday','mondays','tuesdays','wednesdays','thursdays',
  'fridays','saturdays','sundays',
]);

function distinctiveTokens(s) {
  const out = new Set();
  for (const w of titleTokens(s)) if (!GENERIC_TITLE_TOKENS.has(w)) out.add(w);
  return out;
}

// The same fixture written two ways. A club's feed says "St. Ignatius College
// Preparatory Football (Frosh) vs Redwood High School"; the coach's email says
// "Frosh Home Game vs Redwood". Word-overlap scoring cannot bridge that — they
// share 2 words out of 10, well under any usable threshold — but the two names
// that matter, "frosh" and "redwood", appear in both.
//
// The test is not how much the titles overlap but whether EACH names something
// the other doesn't. "Frosh vs Redwood" and "Varsity vs Redwood" each carry a
// name the other lacks, so they are different games. "Frosh vs Redwood" and the
// feed's formal version add only school boilerplate on one side, so they are
// one game described twice.
//
// This is what counting shared words gets wrong in both directions: the two
// wordings of one fixture share almost nothing, while "What to Expect Night
// 3rd-5th" and "What to Expect Night K-2nd" share almost everything and are
// four different evenings.
//
// Callers apply their own same-day and same-time checks on top of this.
function titlesShareDistinctiveTokens(a, b) {
  const da = distinctiveTokens(a), db = distinctiveTokens(b);
  if (!da.size || !db.size) return false;
  let shared = 0;
  for (const w of da) if (db.has(w)) shared++;
  if (!shared) return false;
  const extraA = [...da].some(w => !db.has(w));
  const extraB = [...db].some(w => !da.has(w));
  return !(extraA && extraB);
}

function titlesLooselyMatch(a, b) {
  const ta = titleTokens(a), tb = titleTokens(b);
  // When both titles name something — a school, an opponent, a child, a grade
  // range — those names decide it, and word-overlap scoring is not consulted at
  // all. Overlap is a proxy for sameness that fails badly on exactly the titles
  // that matter here.
  const da = distinctiveTokens(a), db = distinctiveTokens(b);
  if (da.size && db.size) return titlesShareDistinctiveTokens(a, b);
  // Nothing distinctive left after stripping — fall back to exact comparison
  // rather than declaring everything a match.
  if (!ta.size || !tb.size) {
    return String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();
  }
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  const union = ta.size + tb.size - shared;
  // Jaccard, not overlap-over-smaller. Dividing by the smaller set called
  // "Math homework due" and "Science homework due" the same event.
  if (shared / union >= 0.6) return true;
  // One title fully inside the other, e.g. "U9B Practice" vs "U9B Practice -
  // Washington Park". Requires at least two words so a bare "Practice" doesn't
  // swallow everything that mentions practice.
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size >= 2 && [...small].every(w => big.has(w))) return true;
  // Last resort: the same names in both titles, however differently worded.
  return titlesShareDistinctiveTokens(a, b);
}

// Is this event already on the calendar, put there by something other than us?
// Same day, similar title, and either the same start time or one of the two
// being all-day.
// Is this event already on the calendar, put there by something other than us?
// Same day, similar title, and either the same start time or one of the two
// being all-day.
function findCalendarDuplicate(existing, title, date, time) {
  for (const ex of existing) {
    if (ex.date !== date) continue;
    if (!titlesLooselyMatch(ex.title, title)) continue;
    if (!time || !ex.time || ex.is_all_day) return ex;
    if (ex.time === time) return ex;
    // Within 30 minutes counts as the same fixture described slightly
    // differently — a 3:00 practice and a 2:45 call time.
    if (Math.abs(timeToMinutes(ex.time) - timeToMinutes(time)) <= 30) return ex;
  }
  return null;
}

// Overlapping, but not the same event — a genuine scheduling clash worth
// surfacing rather than suppressing.
function findCalendarConflict(existing, date, startTime, endTime) {
  if (!date || !startTime) return null;
  const newStart = timeToMinutes(startTime);
  const newEnd = endTime ? timeToMinutes(endTime) : newStart + 60;
  for (const ex of existing) {
    if (ex.date !== date || ex.is_all_day || !ex.time) continue;
    const exStart = timeToMinutes(ex.time);
    const exEnd = ex.end_time ? timeToMinutes(ex.end_time) : exStart + 60;
    if (newStart < exEnd && newEnd > exStart) {
      return `⚠️ Conflict: overlaps "${ex.title}" at ${ex.time.replace(/^0/, '')} already on your calendar`;
    }
  }
  return null;
}

// Check existing pending/approved events for time overlap on the same date.
// Returns a conflict note string if a conflict exists, or null if clear.
// Only checks timed events (is_all_day:false, time set).
async function findConflict(eventsStore, date, startTime, endTime) {
  if (!date || !startTime) return null; // all-day events — no conflict check
  const newStart = timeToMinutes(startTime);
  const newEnd = endTime ? timeToMinutes(endTime) : newStart + 60;
  const all = await eventsStore.values();
  for (const existing of all) {
    if (existing.date !== date) continue;
    if (existing.status === 'dismissed' || existing.status === 'rejected') continue;
    if (existing.is_all_day || !existing.time) continue; // skip all-day existing events
    const exStart = timeToMinutes(existing.time);
    const exEnd = existing.end_time ? timeToMinutes(existing.end_time) : exStart + 60;
    // Overlap: one starts before the other ends
    if (newStart < exEnd && newEnd > exStart) {
      const fmtTime = existing.time.replace(/^0/, '');
      return `⚠️ Conflict: overlaps with "${existing.title}" at ${fmtTime}`;
    }
  }
  return null;
}

// Build an OAuth2 client from a stored refresh token (no session cookie needed)
function getOAuthClientFromRefreshToken(refreshToken) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// Register (or renew) a Gmail push-notification watch for one user.
// Stores the watch state in Redis and adds the email to gmailWatchedUsers set.
async function registerGmailWatch(email, refreshToken) {
  const auth = getOAuthClientFromRefreshToken(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });
  const watchRes = await gmail.users.watch({
    userId: 'me',
    resource: { topicName: process.env.PUBSUB_TOPIC, labelIds: ['INBOX'] }
  });
  const { historyId, expiration } = watchRes.data;
  await redis.set(`gmailWatch:${email}`, JSON.stringify({ email, historyId, expiration }));
  await redis.sadd('gmailWatchedUsers', email);
  console.log(`Gmail watch registered for ${email}, expires ${new Date(parseInt(expiration)).toISOString()}`);
  return watchRes.data;
}

// How long one invocation may spend extracting before it stops and leaves the
// rest for the next run. Vercel kills the function at 60s; a kill mid-batch is
// the one outcome that loses mail, so we stop ourselves first with room to
// write the cursor.
const WEBHOOK_BUDGET_MS = 38000;
// history.list is paginated. Three days of mail is far more than one page, and
// reading only the first page while advancing the cursor to the newest
// historyId silently discarded the remainder.
const HISTORY_MAX_PAGES = 10;

// Fetch new messages since the last known historyId and run extraction.
//
// Returns { done } — false means work remains in this history range and the
// cursor was deliberately left where it was, so the next run resumes here.
async function processNewGmailEmails(email, refreshToken, newHistoryId) {
  const deadline = Date.now() + WEBHOOK_BUDGET_MS;
  console.log(`[gmail-process] START email=${email} newHistoryId=${newHistoryId}`);

  // One extraction run per mailbox at a time. Pub/Sub redelivers a push it has
  // not been ACKed for within the subscription's deadline, so a slow run used
  // to be joined by a second copy of itself working the same history range.
  // Both would pass the fingerprint check before either wrote, and both would
  // write to the calendar — the same fixture twice, coloured for different
  // children because the two extractions tagged attendees differently.
  const procLock = `gmailProcLock:${email}`;
  if (!(await redis.set(procLock, '1', 'EX', 90, 'NX'))) {
    console.log(`[gmail-process] SKIP email=${email} — another run holds the lock`);
    return { done: false };
  }
  try {
    return await runGmailExtraction(email, refreshToken, newHistoryId, deadline);
  } finally {
    await redis.del(procLock);
  }
}

async function runGmailExtraction(email, refreshToken, newHistoryId, deadline) {
  const watchDataStr = await redis.get(`gmailWatch:${email}`);
  if (!watchDataStr) {
    console.error(`[gmail-process] ABORT email=${email} — no gmailWatch record in Redis`);
    return { done: true };
  }
  const watchData = JSON.parse(watchDataStr);
  const startHistoryId = watchData.historyId;
  console.log(`[gmail-process] historyId range: ${startHistoryId} → ${newHistoryId}`);

  const auth = getOAuthClientFromRefreshToken(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });
  const calendarApi = google.calendar({ version: 'v3', auth });
  const targetCalId = await resolveTargetCalendar(email);
  // Needed by the extraction prompt so Claude can tag which child an event is
  // for — that tag is what drives the per-person event colour.
  const userTz = await getUserTimezone(email);
  const gpFamily = await getUserFamily(email).values();
  const gpFamilyNames = gpFamily.map(m => m.name).filter(Boolean);
  // The webhook handles nearly every email that arrives; "Scan now" handles the
  // rest. Only the latter was checking relevance, so the newsletter gate added
  // in 25180b5 was never running on the path that mattered. Loading the same
  // two inputs here is what lets the same check run in both places.
  const gpExclusions = await getUserExclusions(email).values();

  // The cursor is NOT advanced here. It used to be, "so we don't reprocess on
  // retry" — but the per-message lock below already does that job, and moving
  // past the range before doing the work meant any failure after this point
  // lost those emails permanently. history.list erroring, an Anthropic call
  // failing, or the function hitting Vercel's 60s maxDuration mid-batch all
  // ended the same way: the next webhook started after the emails it never
  // read. The cursor now advances only once the work is actually done.
  const advanceHistoryCursor = async () => {
    watchData.historyId = newHistoryId || startHistoryId;
    await redis.set(`gmailWatch:${email}`, JSON.stringify(watchData));
  };

  const messageIds = new Set();
  let pagesRead = 0;
  let pageToken = undefined;
  let historyComplete = true;
  try {
    do {
      const histRes = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
        maxResults: 500,
        pageToken,
      });
      for (const record of (histRes.data.history || [])) {
        for (const added of (record.messagesAdded || [])) messageIds.add(added.message.id);
      }
      pageToken = histRes.data.nextPageToken;
      pagesRead++;
    } while (pageToken && pagesRead < HISTORY_MAX_PAGES);
    if (pageToken) {
      historyComplete = false;
      console.warn(`[gmail-process] email=${email} history truncated at ${pagesRead} pages — more remains`);
    }
  } catch (err) {
    console.error(`Gmail history.list error for ${email}:`, err.message);
    // A 404 means the cursor is older than Gmail's history retention and can
    // never be read again. Leaving it in place would stall this mailbox
    // forever, so jump to the current point and let the daily backfill cover
    // the gap — a visible gap beats a permanent stall.
    if (err.code === 404 || err.response?.status === 404) {
      console.error(`[gmail-process] email=${email} historyId ${startHistoryId} expired — resetting cursor`);
      await advanceHistoryCursor();
    }
    return { done: false };
  }

  console.log(`[gmail-process] email=${email} found ${messageIds.size} new message(s) across ${pagesRead} page(s)`);
  // Nothing to do, so the range is genuinely consumed — safe to move past it.
  if (!messageIds.size && historyComplete) { await advanceHistoryCursor(); return { done: true }; }

  const eventsStore = getUserEvents(email);
  let allProcessed = historyComplete;
  // A failure that can never succeed must not pin the cursor. Holding it back
  // on ANY failure was meant to stop mail being lost, and it does — but a
  // deleted message (404) or an exhausted API key fails identically on every
  // retry, so the cursor stayed put permanently, the history range widened by
  // the hour, and every webhook re-walked and re-billed the whole thing. Give
  // up on an individual message after a few honest attempts, and abort the run
  // outright when the failure is one that will hit every remaining message.
  const MAX_MESSAGE_ATTEMPTS = 3;
  let fatalApiError = '';

  for (const messageId of messageIds) {
    // One bad API key or an empty balance fails all 399 messages in exactly
    // the same way. Grinding through the rest bills for every one of them.
    if (fatalApiError) {
      console.error(`[gmail-process] email=${email} ABORT — ${fatalApiError}`);
      allProcessed = false;
      break;
    }
    // Stop before the platform stops us. Whatever is left stays unclaimed and
    // uncommitted, and the cursor stays put, so the next run sees it again.
    if (Date.now() > deadline) {
      console.warn(`[gmail-process] email=${email} BUDGET reached — deferring remaining messages`);
      allProcessed = false;
      break;
    }
    console.log(`[gmail-process] email=${email} processing messageId=${messageId}`);
    // Two different questions, deliberately two different keys. "Done" is a
    // durable record that this message was fully handled. The claim is a short
    // lease that only stops two concurrent runs colliding.
    //
    // These used to be one hour-long key taken before the work: a run killed
    // by the 60s timeout left its messages claimed, the next run skipped them
    // as "already handled", and then advanced the cursor past them. They were
    // never extracted and never seen again.
    if (await redis.exists(`gmailMsgDone:${email}:${messageId}`)) {
      console.log(`[gmail-process] SKIP messageId=${messageId} — already processed`);
      continue;
    }
    const lockKey = `gmailMsgLock:${email}:${messageId}`;
    const locked = await redis.set(lockKey, '1', 'EX', 180, 'NX');
    if (!locked) {
      console.log(`[gmail-process] SKIP messageId=${messageId} — claimed by a concurrent run`);
      allProcessed = false;
      continue;
    }
    let completed = false;
    let permanentlyFailed = false;

    try {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const msg = msgRes.data;
      // Gmail hands us the thread on every message and we used to drop it on
      // the floor. It is the one identifier that survives rewording, so it is
      // stored on every event and consulted by dedup — see isDuplicateEventIn.
      const threadId = msg.threadId || '';
      const headers = msg.payload.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const dateSent = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      // Skip Promotions / Social tabs — see GMAIL_NOISE_LABELS comment for why Updates/Forums are excluded.
      // Read the headers first: a skip we cannot name in the trace is a skip
      // nobody can debug later.
      const labelIds = msg.labelIds || [];
      const noisy = labelIds.filter(l => GMAIL_NOISE_LABELS.has(l));
      if (noisy.length) {
        console.log(`[gmail-process] SKIP msg=${messageId} — noise category label: ${noisy.join(',')}`);
        await traceEmail(email, { stage: 'SKIP-NOISE', via: 'webhook', messageId, subject, from, labels: noisy.join(',') });
        completed = true;
        continue;
      }
      const { senderName, senderEmail } = parseFrom(from);
      const body = extractEmailBody(msg.payload);

      // Detect image attachments/inline images in the email.
      // An "image-heavy" email has images but minimal text — the calendar info is
      // likely in a visual flyer (e.g. sports schedules, school newsletters as images).
      const imageParts = collectImageParts(msg.payload);
      const isImageHeavy = imageParts.length > 0 && body.trim().length < IMAGE_HEAVY_BODY_MAX;
      console.log(`[gmail-process] msg=${messageId} from="${senderEmail}" subject="${subject}" bodyLen=${body.length} images=${imageParts.length} imageHeavy=${isImageHeavy}`);

      // Pre-filter. This used to be diagnosePreFilter — a flat keyword list where
      // a miss was a hard drop with no second look. The scan path had already
      // moved to scanForDateContent, which escalates rather than discards, and
      // the two filters silently disagreed: mail the scan happily queued, the
      // webhook threw away. Both paths now apply the same test to the same
      // full body, so a manual scan can no longer find what the webhook missed.
      const wePass = scanForDateContent(`${subject} ${body}`).pass;
      if (!wePass && !isImageHeavy) {
        console.log(`[prefilter] SKIP msg=${messageId} user=${email} subject="${subject}" — no date signal in body`);
        await traceEmail(email, { stage: 'SKIP-BODY', via: 'webhook', messageId, subject, from, bodyLen: body.length });
        completed = true;
        continue;
      }
      if (isImageHeavy && !wePass) {
        console.log(`[gmail-process] IMAGE-HEAVY BYPASS msg=${messageId} — skipping pre-filter for vision extraction`);
      }

      // Cross-user duplicate guard: same email sent to multiple family members
      // (e.g. school newsletter to both Priya and Bharat) should only be extracted once.
      // Fingerprint = SHA-256 of senderEmail + subject + Date header (normalised).
      const fpKey = emailFingerprintKey(senderEmail, subject, dateSent);
      const fingerprint = fpKey.slice('processedEmail:'.length);
      const alreadyProcessed = await redis.exists(fpKey);
      if (alreadyProcessed) {
        console.log(`[gmail-process] DEDUP SKIP msg=${messageId} fingerprint=${fingerprint.slice(0, 12)}… already extracted for another user`);
        await traceEmail(email, { stage: 'SKIP-DEDUP', via: 'webhook', messageId, subject, from });
        completed = true;
        continue;
      }
      // A stale cursor is not a licence to bill for ancient mail.
      //
      // The history walk starts wherever the stored cursor happens to be, and
      // that cursor can be hours or days behind after any incident that stopped
      // it advancing. When it finally moves, every message in the gap is
      // extracted at full price — mail the user has long since read and dealt
      // with. Nothing bounded that: the webhook had no notion of age at all.
      //
      // Bounded here, after the metadata fetch (cheap) and before the image
      // fetch and the Claude call (not). An old message is marked done so the
      // cursor still advances past it rather than sticking again.
      const sentMs = dateSent ? Date.parse(dateSent) : NaN;
      const ageDays = Number.isFinite(sentMs) ? (Date.now() - sentMs) / 86400000 : null;
      if (ageDays !== null && ageDays > WEBHOOK_MAX_EMAIL_AGE_DAYS) {
        console.warn(`[gmail-process] SKIP-OLD msg=${messageId} age=${ageDays.toFixed(1)}d subject="${subject.slice(0, 60)}"`);
        await traceEmail(email, { stage: 'SKIP-OLD', via: 'webhook', messageId, subject, from,
          ageDays: Number(ageDays.toFixed(1)), limitDays: WEBHOOK_MAX_EMAIL_AGE_DAYS });
        completed = true;
        continue;
      }
      // Fetch image data for vision extraction (only when images present)
      const images = imageParts.length > 0
        ? await fetchEmailImages(msg.payload, gmail, messageId)
        : [];
      // Without this the trace shows SENT-TO-AI followed by DROPPED, which reads
      // as "Claude looked at the picture and found nothing" when in fact Claude
      // was handed an empty body and no picture at all.
      if (isImageHeavy && !images.length) {
        await traceEmail(email, { stage: 'NO-IMAGE-DATA', via: 'webhook', messageId, subject, from,
          attachments: imageParts.length, droppedForSize: images.droppedForSize || 0 });
      }

      console.log(`[gmail-process] EXTRACT msg=${messageId} calling Claude subject="${subject}" images=${images.length}`);
      await traceEmail(email, { stage: 'SENT-TO-AI', via: 'webhook', messageId, subject, from, bodyLen: body.length, images: images.length });
      const extracted = await extractGmailEvents(body, senderName, senderEmail, subject, images, dateSent, gpFamilyNames, email);
      console.log(`[gmail-process] EXTRACT msg=${messageId} Claude returned ${extracted.length} event(s)`);
      if (!extracted.length) {
        await traceEmail(email, { stage: 'DROPPED', via: 'webhook', messageId, subject, from, note: 'no events returned' });
      }

      // Mark as processed AFTER Claude returns successfully — mirroring the backfill fix.
      // Writing before the Claude call meant any timeout or throw in extractGmailEvents
      // permanently poisoned this fingerprint for 30 days with no events ever stored.
      // Small residual risk: two near-simultaneous webhook deliveries for the same message
      // (e.g. school email to both Priya and Bharat) can both pass the dedup check and
      // both call Claude — same trade-off accepted in the backfill path.
      await redis.set(fpKey, email, 'EX', 30 * 24 * 60 * 60);

      for (const ev of extracted) {
        if (!ev.title || !ev.date) {
          console.log(`[gmail-process] msg=${messageId} skipping event missing title/date: ${JSON.stringify(ev).slice(0,100)}`);
          continue;
        }
        shiftMidnightToMorning(ev);
        // Convert before anything else reads the time: dedup, conflict checks
        // and the calendar write all have to agree on when this actually is.
        const tzNote = normalizeEventTimezone(ev, userTz);
        if (tzNote) ev.notes = [ev.notes, tzNote].filter(Boolean).join(' ');

        const intent = ev.intent || 'new_event';

        // Handle cancellations and reschedules
        if (intent === 'cancellation' || intent === 'reschedule') {
          const matchResult = await findMatchingApprovedEvent(eventsStore, ev.old_title || ev.title, ev.old_date || ev.date);
          const matchedEvent = matchResult?.event || null;
          const matchedScore = matchResult?.score ?? null;
          const evId = randomUUID();
          const status = intent === 'cancellation' ? 'pending_cancellation' : 'pending_reschedule';
          await eventsStore.set(evId, {
            id: evId, intent,
            title: ev.title, date: ev.date, end_date: ev.end_date || '',
            time: ev.start_time || '', end_time: ev.end_time || '',
            location: ev.location || '', is_all_day: !!ev.is_all_day,
            attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
            notes: ev.notes || null, source_type: ev.source_type || null,
            old_title: ev.old_title || null, old_date: ev.old_date || null, old_time: ev.old_time || null,
            matched_event_id: matchedEvent?.id || null, matched_event_title: matchedEvent?.title || null,
            matched_event_confidence: matchedScore,
            source: 'gmail', gmail_message_id: messageId, thread_id: threadId || null,
            sender_name: senderName, sender_email: senderEmail, subject,
            status, type: ev.is_all_day ? 'other' : 'timed',
            created_at: new Date().toISOString(),
          });
          console.log(`[gmail-process] ${intent.toUpperCase()} "${ev.title}" matched="${matchedEvent?.title || 'none'}" confidence=${matchedScore?.toFixed(2) ?? 'n/a'} stored (id=${evId})`);
          continue;
        }

        // Decision gate — consulted BEFORE dedup on purpose. A refusal means
        // "the user already ruled on this event", and the ruling must reach the
        // review queue even if some blocking row would otherwise swallow the
        // extraction. Gate first, dedup second: a prior "no" can never become
        // a silent drop.
        const refusal = await priorRefusal(email, ev.date, ev.title);
        if (!refusal && await isDuplicateEvent(eventsStore, ev.title, ev.date, { time: ev.start_time || '', recurrence: ev.recurrence, threadId })) {
          console.log(`[gmail-process] msg=${messageId} DEDUP SKIP event "${ev.title}" on ${ev.date} already exists`);
          // A skip that only exists in a log line is a skip nobody can audit.
          // This is the path that once ate real school mail, so every drop now
          // leaves a trace the user's own timeline can show.
          await traceEmail(email, { stage: 'SKIP-DUPLICATE', via: 'webhook', messageId, subject,
            title: ev.title, date: ev.date, threadId: threadId || null });
          continue;
        }

        const startTime = ev.start_time || '';
        const endTime = ev.end_time || '';
        const conflictNote = await findConflict(eventsStore, ev.date, startTime, endTime);
        const combinedNotes = ev.notes || null;

        // Auto-add: write to the calendar immediately. autoWriteToCalendar is the
        // single chokepoint that dedups before inserting — against every calendar
        // the user subscribes to, a late fresh re-check, AND a persistent
        // write-guard keyed per user — so auto-add never lands a second copy.
        const colorId = await resolveEventColorByNames(email, Array.isArray(ev.attendees) ? ev.attendees : [], [ev.title, ev.location, ev.notes].filter(Boolean).join(' '));
        const evObj = { title: ev.title, date: ev.date, end_date: ev.end_date || '', time: startTime, end_time: endTime, location: ev.location || '', recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null, recurring_note: ev.recurring_note || null, attendees: [],
          // Carried purely so buildEventDescription can write the details and
          // the back-link to the source email into the calendar entry.
          notes: combinedNotes, sender_name: senderName, sender_email: senderEmail, subject, gmail_message_id: messageId };
        // A newsletter is a broadcast. Some of what it announces is genuinely
        // yours — the school telling you about Back to School Night — and some
        // is someone else's event it happens to be reporting, or an open
        // invitation you never accepted. Writing the second kind is how a
        // calendar fills with meetups in cities you don't live in.
        //
        // Held, not discarded: the event still lands in the review queue with
        // the reason attached, and one click puts it on the calendar. Note that
        // this only holds back events Claude tagged as third_party or
        // opportunity, plus ones naming a grade nobody in the family is in.
        // A school event addressed to you passes untouched — those are the ones
        // that must never be missed, so the gate is deliberately narrow.
        const relevance = eventRelevance(
          [ev.title, ev.notes, subject].filter(Boolean).join(' '), gpFamily,
          gpExclusions, senderEmail, ev.audience);

        // A prior refusal is treated like a relevance hold: never auto-write,
        // never drop — the event surfaces in Review carrying the reason, and
        // one click either adds it or refuses it again.
        const hold = refusal ? refusalHold(refusal) : null;
        let calEventId = null;
        if (hold) {
          console.log(`[gmail-process] HELD-REFUSAL "${ev.title}" on ${ev.date} — refused ${refusal.decided_at || 'earlier'} via ${refusal.via || 'unknown'}`);
          await traceEmail(email, { stage: 'HELD-REFUSAL', via: 'webhook', messageId, subject,
            title: ev.title, date: ev.date, refusedVia: refusal.via || null, decidedAt: refusal.decided_at || null });
        } else if (relevance.relevant) {
          try {
            calEventId = await autoWriteToCalendar(calendarApi, targetCalId, evObj, colorId, { timezone: userTz, email });
            console.log(`[gmail-process] GCal WRITE "${ev.title}" on ${ev.date} calEventId=${calEventId}`);
          } catch (calErr) {
            console.error(`[gmail-process] GCal write failed for "${ev.title}":`, calErr.message);
          }
        } else {
          console.log(`[gmail-process] HELD "${ev.title}" — ${relevance.reason}`);
        }
        // Not written because it is already on one of the user's calendars.
        const calDup = evObj.duplicate_of || null;
        const evId = randomUUID();
        await eventsStore.set(evId, {
          id: evId,
          title: ev.title,
          date: ev.date,
          end_date: ev.end_date || '',
          time: startTime,
          end_time: endTime,
          location: ev.location || '',
          is_all_day: !!ev.is_all_day,
          attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
          notes: combinedNotes,
          duplicate_of_calendar: !!calDup,
          conflict_note: hold
            ? hold.conflict_note
            : calDup
              ? calDupNote(calDup, targetCalId)
              : (relevance.reason ? `Not added — ${relevance.reason}` : conflictNote || null),
          held_reason: hold ? hold.held_reason : (relevance.reason || null),
          source_type: ev.source_type || null,
          recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null,
          source: 'gmail',
          gmail_message_id: messageId,
          thread_id: threadId || null,
          sender_name: senderName,
          sender_email: senderEmail,
          subject,
          status: calEventId ? 'added' : (calDup ? 'duplicate' : 'pending'),
          reviewed: false,
          calEventId: calEventId || null,
          gcalId: calEventId ? targetCalId : null,
          approved_at: calEventId ? new Date().toISOString() : null,
          type: ev.is_all_day ? 'other' : 'timed',
          created_at: new Date().toISOString(),
        });
        console.log(`[gmail-process] STORED event "${ev.title}" on ${ev.date} for ${email} status=${calEventId ? 'added' : (calDup ? 'duplicate' : 'pending')} (id=${evId})`);
        await traceEmail(email, { stage: 'STORED', via: 'webhook', messageId, subject, title: ev.title, date: ev.date,
          status: calEventId ? 'added' : (calDup ? 'duplicate' : 'pending') });
      }
      completed = true;
    } catch (err) {
      console.error(`[gmail-process] ERROR messageId=${messageId} email=${email}:`, err.message, err.stack?.split('\n')[1]);
      const status = err.code || err.response?.status;
      // The message is gone from Gmail. No number of retries brings it back.
      if (status === 404 || status === 410) {
        console.warn(`[gmail-process] messageId=${messageId} no longer exists — giving up`);
        await traceEmail(email, { stage: 'DROPPED', via: 'webhook', messageId, reason: 'message-no-longer-in-gmail' });
        permanentlyFailed = true;
      } else if (err.message?.includes(SPEND_CAP_ERROR) || /credit balance is too low|invalid x-api-key|authentication_error/i.test(err.message || '')) {
        // Config-level, not message-level: every remaining message will fail
        // the same way, so stop rather than paying for 399 identical errors.
        fatalApiError = summariseApiError(err.message);
      } else {
        // Transient until proven otherwise — but not forever. Count attempts
        // so a message that always fails cannot hold the mailbox hostage.
        const failKey = `gmailMsgFail:${email}:${messageId}`;
        const attempts = Number(await redis.incr(failKey)) || 1;
        await redis.expire(failKey, 30 * 24 * 60 * 60);
        if (attempts >= MAX_MESSAGE_ATTEMPTS) {
          console.error(`[gmail-process] messageId=${messageId} failed ${attempts}x — giving up`);
          await traceEmail(email, { stage: 'ERROR', via: 'webhook', messageId,
            error: `gave up after ${attempts} attempts: ${err.message}`, deadLettered: true });
          permanentlyFailed = true;
        }
      }
    } finally {
      // Marked done not because it worked, but because retrying it forever
      // costs money and blocks every message behind it. The trace above records
      // that it was abandoned, so it is not silently forgotten.
      if (completed || permanentlyFailed) {
        await redis.set(`gmailMsgDone:${email}:${messageId}`, '1', 'EX', 30 * 24 * 60 * 60);
        await redis.del(`gmailMsgFail:${email}:${messageId}`);
      } else {
        // Hand the message back. A failure here must leave no trace that would
        // make a later run mistake it for work already done.
        await redis.del(lockKey);
        allProcessed = false;
      }
    }
  }
  // The cursor moves only when the whole range is genuinely consumed. Moving it
  // past work we did not do is how three days of mail disappeared.
  if (allProcessed) {
    await advanceHistoryCursor();
    await redis.del(`gmailBacklog:${email}`);
  } else {
    await redis.set(`gmailBacklog:${email}`, String(newHistoryId || ''), 'EX', 7 * 24 * 60 * 60);
    console.warn(`[gmail-process] email=${email} INCOMPLETE — cursor held at ${startHistoryId}, backlog flagged`);
  }
  console.log(`[gmail-process] DONE email=${email} complete=${allProcessed}`);
  return { done: allProcessed };
}

// Send a Resend email notification about pending items in the review queue.
// Silently no-ops if RESEND_API_KEY is not set.
async function sendNotificationEmail(toEmail, count, titles) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Criba <notifications@criba.app>',
        to: [toEmail],
        subject: `You have ${count} event${count > 1 ? 's' : ''} waiting in your Criba review queue`,
        html: `<p>Hi,</p>
<p>You have <strong>${count} new event${count > 1 ? 's' : ''}</strong> waiting for your review:</p>
<ul>${titles.slice(0, 10).map(t => `<li>${t}</li>`).join('')}</ul>
<p><a href="https://criba.app" style="color:#1a73e8">Review at criba.app →</a></p>
<p style="color:#999;font-size:12px;margin-top:2rem">You're receiving this because you use Criba to review calendar events before they're added to Google Calendar.</p>`,
      }),
    });
  } catch (e) {
    console.error('Notification email failed:', e.message);
  }
}

// POST /api/gmail/watch — call from frontend after login to (re)register watch
app.post('/api/gmail/watch', requireAuth, async (req, res) => {
  const refreshToken = await redis.get(`refreshToken:${req.user.email}`);
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token stored — please sign in again' });
  try {
    const data = await registerGmailWatch(req.user.email, refreshToken);
    res.json({ ok: true, expiration: data.expiration });
  } catch (err) {
    console.error('Gmail watch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user/status — returns per-user flags the frontend checks on load
// (currently: gmailDisconnected flag set by cron when watch renewal fails)
// POST /api/user/timezone — record the zone the user's browser reports.
// Called on every page load, so a user who moves is followed automatically and
// an account created before this existed gets a real zone on next visit.
app.post('/api/user/timezone', requireAuth, async (req, res) => {
  const tz = req.body?.timezone;
  if (!isValidTimezone(tz)) return res.status(400).json({ error: 'Unrecognised timezone' });
  const previous = await redis.get(`userTz:${req.user.email}`);
  if (previous !== tz) {
    await redis.set(`userTz:${req.user.email}`, tz);
    console.log(`[timezone] ${req.user.email}: ${previous || '(unset)'} → ${tz}`);
  }
  res.json({ ok: true, timezone: tz });
});

app.get('/api/user/status', requireAuth, async (req, res) => {
  const disconnectedAt = await redis.get(`gmailDisconnected:${req.user.email}`);
  // The Gmail watch only delivers mail arriving after it is registered, so a
  // brand-new account starts with an empty queue and nothing to look at. One
  // 24h scan on first sign-in gives them something immediately; after that the
  // watch covers everything and no manual scan is needed.
  let onboardedAt = await redis.get(`onboarded:${req.user.email}`);

  // Existing accounts predate this flag. Treat anyone who already has events as
  // onboarded and write the flag, so the change doesn't fire a surprise scan
  // for every current user on their next page load.
  if (!onboardedAt) {
    const existing = await getUserEvents(req.user.email).values();
    if (existing.length > 0) {
      onboardedAt = new Date().toISOString();
      await redis.set(`onboarded:${req.user.email}`, onboardedAt);
    }
  }

  res.json({
    gmailDisconnected: !!disconnectedAt,
    gmailDisconnectedAt: disconnectedAt || null,
    needsOnboardingScan: !onboardedAt,
  });
});

// POST /api/user/onboarded — mark the one-time onboarding scan as done.
// Set once the scan has been *attempted*, not only when it succeeds: a user
// whose first scan errors should still land in the normal app rather than
// re-scanning on every page load.
app.post('/api/user/onboarded', requireAuth, async (req, res) => {
  await redis.set(`onboarded:${req.user.email}`, new Date().toISOString());
  res.json({ ok: true });
});

// POST /api/gmail/reconnect — re-registers Gmail watch and clears disconnect flag
app.post('/api/gmail/reconnect', requireAuth, async (req, res) => {
  const refreshToken = await redis.get(`refreshToken:${req.user.email}`);
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token — please sign out and sign back in' });
  try {
    const data = await registerGmailWatch(req.user.email, refreshToken);
    await redis.del(`gmailDisconnected:${req.user.email}`);
    console.log(`[Gmail reconnect] Watch re-registered for ${req.user.email}`);
    res.json({ ok: true, expiration: data.expiration });
  } catch (err) {
    console.error('[Gmail reconnect] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/spend — what this account has cost today, and which paths caused it.
// The cap was shipped without any way to read the meter, which left the user
// asking "why is today expensive?" with the answer sitting unreadable in Redis.
app.get('/api/spend', requireAuth, async (req, res) => {
  const email = req.user.email;
  const days = Math.min(7, Math.max(1, Number(req.query.days) || 7));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const key = `spendMicroUsd:${String(email).toLowerCase()}:${d}`;
    const total = Number(await redis.get(key)) || 0;
    const raw = (await redis.hgetall(`${key}:by`)) || {};
    const byLabel = {};
    for (const [k, v] of Object.entries(raw)) {
      const [label, field] = k.split(':');
      byLabel[label] = byLabel[label] || { usd: 0, calls: 0 };
      if (field === 'micro') byLabel[label].usd = Number(v) / 1e6;
      if (field === 'calls') byLabel[label].calls = Number(v);
    }
    out.push({ date: d, usd: total / 1e6, byLabel });
  }
  const today = out[0];
  res.json({
    email, cap: DAILY_SPEND_CAP_USD,
    todayUsd: today.usd, remainingUsd: Math.max(0, DAILY_SPEND_CAP_USD - today.usd),
    capReached: today.usd >= DAILY_SPEND_CAP_USD,
    // Stated plainly: the meter only knows what it has seen. Spend from before
    // it shipped is not here, and reading this as a full history would
    // understate a day that was mostly billed before deploy.
    meteringSince: 'the daily spend cap deploy — earlier spend is not recorded here',
    days: out,
  });
});

// GET /api/events/status-breakdown — every event Criba holds, counted by status.
//
// Both feeds filter by status and neither says so. /api/events/pending wants
// added/pending/duplicate; /api/events/recent wants added/reviewed/approved/
// cancelled. A status in neither list — 'draft', which is what every iCal feed
// import is stored as until its calendar write succeeds — is invisible across
// the entire product. A failed write leaves it there permanently, and
// writeCalendarEvents reports only addedCount, so nothing says it happened.
//
// This exists so "I added them and they are nowhere" is answerable.
app.get('/api/events/status-breakdown', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const all = await events.values();
  const VISIBLE_IN_REVIEW = new Set(['added', 'pending', 'duplicate', 'pending_cancellation', 'pending_reschedule']);
  const VISIBLE_IN_EDIT = new Set(['added', 'reviewed', 'approved', 'cancelled']);
  const byStatus = {};
  for (const ev of all) {
    const k = ev.status || '(none)';
    byStatus[k] = byStatus[k] || { count: 0, visibleInReview: VISIBLE_IN_REVIEW.has(k), visibleInEdit: VISIBLE_IN_EDIT.has(k), examples: [] };
    byStatus[k].count++;
    if (byStatus[k].examples.length < 5) byStatus[k].examples.push({ title: ev.title, date: ev.date, source: ev.source || null });
  }
  const invisible = all.filter(ev => !VISIBLE_IN_REVIEW.has(ev.status) && !VISIBLE_IN_EDIT.has(ev.status));
  res.json({ total: all.length, byStatus, invisibleCount: invisible.length });
});

// GET /api/events/orphans — events Criba dismissed that are still on Google.
//
// Dismissing an event in the review queue only ever set status to 'dismissed'.
// That was written when everything in the queue was a draft, and the comment
// in dismissReviewEvent still says so. Under auto-write nothing in that queue
// is a draft: every card is already on the calendar. So the X button left the
// event sitting on Google while removing Criba's only handle on it — gone from
// the review queue, gone from the edit feed, uneditable and undeletable from
// inside Criba.
//
// This lists them, so an orphan can be found rather than merely suspected.
app.get('/api/events/orphans', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const all = await events.entries();
  const orphans = all
    .filter(([, ev]) => ev.status === 'dismissed' && ev.calEventId)
    .map(([id, ev]) => ({ id, title: ev.title, date: ev.date, time: ev.time || '',
      location: ev.location || '', source: ev.source || null, calEventId: ev.calEventId }))
    .sort((a, b) => (a.date || '') < (b.date || '') ? 1 : -1);
  res.json({ count: orphans.length, orphans });
});

// POST /api/events/restore — put a dismissed event back under Criba's control.
// It never left Google; this only restores Criba's ability to see and edit it.
app.post('/api/events/restore', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const event = await events.get(req.body.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  event.status = 'reviewed';
  event.reviewed = true;
  await events.set(req.body.id, event);
  await clearRefusal(req.user.email, event);
  res.json({ ok: true, title: event.title, date: event.date });
});

// GET /api/gmail/watch/status — diagnostic: check Redis watch state for the logged-in user
app.get('/api/gmail/watch/status', requireAuth, async (req, res) => {
  const email = req.user.email;
  const watchDataStr = await redis.get(`gmailWatch:${email}`);
  const refreshToken = await redis.get(`refreshToken:${email}`);
  const disconnectedAt = await redis.get(`gmailDisconnected:${email}`);
  const inWatchedSet = await redis.sismember('gmailWatchedUsers', email);
  if (!watchDataStr) {
    return res.json({ ok: false, email, registered: false, hasRefreshToken: !!refreshToken, inWatchedSet: !!inWatchedSet, disconnectedAt });
  }
  const watchData = JSON.parse(watchDataStr);
  const expMs = watchData.expiration ? parseInt(watchData.expiration) : null;
  const expiresAt = expMs ? new Date(expMs).toISOString() : null;
  const expiredAlready = expMs ? expMs < Date.now() : null;
  // The topic is configured only as an env var, so it appears nowhere in the
  // repo. Surfacing it here is the difference between "check Pub/Sub" and
  // knowing which project and topic to open. It is a resource path, not a
  // secret, and this route already requires a session.
  const topic = process.env.PUBSUB_TOPIC || null;
  const topicMatch = /^projects\/([^/]+)\/topics\/(.+)$/.exec(topic || '');
  const lastWebhookAt = await redis.get(`lastWebhookAt:${email}`);
  const backlog = await redis.get(`gmailBacklog:${email}`);
  res.json({ ok: true, email, registered: true, historyId: watchData.historyId, expiresAt, expiredAlready, hasRefreshToken: !!refreshToken, inWatchedSet: !!inWatchedSet, disconnectedAt,
    pubsubTopic: topic,
    pubsubProject: topicMatch ? topicMatch[1] : null,
    pubsubTopicId: topicMatch ? topicMatch[2] : null,
    // A live watch with no delivery ever recorded means Gmail is publishing
    // into a topic nobody is subscribed to.
    lastWebhookAt: lastWebhookAt || null,
    backlogPending: backlog || null });
});

// POST /api/gmail/webhook — receives Google Pub/Sub push notifications.
// Must be public (no requireAuth). Verified via Google-signed JWT in Authorization header.
app.post('/api/gmail/webhook', async (req, res) => {
  const webhookTs = new Date().toISOString();
  console.log(`[webhook] RECEIVED at ${webhookTs} — body keys: ${Object.keys(req.body || {}).join(',')}`);

  // Verify the request carries a valid Google-signed Bearer JWT
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    console.error('[webhook] REJECTED — missing Bearer token');
    return res.status(401).json({ error: 'Missing auth header' });
  }
  const token = authHeader.slice(7);
  try {
    const verifier = new google.auth.OAuth2();
    const ticket = await verifier.verifyIdToken({ idToken: token });
    const payload = ticket.getPayload();
    // Gmail push notifications are signed by this Google service account, and
    // ONLY this one is acceptable.
    //
    // This check used to read `!validEmails.includes(email) && !email_verified`.
    // Because that is an AND, any Google-issued token with a verified email
    // satisfied it — which is essentially every Google token in existence. In
    // practice the endpoint was open to anyone who could mint a Google ID token,
    // letting them force-process any mailbox Criba holds a refresh token for and
    // burn the Claude budget. Requiring the push service account closes it.
    //
    // Two different identities get confused here. Gmail publishes to the topic
    // as gmail-api-push. But a push subscription signs its OIDC token as
    // whatever service account is configured on the SUBSCRIPTION — so a
    // correctly created subscription can still be rejected here, with a 401
    // that looks like a security problem rather than a configuration one.
    // PUBSUB_PUSH_SA lets that account be allowlisted without a code change.
    const validEmails = ['gmail-api-push@system.gserviceaccount.com'];
    const extraSa = String(process.env.PUBSUB_PUSH_SA || '').trim();
    if (extraSa) validEmails.push(...extraSa.split(',').map(v => v.trim()).filter(Boolean));
    if (!payload.email_verified || !validEmails.includes(payload.email)) {
      console.error(`[webhook] token email "${payload.email}" — allowlist is [${validEmails.join(', ')}]. If the subscription is new, set PUBSUB_PUSH_SA to its push service account.`);
      console.error(`[webhook] REJECTED — token issuer "${payload.email}" not in allowlist`);
      return res.status(401).json({ error: 'Invalid token issuer' });
    }
    console.log(`[webhook] JWT verified — issuer=${payload.email}`);
  } catch (err) {
    console.error('[webhook] JWT verification failed:', err.message);
    return res.status(401).json({ error: 'JWT verification failed' });
  }

  const { message } = req.body || {};
  if (!message?.data) {
    console.log('[webhook] ACK — no message.data (keepalive ping)');
    return res.status(200).json({ ok: true });
  }

  let emailAddress, historyId;
  try {
    const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf-8'));
    emailAddress = decoded.emailAddress;
    historyId = decoded.historyId;
  } catch {
    console.error('[webhook] Failed to decode message.data');
    return res.status(200).json({ ok: true }); // ack malformed messages
  }

  console.log(`[webhook] Pub/Sub message for emailAddress=${emailAddress} historyId=${historyId} messageId=${message.messageId}`);
  // Proof of delivery, readable without Vercel log access. Its absence is the
  // single clearest signal that the push subscription is missing.
  if (emailAddress) await redis.set(`lastWebhookAt:${emailAddress}`, new Date().toISOString());

  if (!emailAddress) {
    console.error('[webhook] No emailAddress in decoded payload');
    return res.status(200).json({ ok: true });
  }

  const refreshToken = await redis.get(`refreshToken:${emailAddress}`);
  if (!refreshToken) {
    console.error(`[webhook] No refresh token in Redis for ${emailAddress} — cannot process`);
    return res.status(200).json({ ok: true });
  }

  // Process synchronously before responding — Vercel terminates functions
  // after the response is sent. 60-second limit is enough for ~6 emails.
  try {
    await processNewGmailEmails(emailAddress, refreshToken, historyId);
  } catch (err) {
    console.error('[webhook] processNewGmailEmails threw:', err.message);
  }

  console.log(`[webhook] DONE for ${emailAddress}`);
  res.status(200).json({ ok: true });
});

// GET /api/cron/ical — Vercel cron job. Re-reads every subscribed feed and
// makes the calendar match it. Silent by design: no email, no review queue.
// The user's point was that a parent adds a feed and forgets it, so a change
// months out is noise rather than news.
app.get('/api/cron/ical', async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasCronSecret = process.env.CRON_SECRET && req.headers['x-cron-secret'] === process.env.CRON_SECRET;
  if (!isVercelCron && !hasCronSecret) return res.status(401).json({ error: 'Unauthorized' });

  const emails = await redis.smembers('icalSubscribers');
  const totals = { calendars: 0, added: 0, updated: 0, removed: 0, errors: [] };

  for (const email of emails) {
    try {
      const cals = getUserCalendars(email);
      const feeds = (await cals.values()).filter(c => c.source === 'ical' && c.url);
      // Nothing left to sync — stop visiting this user every night.
      if (!feeds.length) { await redis.srem('icalSubscribers', email); continue; }
      for (const cal of feeds) {
        try {
          const r = await syncIcalCalendar(email, cal);
          totals.calendars++;
          totals.added += r.added; totals.updated += r.updated; totals.removed += r.removed;
          cal.last_synced_at = new Date().toISOString();
          cal.last_sync_error = null;
          await cals.set(cal.id, cal);
        } catch (err) {
          console.error(`[ical sync] ${email} / ${cal.name}:`, err.message);
          totals.errors.push({ email, calendar: cal.name, error: err.message });
          // Surfaced in the subscriptions list so a feed that quietly stopped
          // working is visible rather than just silently stale.
          cal.last_sync_error = err.message;
          await cals.set(cal.id, cal);
        }
      }
    } catch (err) {
      console.error(`[ical sync] user ${email}:`, err.message);
      totals.errors.push({ email, error: err.message });
    }
  }
  res.json({ ok: true, ...totals });
});

// GET /api/cron/gmail — Vercel cron job (daily at 2am UTC).
// Renews expiring Gmail watches and sends evening notification emails.
app.get('/api/cron/gmail', async (req, res) => {
  // Accept calls from Vercel cron (x-vercel-cron header) or from CRON_SECRET
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasCronSecret = process.env.CRON_SECRET && req.headers['x-cron-secret'] === process.env.CRON_SECRET;
  if (!isVercelCron && !hasCronSecret) return res.status(401).json({ error: 'Unauthorized' });

  const watchedEmails = await redis.smembers('gmailWatchedUsers');
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  let renewedCount = 0;
  let notifiedCount = 0;
  let drainedCount = 0;

  for (const email of watchedEmails) {
    try {
      // Renew watch if expiring within 24 hours
      const watchDataStr = await redis.get(`gmailWatch:${email}`);
      if (watchDataStr) {
        const watchData = JSON.parse(watchDataStr);
        if (!watchData.expiration || parseInt(watchData.expiration) - now < oneDayMs) {
          const refreshToken = await redis.get(`refreshToken:${email}`);
          if (refreshToken) {
            try {
              await registerGmailWatch(email, refreshToken);
              renewedCount++;
              // Clear any existing disconnect flag on successful renewal
              await redis.del(`gmailDisconnected:${email}`);
            } catch (watchErr) {
              // Watch renewal failed — flag the user's Gmail connection as broken
              const disconnectTs = new Date().toISOString();
              await redis.set(`gmailDisconnected:${email}`, disconnectTs);
              console.error(`[Gmail disconnect] Watch renewal failed for ${email} at ${disconnectTs}:`, watchErr.message);
            }
          } else {
            // No refresh token — flag as disconnected
            await redis.set(`gmailDisconnected:${email}`, new Date().toISOString());
            console.error(`[Gmail disconnect] No refresh token found for ${email} — marking disconnected`);
          }
        }
      } else {
        // In the watched set but holding no watch record. Google keeps pushing
        // notifications because the watch exists on ITS side; Criba just has no
        // cursor to interpret them with, so every delivery aborts at the top of
        // runGmailExtraction and returns done. Nothing retries, nothing is
        // flagged, and the user's screen looks healthy while not one email is
        // ever processed. The old code tested `if (watchDataStr)` and offered no
        // else, so this state was permanent: the one case that most needs
        // re-registering was the only one that could never get it.
        const refreshToken = await redis.get(`refreshToken:${email}`);
        if (refreshToken) {
          try {
            await registerGmailWatch(email, refreshToken);
            renewedCount++;
            await redis.del(`gmailDisconnected:${email}`);
            console.warn(`[Gmail watch] ${email} was in the watched set with no watch record — re-registered`);
          } catch (watchErr) {
            await redis.set(`gmailDisconnected:${email}`, new Date().toISOString());
            console.error(`[Gmail watch] re-register failed for ${email}:`, watchErr.message);
          }
        } else {
          // Nothing can be rebuilt without a token. Say so on screen rather
          // than leaving a mailbox that silently processes nothing.
          await redis.set(`gmailDisconnected:${email}`, new Date().toISOString());
          console.error(`[Gmail disconnect] ${email} has no watch record and no refresh token`);
        }
      }

      // Drain anything a previous run had to defer. Without this a mailbox
      // that stopped mid-batch waits for the next incoming email to nudge it,
      // which on a quiet weekend can be days.
      const backlog = await redis.get(`gmailBacklog:${email}`);
      if (backlog) {
        const refreshToken = await redis.get(`refreshToken:${email}`);
        if (refreshToken) {
          console.log(`[cron] draining Gmail backlog for ${email}`);
          await processNewGmailEmails(email, refreshToken, backlog || undefined);
          drainedCount++;
        }
      }

      // Send notification if user has pending Gmail events
      const eventsStore = getUserEvents(email);
      const pendingGmail = (await eventsStore.values()).filter(e => (e.status === 'pending' || (e.status === 'added' && !e.reviewed)) && e.source === 'gmail');
      if (pendingGmail.length > 0) {
        await sendNotificationEmail(email, pendingGmail.length, pendingGmail.map(e => e.title));
        notifiedCount++;
      }
    } catch (err) {
      console.error(`Cron error for ${email}:`, err.message);
    }
  }

  res.json({ ok: true, watchedUsers: watchedEmails.length, renewedCount, notifiedCount, drainedCount });
});

// Exposes non-secret client-side configuration. The Places API key is
// publishable (it's restricted by HTTP referrer in Google Cloud Console)
// so returning it here is safe — it never exposes server secrets.
app.get('/api/config', (req, res) => {
  // Trimmed: a key pasted into the dashboard with a leading space goes into
  // the Maps script URL as "key=%20AIza...", which Google rejects. Nothing
  // throws — Autocomplete constructs fine and then silently returns no
  // predictions, so the location field just quietly stops suggesting.
  res.json({ placesApiKey: String(process.env.GOOGLE_PLACES_API_KEY || '').trim() });
});

// Noise labels used by the live webhook path only. The backfill uses a positive
// CATEGORY_PERSONAL (Primary tab) check instead — see backfill endpoint below.
const GMAIL_NOISE_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']);

// ── Event date normalizer ──────────────────────────────────────────────────
// Claude sometimes returns partial dates ("August 12", "Aug 12", "8/12") without
// a year, especially from newsletter/digest content that doesn't restate the year.
// Given the email's received date, infer the most plausible year:
//   - If the resulting date is in the past relative to the email date, use year+1.
//   - Accepts ISO "YYYY-MM-DD", slash "M/D[/YY]", and "Month D[th]" natural language.
// Returns a "YYYY-MM-DD" string, or null if parsing fails.
const MONTH_ABBRS = {
  january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
  july:'07',august:'08',september:'09',october:'10',november:'11',december:'12',
  jan:'01',feb:'02',mar:'03',apr:'04',jun:'06',jul:'07',aug:'08',
  sep:'09',oct:'10',nov:'11',dec:'12',
};

function normalizeEventDate(rawDate, emailDateStr) {
  if (!rawDate) return null;
  const d = String(rawDate).trim();

  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;

  // Reference year from email received date (or today as fallback)
  const ref = emailDateStr ? new Date(emailDateStr) : new Date();
  const refYear = isNaN(ref.getFullYear()) ? new Date().getFullYear() : ref.getFullYear();

  // Slash format: M/D, M/D/YY, M/D/YYYY
  const slashMatch = d.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    let year = slashMatch[3] ? parseInt(slashMatch[3], 10) : null;
    if (year && year < 100) year += 2000;
    const mon = String(slashMatch[1]).padStart(2, '0');
    const day = String(slashMatch[2]).padStart(2, '0');
    if (!year) {
      year = refYear;
      const candidate = new Date(`${year}-${mon}-${day}`);
      if (candidate < ref) year++;
    }
    const iso = `${year}-${mon}-${day}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  }

  // Natural language: "August 12", "Aug 12th", "August 12, 2026"
  const nlMatch = d.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s]+(\d{4}))?$/i);
  if (nlMatch) {
    const monKey = nlMatch[1].toLowerCase();
    const mon = MONTH_ABBRS[monKey];
    if (!mon) return null;
    const day = String(nlMatch[2]).padStart(2, '0');
    let year = nlMatch[3] ? parseInt(nlMatch[3], 10) : null;
    if (!year) {
      year = refYear;
      const candidate = new Date(`${year}-${mon}-${day}`);
      if (candidate < ref) year++;
    }
    return `${year}-${mon}-${day}`;
  }

  return null;
}

// ── Snippet-based calendar-signal scanner (backfill pre-filter, Parts 2-3) ──
// Runs against subject + Gmail snippet (~200 chars) at Stage 1.
// If the snippet is too short to be conclusive, the message is escalated to a
// full Stage 2 body fetch rather than skipped — recall beats efficiency.
// Patterns are intentionally generous: a false positive costs one Claude call;
// a false negative silently loses a real event.
const SNIPPET_DATE_PATTERNS = [
  { name: 'time',       re: /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i },
  { name: 'date-slash', re: /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/ },
  // \d{1,2}(?:st|nd|rd|th)? covers plain numbers AND ordinal suffixes:
  // "July 15", "July 15th", "the 3rd", "August 22nd", "due on the 1st"
  // "sept" needs its own branch: sep(?:tember)? matches "sep" or "september"
  // and nothing in between, so "Sept 3" — the way most people actually write a
  // September date — did not register as a date at all.
  { name: 'month-day',  re: /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?/i },
  // Also catch bare ordinals near common date prepositions: "due on the 15th", "by the 3rd"
  { name: 'ordinal',    re: /\b(?:on|by|the|due)\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)\b/i },
  { name: 'weekday',    re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i },
  { name: 'relative',   re: /\b(today|tomorrow|this week|next week|this weekend)\b/i },
  // Dotted dates: "Invoice 8.21.26". Kept tight — three dot-separated numbers
  // is a date; anything looser starts matching version numbers and distances.
  { name: 'date-dots',  re: /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/ },
];

// Things that need doing but name no date.
//
// The prefilter looked for dates and nothing else, while the extractor is built
// to return deadlines, action items and financial reminders. The two disagreed,
// and the gate won: "Past-Due Recreation Balance", "$219.00 payment to CLEAR was
// unsuccessful again" and both Verdura invoices were dropped at SKIP-BODY
// without ever reaching Claude. A past-due balance is the most actionable mail
// in the inbox and it almost never carries a date — that is what "past due"
// means.
//
// These only widen what gets read. Nothing here decides an event exists; Claude
// still does that, and returns nothing for a genuine receipt.
const ACTIONABLE_PATTERNS = [
  { name: 'money',      re: /\$\s?\d/ },
  { name: 'owing',      re: /\b(past[-\s]?due|overdue|balance|amount due|payment due|unpaid|outstanding|invoice|statement|autopay|declined|unsuccessful)\b/i },
  { name: 'obligation', re: /\b(deadline|due date|rsvp|sign[-\s]?up|register|renew|expires?|last day|reminder|action required|respond by|submit)\b/i },
];
// Returns { pass, matchName, matchValue } if a calendar signal was found in the
// snippet, or { pass: false, escalate: true } in all no-match cases.
//
// Design: recall beats efficiency. A snippet no-match is never a confident skip —
// the event details may be in the body (past the ~200-char snippet truncation),
// in an image, or in a forwarded/quoted block the snippet doesn't reach.
// All no-match snippets escalate to Stage 2 (full body fetch). Stage 2 then runs
// the same pattern scan on the body and decides whether to call Claude.
// Gmail API full-body fetches are free; the only cost gate is Claude calls,
// which Stage 2 controls via the MAX_FULL_FETCHES budget.
// snippetLen param is kept for API compatibility but no longer drives skip logic.
function scanForDateContent(text, snippetLen) {
  if (!text || text.trim().length === 0) return { pass: false, escalate: true };
  for (const { name, re } of [...SNIPPET_DATE_PATTERNS, ...ACTIONABLE_PATTERNS]) {
    const m = text.match(re);
    if (m) return { pass: true, matchName: name, matchValue: m[0] };
  }
  // No match in snippet — always escalate to full-body check, never skip outright.
  return { pass: false, escalate: true };
}

// How long between live backfill scans per user (Part 6 rate-limit).
// Controls cost from repeated re-scans, not from scan thoroughness.
const BACKFILL_COOLDOWN_SEC = 24 * 60 * 60;

// ── Scan trace (per-email diagnostics written to Redis) ───────────────────
// Every pipeline decision is appended to `scanTrace:{email}` (a Redis list,
// capped at SCAN_TRACE_MAX entries). Queryable via GET /api/scan/trace after
// any scan — no Vercel log access needed to debug missed emails.
const SCAN_TRACE_MAX = 600;

async function traceEmail(email, entry) {
  const key = `scanTrace:${email}`;
  await redis.lpush(key, JSON.stringify({ ts: Date.now(), ...entry }));
  await redis.ltrim(key, 0, SCAN_TRACE_MAX - 1);
  await redis.expire(key, 7 * 24 * 60 * 60); // 7-day TTL
}

// GET /api/scan/trace — returns the last N pipeline decisions for the logged-in user
app.get('/api/scan/trace', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), SCAN_TRACE_MAX);
  const raw = await redis.lrange(`scanTrace:${req.user.email}`, 0, limit - 1);
  res.json(raw.map(r => JSON.parse(r)));
});

// GET /api/debug/duplicates — group stored events by title and report clusters.
//
// The point is to tell apart two very different causes that look identical on
// Google Calendar: Criba writing the same event twice (two records here), and
// Criba writing once while a subscribed feed like a club's iCal supplies the
// other copy (one record here). Only the first is a bug in this codebase.
// GET so it opens in a browser with the session cookie.
app.get('/api/debug/duplicates', requireAuth, async (req, res) => {
  const all = await getUserEvents(req.user.email).values();
  const groups = new Map();
  for (const ev of all) {
    if (ev.status === 'dismissed') continue;
    const key = (ev.title || '').toLowerCase().trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const clusters = [];
  for (const [title, evs] of groups) {
    if (evs.length < 2) continue;
    clusters.push({
      title,
      count: evs.length,
      // Same title on the same date is a straight duplicate. Same title on
      // different dates is usually just a legitimately repeating fixture.
      distinctDates: [...new Set(evs.map(e => e.date))].length,
      copies: evs.map(e => ({
        id: e.id, date: e.date, time: e.time || '', status: e.status,
        source: e.source || '', calEventId: e.calEventId || null,
        recurrence_rule: e.recurrence_rule || null,
        created_at: e.created_at || null,
      })).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
    });
  }
  clusters.sort((a, b) => b.count - a.count);
  res.json({
    totalEvents: all.length,
    duplicateTitles: clusters.length,
    // Same title AND same date — the ones dedup should have caught.
    sameDateClusters: clusters.filter(c => c.distinctDates < c.count).length,
    clusters: clusters.slice(0, 40),
  });
});

// GET /api/debug/calendar-duplicates?days=120 — read-only.
//
// Reads the actual Google Calendar rather than Criba's store, and reads EVERY
// calendar the user is subscribed to, not just the one Criba writes to. Both
// details matter: Criba has written series it no longer holds records for
// (orphans), and the collisions the user actually sees are often Criba's copy
// on the primary calendar versus a club's iCal feed on a separate calendar —
// a comparison no single-calendar query can make.
//
// Changes nothing. Reports clusters so we can decide what to delete.
async function scanCalendarDuplicates(user, days) {
  const auth = await getUserOAuthClient(user);
  const calendar = google.calendar({ version: 'v3', auth });
  const timeMin = new Date();
  const timeMax = new Date(Date.now() + days * 86400000);

  // Sessions created before the calendarlist scope was added cannot list
  // calendars. Degrade to the primary calendar rather than failing outright —
  // a partial scan still finds Criba-wrote-it-twice, just not cross-calendar
  // collisions. scopeLimited tells the caller which kind of answer this is.
  let calendars, scopeLimited = false;
  try {
    const list = await calendar.calendarList.list({ maxResults: 250, fields: 'items(id,summary)' });
    calendars = (list.data.items || []).map(c => ({ id: c.id, name: c.summary || c.id }));
  } catch (err) {
    if (err.code !== 403 && !/insufficient/i.test(err.message || '')) throw err;
    scopeLimited = true;
    calendars = [{ id: 'primary', name: 'primary' }];
  }

  const all = [];
  const calendarErrors = [];
  for (const cal of calendars) {
    try {
      const resp = await calendar.events.list({
        calendarId: cal.id,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,   // expand recurring series into dated instances
        maxResults: 2500,
        fields: 'items(id,summary,description,start,end,recurringEventId,attendees(email))',
      });
      for (const it of resp.data.items || []) {
        const date = it.start?.date || (it.start?.dateTime || '').slice(0, 10);
        if (!date) continue;
        const desc = it.description || '';
        // Used to break ties: between two Criba copies of the same practice,
        // the one carrying guests is the one whose invite people actually got.
        const guests = (it.attendees || []).length;
        all.push({
          calendarId: cal.id, calendarName: cal.name, guests,
          eventId: it.id, seriesId: it.recurringEventId || null,
          title: it.summary || '', date,
          time: it.start?.dateTime ? it.start.dateTime.slice(11, 16) : '',
          endTime: it.end?.dateTime ? it.end.dateTime.slice(11, 16) : '',
          isAllDay: !!it.start?.date,
          // "Added via Criba" is stamped on everything we write. The dangling
          // "— recurring:" suffix additionally marks the older buggy writes,
          // which makes it a reliable discriminator when two Criba series
          // collide and we have to choose which one to keep.
          fromCriba: /Added via Criba/i.test(desc),
          legacyMarker: /Added via Criba\s*—\s*recurring:\s*$/i.test(desc.trim()),
        });
      }
    } catch (err) {
      calendarErrors.push({ calendar: cal.name, error: err.message });
    }
  }

  // Group by date, then cluster within the date by loose title match and
  // near-identical start time — the same test the write path uses, so what
  // this reports and what Criba suppresses stay in agreement.
  const byDate = new Map();
  for (const ev of all) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  }
  const clusters = [];
  for (const [date, evs] of byDate) {
    const used = new Set();
    for (let i = 0; i < evs.length; i++) {
      if (used.has(i)) continue;
      const group = [evs[i]];
      for (let j = i + 1; j < evs.length; j++) {
        if (used.has(j)) continue;
        if (!titlesLooselyMatch(evs[i].title, evs[j].title)) continue;
        const bothTimed = evs[i].time && evs[j].time && !evs[i].isAllDay && !evs[j].isAllDay;
        if (bothTimed && Math.abs(timeToMinutes(evs[i].time) - timeToMinutes(evs[j].time)) > 30) continue;
        used.add(j);
        group.push(evs[j]);
      }
      if (group.length < 2) continue;
      used.add(i);
      const cribaCopies = group.filter(g => g.fromCriba).length;
      clusters.push({
        date,
        title: group[0].title,
        count: group.length,
        // Two Criba copies is our bug. One Criba copy plus a feed copy is a
        // collision with someone else's data — different problem, different fix.
        kind: cribaCopies >= 2 ? 'criba-wrote-twice'
            : cribaCopies === 1 ? 'criba-vs-external'
            : 'external-only',
        crossCalendar: new Set(group.map(g => g.calendarId)).size > 1,
        copies: group.map(g => ({
          calendar: g.calendarName, calendarId: g.calendarId,
          title: g.title, time: g.time || 'all-day',
          eventId: g.eventId, seriesId: g.seriesId, guests: g.guests,
          fromCriba: g.fromCriba, legacyMarker: g.legacyMarker,
        })),
      });
    }
  }
  clusters.sort((a, b) => a.date.localeCompare(b.date));

  // A recurring series collides once per instance; collapse to series pairs so
  // a weekly clash reads as one problem instead of sixteen.
  const seriesPairs = new Map();
  for (const c of clusters) {
    const key = c.copies.map(x => x.seriesId || x.eventId).sort().join('|');
    if (!seriesPairs.has(key)) seriesPairs.set(key, { ...c, occurrences: 0, firstDate: c.date, lastDate: c.date });
    const s = seriesPairs.get(key);
    s.occurrences++;
    s.lastDate = c.date;
  }

  const problems = [...seriesPairs.values()].map(p => ({
    title: p.title, kind: p.kind, crossCalendar: p.crossCalendar,
    occurrences: p.occurrences, firstDate: p.firstDate, lastDate: p.lastDate,
    copies: p.copies,
  }));

  return { calendars, calendarErrors, all, clusters, problems, auth, scopeLimited };
}

app.get('/api/debug/calendar-duplicates', requireAuth, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 120, 1), 400);
  try {
    const r = await scanCalendarDuplicates(req.user, days);
    res.json({
      windowDays: days,
      scopeLimited: r.scopeLimited,
      scopeNote: r.scopeLimited
        ? 'Only the primary calendar was read — sign out and back in to grant calendar-list access and see cross-calendar duplicates.'
        : undefined,
      calendarsScanned: r.calendars.map(c => c.name),
      calendarErrors: r.calendarErrors,
      totalEventsScanned: r.all.length,
      duplicateInstances: r.clusters.length,
      distinctProblems: r.problems.length,
      problems: r.problems,
      instances: r.clusters.slice(0, 60),
    });
  } catch (err) {
    res.status(502).json({ error: 'calendar scan failed', detail: err.message });
  }
});

// Which copy in a cluster should be deleted?
//
// Deliberately narrow. Only clusters where Criba wrote BOTH copies are
// eligible: those are unambiguously our bug, and both copies are ours to
// remove. A Criba copy colliding with a club feed is NOT touched here —
// deciding which of those to keep is the user's call, not a heuristic's.
//
// Within an eligible cluster we keep exactly one copy and delete the rest,
// preferring to keep the one with guests (its invite already went out) and,
// failing that, the one without the legacy "— recurring:" description, which
// marks the older buggy write.
function chooseDuplicatesToDelete(problem) {
  if (problem.kind !== 'criba-wrote-twice') return [];
  const criba = problem.copies.filter(c => c.fromCriba);
  if (criba.length < 2) return [];
  const ranked = [...criba].sort((a, b) => {
    if (a.guests !== b.guests) return b.guests - a.guests;       // guests first
    if (a.legacyMarker !== b.legacyMarker) return a.legacyMarker ? 1 : -1;  // clean description first
    return String(a.eventId).localeCompare(String(b.eventId));   // stable
  });
  return ranked.slice(1);
}

// POST /api/calendar/reset — remove everything Criba ever wrote. Dry run
// unless { confirm: "DELETE ALL CRIBA EVENTS" }.
//
// For starting over after a testing period. Identification is by the
// "Added via Criba" description stamp, which only our own writes carry, so
// events the user created by hand and events from subscribed feeds are never
// candidates. Recurring series are deleted once, not per instance.
app.post('/api/calendar/reset', requireAuth, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 365, 1), 730);
  // Testing wrote events in the past too, so look back as well as forward.
  const back = Math.min(Math.max(parseInt(req.body?.daysBack, 10) || 180, 0), 730);
  const confirmed = req.body?.confirm === 'DELETE ALL CRIBA EVENTS';

  const auth = await getUserOAuthClient(req.user);
  const calendar = google.calendar({ version: 'v3', auth });
  const timeMin = new Date(Date.now() - back * 86400000);
  const timeMax = new Date(Date.now() + days * 86400000);

  // Only calendars we could have written to. Subscribed feeds are read-only
  // and are skipped entirely rather than attempted and failed.
  let cals;
  try {
    cals = await visibleCalendars(calendar, await resolveTargetCalendar(req.user.email));
  } catch (err) {
    return res.status(502).json({ error: 'could not list calendars', detail: err.message });
  }

  const found = new Map();   // series/event id -> record
  const errors = [];
  // What each calendar actually returned. Without this, "no event carries the
  // Criba stamp" and "every read came back empty" look identical from outside,
  // and we report the reassuring one when it may well have been the other.
  const seen = [];
  const sample = [];
  for (const cal of cals) {
    try {
      const resp = await calendar.events.list({
        calendarId: cal.id, timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
        singleEvents: true, maxResults: 2500,
        fields: 'items(id,summary,description,start,recurringEventId)',
      });
      const items = resp.data.items || [];
      seen.push({
        calendar: cal.name, id: cal.id, events: items.length,
        withDescription: items.filter(i => i.description).length,
      });
      for (const it of items) {
        // Prefer events that actually carry a description. A sample of eight
        // untitled birthdays tells us nothing about why the stamp didn't match.
        if (sample.length < 8 && it.description) {
          sample.push({
            calendar: cal.name, title: it.summary || '(no title)',
            date: it.start?.date || (it.start?.dateTime || '').slice(0, 10),
            hasDescription: !!it.description,
            descriptionStart: (it.description || '').slice(0, 60),
          });
        }
        if (!/Added via Criba/i.test(it.description || '')) continue;
        const id = it.recurringEventId || it.id;
        if (found.has(id)) { found.get(id).instances++; continue; }
        found.set(id, {
          deleteId: id, calendarId: cal.id, calendar: cal.name,
          title: it.summary || '', isSeries: !!it.recurringEventId, instances: 1,
          firstDate: it.start?.date || (it.start?.dateTime || '').slice(0, 10),
        });
      }
    } catch (err) {
      errors.push({ calendar: cal.name, error: err.message });
    }
  }

  const plan = [...found.values()];
  if (!confirmed) {
    return res.json({
      dryRun: true, windowFrom: timeMin.toISOString().slice(0, 10), windowTo: timeMax.toISOString().slice(0, 10),
      calendarsScanned: cals.map(c => c.name), calendarErrors: errors,
      calendarsRead: seen,
      totalEventsSeen: seen.reduce((n, s) => n + s.events, 0),
      sampleOfWhatWasSeen: sample,
      wouldDelete: plan.length,
      totalInstances: plan.reduce((n, p) => n + p.instances, 0),
      plan,
      note: 'Nothing was deleted. Re-send with {"confirm":"DELETE ALL CRIBA EVENTS"} to apply.',
    });
  }

  const deleted = [], failed = [];
  for (const t of plan) {
    try {
      await calendar.events.delete({ calendarId: t.calendarId, eventId: t.deleteId, sendUpdates: 'none' });
      deleted.push(t);
    } catch (err) {
      if (err.code === 410 || err.code === 404) deleted.push({ ...t, alreadyGone: true });
      else failed.push({ ...t, error: err.message });
    }
  }

  // Clear Criba's own records too, otherwise the review queue and Edit
  // Calendar Events still list events that no longer exist.
  const store = getUserEvents(req.user.email);
  let storeCleared = 0;
  if (req.body?.keepStore !== true) {
    for (const ev of await store.values()) {
      if (ev.calEventId || ev.status === 'added' || ev.status === 'reviewed' || ev.status === 'duplicate') {
        await store.delete(ev.id);
        storeCleared++;
      }
    }
  }

  res.json({ dryRun: false, deleted: deleted.length, failed: failed.length, storeCleared, failedItems: failed });
});

// POST /api/calendar/cleanup-duplicates — dry run unless { confirm: "DELETE" }.
//
// Deletes the whole recurring series (seriesId) rather than single instances,
// since a duplicated weekly practice is one wrong series, not sixteen wrong
// events. Never touches anything Criba did not write.
app.post('/api/calendar/cleanup-duplicates', requireAuth, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 180, 1), 400);
  const confirmed = req.body?.confirm === 'DELETE';
  let scan;
  try {
    scan = await scanCalendarDuplicates(req.user, days);
  } catch (err) {
    return res.status(502).json({ error: 'calendar scan failed', detail: err.message });
  }

  // Collapse to unique targets — one recurring series produces the same
  // delete target on every one of its dates.
  const targets = new Map();
  const skipped = [];
  for (const p of scan.problems) {
    const doomed = chooseDuplicatesToDelete(p);
    if (!doomed.length) {
      skipped.push({ title: p.title, kind: p.kind, reason: p.kind === 'criba-vs-external'
        ? 'one copy came from a subscribed feed — needs your decision'
        : 'no Criba-written duplicate pair' });
      continue;
    }
    for (const d of doomed) {
      const id = d.seriesId || d.eventId;
      if (targets.has(id)) continue;
      targets.set(id, {
        title: d.title, calendar: d.calendar, calendarId: d.calendarId,
        deleteId: id, isSeries: !!d.seriesId, guests: d.guests,
        legacyMarker: d.legacyMarker, occurrences: p.occurrences,
        keeping: p.copies.find(c => c.fromCriba && (c.seriesId || c.eventId) !== id)?.eventId || null,
      });
    }
  }

  const plan = [...targets.values()];
  if (!confirmed) {
    return res.json({ dryRun: true, wouldDelete: plan.length, plan, skipped,
      note: 'Nothing was deleted. Re-send with {"confirm":"DELETE"} to apply.' });
  }

  const calendar = google.calendar({ version: 'v3', auth: scan.auth });
  const deleted = [], failed = [];
  for (const t of plan) {
    try {
      // sendUpdates:'none' — these are Criba's own duplicate copies; the
      // people on them should not get a cancellation email for an event that
      // still exists on their calendar via the copy we are keeping.
      await calendar.events.delete({ calendarId: t.calendarId, eventId: t.deleteId, sendUpdates: 'none' });
      deleted.push(t);
    } catch (err) {
      // 410 means it is already gone, which is the outcome we wanted.
      if (err.code === 410 || err.code === 404) deleted.push({ ...t, alreadyGone: true });
      else failed.push({ ...t, error: err.message });
    }
  }
  // Keep the store honest: any record pointing at an event we just removed
  // would otherwise show in Edit Calendar Events as if it were still live.
  const goneIds = new Set(deleted.map(d => d.deleteId));
  const store = getUserEvents(req.user.email);
  let storeCleared = 0;
  for (const ev of await store.values()) {
    if (ev.calEventId && goneIds.has(ev.calEventId)) {
      ev.status = 'dismissed';
      ev.calEventId = null;
      await store.set(ev.id, ev);
      storeCleared++;
    }
  }

  res.json({ dryRun: false, deleted: deleted.length, failed: failed.length, storeCleared, deletedItems: deleted, failed, skipped });
});

// DELETE /api/scan/trace — clear the trace log for the logged-in user
app.delete('/api/scan/trace', requireAuth, async (req, res) => {
  await redis.del(`scanTrace:${req.user.email}`);
  res.json({ ok: true });
});

// Approximate token cost of FULL_EXTRACTION_PROMPT alone (chars / 4).
// Used by dry-run to estimate how many input tokens a real extraction would spend.
const PROMPT_TOKENS_ESTIMATE = Math.ceil(FULL_EXTRACTION_PROMPT.length / 4);
// Claude's typical input token cost per inline/attached image (varies by resolution;
// 1600 is a conservative mid-range estimate for a typical email flyer or screenshot).
const IMAGE_TOKENS_ESTIMATE = 1600;

// POST /api/gmail/backfill — scan recent Gmail inbox for calendar events.
// Default window: 2 days (48h). Max Claude extractions per run: 10.
// Recall-first Gmail backfill. Priority: missing a real event is worse than an unnecessary
// Claude call. Cost is controlled via batching (Part 4) and scan-frequency rate-limiting
// (Part 6), not by aggressively filtering out messages.
//
// Pipeline per message:
//   Stage 1 (cheap, metadata + snippet): Primary-tab filter → dedup → snippet pattern scan
//   Escalation: short/ambiguous snippets → Stage 2 regardless (Gmail fetches are free)
//   Stage 2 (full body): pattern scan on body → image-heavy bypass → Claude (Part 5)
//
// Batching: each invocation does ≤ MAX_FULL_FETCHES Stage 2 fetches, then returns
//   { truncated: true, nextOffset } for the frontend to chain the next batch.
//
// DELETE /api/gmail/backfill-cooldown — clears the 24h rate-limit timestamp so the user
// can run a fresh scan immediately. Useful after a timed-out scan or a pipeline fix.
// GET /api/debug/extract?q=<gmail search> — run the extraction pipeline against a
// single email and return every intermediate value: the body we pulled out, its
// length, and the model's raw reply before parsing. Deliberately a GET so it can
// be opened straight from the browser with the session cookie.
//
// This exists because a whole-scan trace can only ever say events=0; it cannot
// say whether the model was given the schedule or what it replied.
app.get('/api/debug/extract', requireAuth, async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'pass ?q=<gmail search query>' });
  try {
    const auth = await getUserOAuthClient(req.user);
    const gmail = google.gmail({ version: 'v1', auth });
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 1 });
    const id = list.data.messages?.[0]?.id;
    if (!id) return res.json({ error: 'no message matched', q });

    const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const headers = full.data.payload.headers || [];
    const h = (n) => headers.find(x => x.name.toLowerCase() === n)?.value || '';
    const body = extractEmailBody(full.data.payload);
    const subject = h('subject');
    const dateSent = h('date');

    const preFilter = scanForDateContent(`${subject} ${body.slice(0, 5000)}`);
    let extracted = null, extractError = null;
    try {
      extracted = await extractGmailEvents(body, h('from'), h('from'), subject, [], dateSent, [], req.user.email);
    } catch (err) {
      extractError = err.message;
    }
    res.json({
      messageId: id, subject, dateSent,
      bodyLength: body.length, truncated: body.length > EXTRACTION_CHAR_LIMIT, limit: EXTRACTION_CHAR_LIMIT,
      preFilterPassed: preFilter.pass,
      body,
      eventCount: extracted ? extracted.length : null,
      extractError,
      extracted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/debug/writes — for every event Criba holds, report whether it made
// it onto the calendar (calEventId), or was skipped by the duplicate check
// (duplicate_of), or never got as far as a write attempt.
//
// The reset scan can only see events that exist. When it finds nothing, this
// says whether that is because nothing was ever written.
app.get('/api/debug/writes', requireAuth, async (req, res) => {
  try {
    const all = await getUserEvents(req.user.email).values();
    const rows = all.map(ev => ({
      id: ev.id, title: ev.title, date: ev.date, status: ev.status,
      calEventId: ev.calEventId || null,
      skippedAsDuplicate: ev.duplicate_of
        ? `${ev.duplicate_of.title} on ${ev.duplicate_of.calendarName || '?'}`
        : null,
    }));
    const counts = rows.reduce((acc, r) => {
      const bucket = r.calEventId ? 'written' : r.skippedAsDuplicate ? 'skippedAsDuplicate' : 'noWriteAttempt';
      acc[bucket] = (acc[bucket] || 0) + 1;
      acc[`status:${r.status}`] = (acc[`status:${r.status}`] || 0) + 1;
      return acc;
    }, {});
    res.json({ total: rows.length, counts, events: rows });
  } catch (err) {
    res.status(500).json({ error: 'debug writes failed', detail: err.message });
  }
});

// GET /api/debug/decisions — read-only preview of a decision layer that does
// not exist yet. Writes nothing, changes nothing, and is not consulted by any
// live code path. Its whole purpose is to show what such a layer would have
// done, against real data, before it is allowed to do anything.
//
// A decision is "the user said no to this event on this date". It is derived
// here from the statuses that already record a refusal — dismissed, cancelled,
// rejected — because those rows are currently the only record of intent that
// exists anywhere. Date-scoped deliberately: a decision about one date can only
// ever cause an event to resurface for review, while a title-scoped one could
// silently suppress a genuinely different future event that happens to be
// worded alike. Resurfacing is recoverable; silent suppression is the failure
// this whole exercise exists to remove.
//
// Keyed with decisionKey below, which is Jishnu's write-guard normalisation
// (:1034) — tested over 523 stored events with zero false merges. Its known
// weakness is the other direction: a title reworded between emails yields a
// different key. That limit is reported here rather than hidden, as
// keyRewordingRisk.
function decisionKey(date, title) {
  return `${date || ''}|${String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

const DECISION_STATUSES = new Set(['dismissed', 'cancelled', 'rejected']);

// Read-only reconstruction of past refusals from historical statuses — used by
// the two debug endpoints only. Deliberately NOT a migration: nothing here is
// ever written to the decisions store. Earliest row wins, matching how a real
// decision would have been recorded at the time.
function deriveRefusalsFromHistory(all) {
  const m = new Map();
  for (const ev of all) {
    if (!DECISION_STATUSES.has(ev.status)) continue;
    const k = decisionKey(ev.date, ev.title);
    const prev = m.get(k);
    if (!prev || (ev.created_at || '') < (prev.decided_at || '')) {
      m.set(k, { key: k, title: ev.title, date: ev.date, status: ev.status, decided_at: ev.created_at || null });
    }
  }
  return m;
}

app.get('/api/debug/decisions', requireAuth, async (req, res) => {
  try {
    const all = await getUserEvents(req.user.email).values();

    // Every refusal on record, collapsed to one entry per (date, title).
    const decisions = deriveRefusalsFromHistory(all);

    // The verdict that matters: events that reached the calendar even though a
    // refusal for the same date and title already existed. Each one is a case
    // where the user said no and Criba wrote it anyway.
    const overridden = all
      .filter(ev => ev.calEventId && !DECISION_STATUSES.has(ev.status))
      .map(ev => ({ ev, d: decisions.get(decisionKey(ev.date, ev.title)) }))
      .filter(x => x.d)
      .map(x => ({ title: x.ev.title, date: x.ev.date, status: x.ev.status, refusedAs: x.d.status }));

    // Same-date pairs the key holds apart but a human would call one event.
    // These are the decisions that would silently fail to match on rewording.
    const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const byDate = {};
    for (const ev of all) (byDate[ev.date] = byDate[ev.date] || []).push(ev);
    let rewordRisk = 0;
    for (const rows of Object.values(byDate)) {
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          if (decisionKey(rows[i].date, rows[i].title) === decisionKey(rows[j].date, rows[j].title)) continue;
          const A = new Set(norm(rows[i].title).split(' ').filter(w => w.length > 2));
          const B = new Set(norm(rows[j].title).split(' ').filter(w => w.length > 2));
          if (!A.size || !B.size) continue;
          let inter = 0;
          A.forEach(w => { if (B.has(w)) inter++; });
          if (inter / new Set([...A, ...B]).size >= 0.7) rewordRisk++;
        }
      }
    }

    res.json({
      note: 'read-only preview; no decision layer is live and nothing was written',
      scope: 'date-scoped (date + normalised title)',
      totalEvents: all.length,
      decisionsDerived: decisions.size,
      wouldHaveBeenHeldForReview: overridden.length,
      overridden,
      keyRewordingRisk: rewordRisk,
    });
  } catch (err) {
    res.status(500).json({ error: 'debug decisions failed', detail: err.message });
  }
});

// GET /api/debug/decision-gate — read-only replay of the REAL gate.
//
// This does not simulate with copied logic; it calls the same functions the
// live webhook will call — decisionKey for identity, refusalHold for the exact
// text the user would read. Two sources of refusals feed the replay:
//
//   store    — the new decisions store, populated only by explicit gestures
//              from the moment this deployed. This is the real thing.
//   derived  — refusals reconstructed read-only from historical statuses, so
//              the replay has enough data to show verdicts before the store
//              has accumulated any. Never written anywhere.
//
// The replay honours time: a refusal only holds rows created after it existed,
// because that is the only thing the live gate could ever do.
//
// Nothing is written and no live path consults any of this yet. The webhook
// wiring waits for these verdicts to be seen and approved.
app.get('/api/debug/decision-gate', requireAuth, async (req, res) => {
  try {
    const email = req.user.email;
    const all = await getUserEvents(email).values();
    const stored = await getUserDecisions(email).values();
    const lookup = deriveRefusalsFromHistory(all);
    for (const [, d] of lookup) d.source = 'derived-from-history';
    for (const d of stored) lookup.set(d.key, { ...d, source: 'decisions-store' });

    const replay = [];
    for (const ev of all) {
      if (DECISION_STATUSES.has(ev.status)) continue; // this row IS a refusal
      const d = lookup.get(decisionKey(ev.date, ev.title));
      if (!d) continue;
      const at = d.decided_at || '';
      if (at && ev.created_at && ev.created_at <= at) continue;
      replay.push({
        title: ev.title, date: ev.date,
        was: { status: ev.status, onCalendar: !!ev.calEventId },
        wouldBe: { status: 'pending', onCalendar: false, ...refusalHold(d) },
        refusal: { via: d.via || d.status, decided_at: d.decided_at, source: d.source },
      });
    }
    res.json({
      note: 'read-only replay of the actual gate functions; nothing written, nothing live',
      gateWiredIntoWebhook: true,
      scope: 'date-scoped (decisionKey: date + normalised title, same as gcalWritten)',
      totalEvents: all.length,
      storedDecisions: stored.length,
      derivedFromHistory: lookup.size - stored.length,
      wouldHoldForReview: replay.length,
      replay,
    });
  } catch (err) {
    res.status(500).json({ error: 'decision-gate debug failed', detail: err.message });
  }
});

// GET /api/debug/dedup?title=...&date=YYYY-MM-DD[&time=HH:MM] — read-only.
//
// Answers "would an incoming email carrying this event be dropped, and by what?"
// The webhook's dedup skip is otherwise invisible: it logs one line and drops
// the event, so the only way to know an email was suppressed was to already
// suspect it. This runs the real matcher — not a copy of its rules — and reports
// every row that matched, whether that row still blocks, and why.
//
// Titles that match but no longer block are listed too. That is the interesting
// half: it is where a draft or a cancelled event used to swallow real mail.
// GET /api/debug/drafts — the shape of the stranded-draft population.
//
// Bug #6 says 'draft' has no approval path and calls it a one-line filter
// change. It is not, because of #7: most drafts belong to calendars that were
// deleted, so surfacing them all would fill Review with events nobody can
// place. This splits them the way a fix has to treat them — live calendar vs
// deleted, future vs past — so the decision rests on counts, not memory.
app.get('/api/debug/drafts', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const cals = getUserCalendars(req.user.email);
  // RedisHashMap exposes entries(), not keys().
  const liveCalIds = new Set((await cals.entries()).map(([id]) => id));
  const today = new Date().toISOString().slice(0, 10);
  const drafts = (await events.values()).filter(e => e.status === 'draft');
  const bucket = { liveFuture: [], livePast: [], deadFuture: [], deadPast: [] };
  for (const ev of drafts) {
    const live = liveCalIds.has(ev.calendar_id);
    const future = (ev.date || '') >= today;
    bucket[`${live ? 'live' : 'dead'}${future ? 'Future' : 'Past'}`].push({
      title: ev.title, date: ev.date || null, calendar_id: ev.calendar_id, source: ev.source || null,
    });
  }
  res.json({
    total: drafts.length, today,
    liveCalendars: [...liveCalIds],
    counts: Object.fromEntries(Object.entries(bucket).map(([k, v]) => [k, v.length])),
    liveFuture: bucket.liveFuture,
    deadFutureSample: bucket.deadFuture.slice(0, 15),
  });
});

app.get('/api/debug/dedup', requireAuth, async (req, res) => {
  try {
    const title = String(req.query.title || '');
    const date = String(req.query.date || '');
    if (!title || !date) return res.status(400).json({ error: 'title and date are required' });
    const time = String(req.query.time || '');

    const all = await getUserEvents(req.user.email).values();
    const matches = all
      .filter(ev => titlesLooselyMatch(ev.title, title))
      .map(ev => ({
        title: ev.title, date: ev.date, status: ev.status,
        calEventId: ev.calEventId || null,
        blocks: blocksDuplicate(ev),
        why: ev.calEventId
          ? 'on the calendar'
          : DEDUP_BLOCKING_STATUSES.has(ev.status)
            ? 'awaiting your decision in the review queue'
            : `dead record (${ev.status}, never written) — ignored`,
      }));

    res.json({
      query: { title, date, time },
      // The verdict, straight from the function the webhook calls.
      wouldBeSkipped: isDuplicateEventIn(all, title, date, { time }),
      titleMatches: matches.length,
      blocking: matches.filter(m => m.blocks).length,
      ignoredDeadRecords: matches.filter(m => !m.blocks).length,
      matches,
    });
  } catch (err) {
    res.status(500).json({ error: 'debug dedup failed', detail: err.message });
  }
});

// GET /api/debug/scan-list?days=7 — run the EXACT query the backfill uses and
// report, per message, whether it is still fingerprinted and whether the snippet
// pre-filter would pass it. No Claude calls, so it returns in a second or two.
//
// Answers the question a scan trace cannot: was this email even a candidate?
app.get('/api/debug/scan-list', requireAuth, async (req, res) => {
  const days = parseInt(req.query.days, 10) || 7;
  try {
    const auth = await getUserOAuthClient(req.user);
    const gmail = google.gmail({ version: 'v1', auth });
    const afterDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const afterYMD = `${afterDate.getUTCFullYear()}/${String(afterDate.getUTCMonth() + 1).padStart(2, '0')}/${String(afterDate.getUTCDate()).padStart(2, '0')}`;
    const q = `in:inbox -category:promotions -category:social after:${afterYMD}`;

    const listRes = await gmail.users.messages.list({ userId: 'me', q, maxResults: 150 });
    const ids = (listRes.data.messages || []).map(m => m.id);

    const rows = [];
    for (const id of ids) {
      const meta = await gmail.users.messages.get({
        userId: 'me', id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const headers = meta.data.payload.headers || [];
      const h = (n) => headers.find(x => x.name.toLowerCase() === n)?.value || '';
      const subject = h('subject');
      const from = h('from');
      const dateSent = h('date');
      const senderEmail = (from.match(/<(.+?)>/)?.[1] || from).toLowerCase();
      const fpKey = emailFingerprintKey(senderEmail, subject, dateSent);
      rows.push({
        subject, from, dateSent,
        fingerprinted: (await redis.exists(fpKey)) === 1,
        snippetPreFilter: scanForDateContent(`${subject} ${meta.data.snippet || ''}`).pass,
      });
    }
    res.json({ query: q, days, returned: rows.length, messages: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/gmail/backfill-cooldown', requireAuth, async (req, res) => {
  const email = req.user.email;
  await redis.del(`backfillLastRun:${email}`);
  res.json({ ok: true });
});

// DELETE /api/gmail/fingerprints — remove all processedEmail fingerprints that belong
// to the current user. Uses SCAN so it's safe on large Redis keyspaces.
// Intended for debugging / re-scanning after pipeline fixes.
app.delete('/api/gmail/fingerprints', requireAuth, async (req, res) => {
  const email = req.user.email;
  // ?force=1 skips value-matching and deletes ALL processedEmail keys.
  // Use when the normal value-filtered delete isn't clearing the expected keys.
  const force = req.query.force === '1';
  let cursor = 0; // ioredis returns cursor as number; compare as number throughout
  let deleted = 0;
  let skipped = 0;
  let scanned = 0;
  const sample = []; // first 5 seen values for diagnostics
  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'processedEmail:*', 'COUNT', 200);
      cursor = parseInt(nextCursor, 10); // normalise: ioredis may return string or number
      if (keys.length === 0) continue;
      scanned += keys.length;
      if (force) {
        await redis.del(...keys);
        deleted += keys.length;
      } else {
        const values = await redis.mget(...keys);
        if (sample.length < 5) sample.push(...values.filter(Boolean).slice(0, 5 - sample.length));
        const mine = keys.filter((_, idx) => values[idx] === email);
        const others = keys.length - mine.length;
        skipped += others;
        if (mine.length > 0) { await redis.del(...mine); deleted += mine.length; }
      }
    } while (cursor !== 0);

    // The message-id keys are the cheap first-pass dedup. Clearing only the
    // fingerprints would leave those in place, and the scan would skip every
    // message before it ever consulted a fingerprint — "Reset Dedup" would
    // appear to do nothing. These carry the user's address in the key itself,
    // so no value-matching is needed and force makes no difference.
    let msgCursor = 0;
    let msgDeleted = 0;
    do {
      const [nextCursor, keys] = await redis.scan(msgCursor, 'MATCH', `processedMsg:*:${email}:*`, 'COUNT', 200);
      msgCursor = parseInt(nextCursor, 10);
      if (keys.length === 0) continue;
      await redis.del(...keys);
      msgDeleted += keys.length;
    } while (msgCursor !== 0);

    console.log(`[fingerprints] cleared email=${email} force=${force} deleted=${deleted} msgIdKeys=${msgDeleted} skipped=${skipped} scanned=${scanned} sampleValues=${JSON.stringify(sample)}`);
    res.json({ ok: true, deleted, messageIdKeysDeleted: msgDeleted, skipped, scanned, force, sampleValues: sample });
  } catch (err) {
    console.error('[fingerprints] clear failed:', err.message);
    res.status(500).json({ error: 'Failed to clear fingerprints: ' + err.message });
  }
});

// Dry-run (?dryRun=true): full pipeline, no Claude calls, no Redis writes.
//   Returns per-message verdict table. Non-Primary messages are summarized,
//   not listed individually (Part 1 display rule).
app.post('/api/gmail/backfill', requireAuth, async (req, res) => {
  const email = req.user.email;
  const userTz = await getUserTimezone(email);
  const days = Math.min(parseInt(req.body?.days || '2'), 14);
  const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;

  // Hard caps to stay inside Vercel's 60s limit:
  //   150 messages max (metadata ~150ms each → ~22s serial, inside budget)
  //   5 Claude calls max, plus a wall-clock stop. A Claude call plus its
  //   per-event calendar writes runs 6-9s, not the 4-5s originally assumed,
  //   so 8 overran the 60s limit. Unprocessed emails are never fingerprinted,
  //   so whatever we don't reach is picked up by the next scan.
  const MAX_MESSAGES = 150;
  // No cap on the number of extractions — we process everything we can reach.
  // The only limit is wall-clock, and that one is not ours to remove: Vercel
  // kills the function at 60s and the client aborts at 55s. We stop at 42s so
  // an in-flight extraction plus its calendar writes can still finish and the
  // user gets a real response. Anything unreached stays unfingerprinted and is
  // picked up by the next scan.
  const TIME_BUDGET_MS = 42000;
  const startedAt = Date.now();

  const refreshToken = await redis.get(`refreshToken:${email}`);
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token — please sign out and sign back in' });

  // Identifies every trace line this run writes. Two overlapping runs used to
  // be distinguishable only by guessing from millisecond gaps; now they are
  // simply two different ids in the same timeline.
  const runId = randomUUID().slice(0, 8);

  // One scan per mailbox at a time.
  //
  // knownEvents below is a single snapshot taken at run start, so two
  // overlapping runs each hold a picture of the world from before either
  // wrote and neither can dedup against the other. The email fingerprint does
  // not help: it is written only after extraction succeeds, so both runs pass
  // it before either commits. The result was the same practice inserted into
  // Google Calendar twice, in two different children's colours, because two
  // independent extractions tagged attendees differently.
  //
  // Held for 70s — longer than the 42s budget plus its trailing writes, and
  // longer than the client's 55s abort, so a user who gives up and retries
  // cannot overlap the run they are still waiting on.
  const lockKey = `backfillLock:${email}`;
  if (!(await redis.set(lockKey, runId, 'EX', 70, 'NX'))) {
    console.log(`[backfill] REJECTED email=${email} — scan already running`);
    return res.status(409).json({ error: 'A scan is already running — it will finish on its own. Check back in a minute.', alreadyRunning: true });
  }

  // Release on every exit, including the thrown ones. A lock that outlives its
  // run would lock the mailbox out for its full TTL.
  let lockReleased = false;
  const releaseLock = async () => {
    if (lockReleased) return;
    lockReleased = true;
    // Only if it is still ours: a run that overran the TTL must not delete the
    // lock belonging to whichever run legitimately started afterwards.
    if (await redis.get(lockKey) === runId) await redis.del(lockKey);
  };

  // Dry runs write nothing, so they are neither rate-limited nor recorded.
  // A continuation is not a new scan either. The cooldown exists to stop the
  // same mailbox being re-read all day; it must not stop a run that is only
  // finishing emails an earlier run hit its time budget before reaching.
  // Blocking those meant the leftovers waited 24 hours to be read at best,
  // and in practice were never read at all.
  const isContinuation = req.body?.continuation === true;
  if (!dryRun && !isContinuation) {
    const lastRun = await redis.get(`backfillLastRun:${email}`);
    if (lastRun && (Date.now() - parseInt(lastRun, 10)) < BACKFILL_COOLDOWN_SEC * 1000) {
      await releaseLock();
      const nextAt = new Date(parseInt(lastRun, 10) + BACKFILL_COOLDOWN_SEC * 1000).toISOString();
      return res.status(429).json({ error: 'Already scanned in the last 24 hours. Click "Reset lock" below to scan again now.', cooldownUntil: nextAt });
    }
  }

  const auth = getOAuthClientFromRefreshToken(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });
  const eventsStore = getUserEvents(email);

  const afterDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const afterYMD = `${afterDate.getUTCFullYear()}/${String(afterDate.getUTCMonth() + 1).padStart(2, '0')}/${String(afterDate.getUTCDate()).padStart(2, '0')}`;
  // Filter promotions/social at the Gmail query level so they never consume
  // the message budget — far cheaper than fetching metadata and discarding it.
  const q = `in:inbox -category:promotions -category:social after:${afterYMD}`;

  console.log(`[backfill] START email=${email} days=${days} after=${afterYMD} dryRun=${dryRun}`);

  let messageIds = [];
  try {
    const listRes = await gmail.users.messages.list({ userId: 'me', q, maxResults: MAX_MESSAGES });
    messageIds = (listRes.data.messages || []).map(m => m.id);
  } catch (err) {
    console.error('[backfill] messages.list failed:', err.message);
    await releaseLock();
    return res.status(500).json({ error: 'Failed to list Gmail messages: ' + err.message });
  }

  console.log(`[backfill] found ${messageIds.length} messages`);

  let scanned = 0, skippedCategory = 0, skippedDedup = 0, skippedPreFilter = 0;
  // Counted and reported because a failed extraction is invisible otherwise.
  // With credits exhausted every call 400s, and the run still reported
  // "8 sent to AI, 0 new events" — the exact words a mailbox with nothing in
  // it produces. The user checked her inbox three times before the trace
  // revealed the API had never run.
  // Checked before any work, so an over-budget user is told plainly instead of
  // watching a scan grind through 150 messages and report zero.
  const budget = await spendBudgetState(email);
  if (budget.exceeded) {
    return res.json({ ok: true, runId, days, scanned: 0, skippedCategory: 0, skippedPreFilter: 0,
      skippedDedup: 0, claudeCalls: 0, claudeErrors: 0, eventsStored: 0, totalFound: 0, hitLimit: false,
      spendCapReached: true, spentToday: Number(budget.spent.toFixed(4)), spendCap: budget.cap,
      lastClaudeError: summariseApiError(`${SPEND_CAP_ERROR}: $${budget.spent.toFixed(2)} of $${budget.cap.toFixed(2)} daily limit used`) });
  }
  let claudeCalls = 0, claudeErrors = 0, lastClaudeError = '', eventsStored = 0, hitLimit = false;
  const dryRunMessages = [];

  // Built once, not per extracted event — this was a redundant OAuth client
  // plus a target-calendar lookup on every single event written.
  const bfCalApi = google.calendar({ version: 'v3', auth: getOAuthClientFromRefreshToken(refreshToken) });
  // Loaded once per request rather than three times per extracted event.
  const knownEvents = dryRun ? [] : await eventsStore.values();
  // Cancellation and reschedule notices already waiting in the queue, so a
  // second notice for the same event does not become a second card.
  const knownPendingChanges = knownEvents.filter(e =>
    e.status === 'pending_cancellation' || e.status === 'pending_reschedule');
  const familyMembers = dryRun ? [] : await getUserFamily(email).values();
  const exclusionRules = dryRun ? [] : await getUserExclusions(email).values();
  // Built from knownEvents, which is every event already stored for this user —
  // including the ones they have coloured by hand. Computed once per scan.
  const learnedAttribution = dryRun ? new Map() : learnSenderAttribution(knownEvents);
  const bfCalId = dryRun ? null : await resolveTargetCalendar(email);

  // What is already on the user's calendar, including subscribed feeds, so we
  // don't add a second copy of something a club already published.
  //
  // Loaded lazily by month and cached: the dates aren't known until extraction
  // has run, and an email in August routinely mentions events in September. One
  // list call per month touched, not one per event — anything per-event would
  // not fit the 60s budget.
  const calMonthCache = new Map();
  async function existingCalendarEventsFor(date) {
    if (dryRun || !date) return [];
    const month = date.slice(0, 7);
    if (!calMonthCache.has(month)) {
      const first = `${month}-01`;
      const last = `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`;
      calMonthCache.set(month, await fetchExistingCalendarEvents(bfCalApi, bfCalId, [first, last]));
    }
    return calMonthCache.get(month);
  }

  // Messages that passed every filter and are waiting on extraction.
  const candidates = [];

  for (const messageId of messageIds) {
    // This loop is now cheap — metadata and body fetches only, ~450ms each.
    // Reserve most of the budget for the extraction waves that follow.
    if (!dryRun && Date.now() - startedAt > TIME_BUDGET_MS * 0.4) {
      console.log(`[backfill] collect phase deadline after ${scanned} msgs (${Date.now() - startedAt}ms)`);
      await traceEmail(email, { runId, stage: 'TIMING', note: 'deadline-in-collect', scanned, elapsedMs: Date.now() - startedAt });
      hitLimit = true;
      break;
    }
    // ── Free dedup ───────────────────────────────────────────────────────────
    // Before the metadata fetch, so a message we have already processed costs
    // nothing at all. Deliberately does not increment `scanned`: that counter
    // means "messages this scan spent time on", and it is what the deadline
    // trace reports. Counting free skips in it would hide the real reach.
    if (!dryRun && await redis.exists(processedMessageKey(email, messageId))) {
      skippedDedup++;
      continue;
    }

    scanned++;
    const msgStart = Date.now();

    let subject = '', from = '', dateSent = '', snippet = '', labelIds = [], sizeEstimate = 0;
    try {
      const metaRes = await gmail.users.messages.get({
        userId: 'me', id: messageId, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const meta = metaRes.data;
      const headers = meta.payload?.headers || [];
      subject     = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      from        = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      dateSent    = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      snippet     = meta.snippet || '';
      labelIds    = meta.labelIds || [];
      sizeEstimate = meta.sizeEstimate || 0;
    } catch (err) {
      console.error(`[backfill] metadata fetch failed msg=${messageId}:`, err.message);
      continue;
    }

    // Category filtering now happens in the Gmail query above (-category:...),
    // so promotions/social never reach this loop. skippedCategory stays at 0
    // for response-shape compatibility with the dry-run table.

    // ── Fingerprint dedup ────────────────────────────────────────────────────
    const { senderName, senderEmail } = parseFrom(from);
    // The character limit is part of the fingerprint. An email read at 8000
    // characters was only partly read, but the fingerprint said "done" and no
    // later scan would ever look at it again — a truncated extraction was
    // permanent. Versioning by the limit means raising it re-reads exactly the
    // emails the old limit could have cut short, once. Events that were already
    // captured come back out and are caught by the normal duplicate check.
    const fpKey = emailFingerprintKey(senderEmail, subject, dateSent);
    if (await redis.exists(fpKey)) {
      skippedDedup++;
      await traceEmail(email, { runId, stage: 'SKIP-DEDUP', messageId, subject, from });
      if (dryRun) dryRunMessages.push({ messageId, subject, sizeEstimate, verdict: 'SKIP', reason: 'already-processed' });
      continue;
    }

    // ── Snippet scan ─────────────────────────────────────────────────────────
    const snippetScan = scanForDateContent(`${subject} ${snippet}`.trim(), snippet.length);
    if (!snippetScan.pass && !snippetScan.escalate) {
      skippedPreFilter++;
      if (dryRun) dryRunMessages.push({ messageId, subject, sizeEstimate, snippetPreview: snippet.slice(0, 100), verdict: 'SKIP', reason: 'no-date-signal' });
      continue;
    }

    // ── Stage 2: full body fetch ─────────────────────────────────────────────
    let body = '', imageParts = [], fullRes;
    try {
      fullRes = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      body = extractEmailBody(fullRes.data.payload);
      imageParts = collectImageParts(fullRes.data.payload);
    } catch (err) {
      console.error(`[backfill] body fetch failed msg=${messageId}:`, err.message);
      continue;
    }

    const isImageHeavy = imageParts.length > 0 && body.trim().length < IMAGE_HEAVY_BODY_MAX;
    if (!snippetScan.pass && !isImageHeavy) {
      // The filter used to judge the first 5000 characters only. The body is
      // already in memory and this is a regex, so the truncation bought
      // nothing and cost us any newsletter that carried its date further
      // down — exactly the shape of mail a school sends.
      const bodyScan = scanForDateContent(`${subject} ${body}`);
      if (!bodyScan.pass) {
        skippedPreFilter++;
        await traceEmail(email, { runId, stage: 'SKIP-BODY', messageId, subject, from, bodyLen: body.length });
        if (dryRun) dryRunMessages.push({ messageId, subject, sizeEstimate, snippetPreview: snippet.slice(0, 100), verdict: 'SKIP', reason: 'no-date-signal-body', escalated: true });
        continue;
      }
    }

    if (dryRun) {
      const estTokens = PROMPT_TOKENS_ESTIMATE + Math.ceil((subject.length + body.length) / 4) + imageParts.length * IMAGE_TOKENS_ESTIMATE;
      dryRunMessages.push({ messageId, subject, sizeEstimate, snippetPreview: snippet.slice(0, 100), verdict: 'WOULD_SEND', reason: snippetScan.pass ? 'snippet-match' : isImageHeavy ? 'image-escalation' : 'body-match', imageCount: imageParts.length, estTokens });
      continue;
    }

    // ── Collect for extraction ───────────────────────────────────────────────
    // Claude calls are ~19s each and fully independent of one another, so
    // running them serially wasted the entire budget on two emails. Gather
    // candidates here; extract them concurrently after the loop.
    candidates.push({
      messageId, subject, from, dateSent, senderName, senderEmail,
      body, imageParts, payload: fullRes.data.payload, fpKey, isImageHeavy,
      // Same reason as the webhook: the thread is what survives rewording.
      threadId: fullRes.data.threadId || '',
    });
    await traceEmail(email, { runId, stage: 'TIMING', messageId, subject, msgMs: Date.now() - msgStart, elapsedMs: Date.now() - startedAt });
  }

  // ── Parallel extraction ────────────────────────────────────────────────────
  // Extractions run in waves. Storage stays serial because it mutates
  // knownEvents for in-run duplicate detection and writes to Google Calendar.
  const CONCURRENCY = 5;
  // A wave is all-or-nothing: five Claude calls in flight, and the storage that
  // follows them. The old guard asked whether the budget had already been spent,
  // which let a wave start at 41.9s and run to ~61s — past Vercel's 60s kill and
  // past the client's 55s abort. Everything stored before that point survived and
  // nothing unreached was fingerprinted, so no data was lost, but the scan
  // returned no response at all: a mostly-successful run reported as a failure.
  //
  // Ask instead whether the wave can finish. Seeded from the observed cost of
  // a Claude call plus its calendar writes, then replaced by what this run is
  // actually measuring, because a slow Anthropic day is exactly when the naive
  // estimate is most wrong.
  let waveEstimateMs = 20000;
  let iterStart = null;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const now = Date.now();
    // Measured at the top of the next iteration rather than after the wave, so
    // the estimate includes the serial storage and calendar writes that follow
    // it. Those are part of what has to fit inside the budget. The floor stops
    // one cheap wave — a partial last batch, or one that failed fast — from
    // making the next look affordable when it is not.
    if (iterStart !== null) waveEstimateMs = Math.max(now - iterStart, 8000);
    iterStart = now;
    const elapsed = now - startedAt;
    if (elapsed + waveEstimateMs > TIME_BUDGET_MS) {
      hitLimit = true;
      await traceEmail(email, { runId, stage: 'TIMING', note: 'deadline-before-wave', scanned: candidates.length - i, elapsedMs: elapsed, estimateMs: waveEstimateMs });
      break;
    }
    const wave = candidates.slice(i, i + CONCURRENCY);
    const waveStart = Date.now();
    const results = await Promise.allSettled(wave.map(async (c) => {
      const images = c.imageParts.length > 0 ? await fetchEmailImages(c.payload, gmail, c.messageId) : [];
      // An image-heavy email that reaches Claude with no image is not a
      // "Claude found nothing" result — Claude was handed an empty body and
      // nothing to look at. Without this the trace shows SENT-TO-AI then
      // DROPPED and the two cases are indistinguishable.
      if (c.isImageHeavy && !images.length) {
        await traceEmail(email, { runId, stage: 'NO-IMAGE-DATA', messageId: c.messageId, subject: c.subject,
          from: c.from, attachments: c.imageParts.length, droppedForSize: images.droppedForSize || 0 });
      }
      const t0 = Date.now();
      const extracted = await extractGmailEvents(c.body, c.senderName, c.senderEmail, c.subject, images, c.dateSent, familyMembers.map(m => m.name).filter(Boolean), email);
      return { extracted, claudeMs: Date.now() - t0, imageCount: images.length };
    }));
    console.log(`[backfill] wave of ${wave.length} finished in ${Date.now() - waveStart}ms elapsed=${Date.now() - startedAt}`);

    for (let j = 0; j < wave.length; j++) {
      const c = wave[j];
      const r = results[j];
      claudeCalls++;
      if (r.status === 'rejected') {
        console.error(`[backfill] extraction failed msg=${c.messageId}:`, r.reason?.message);
        await traceEmail(email, { runId, stage: 'ERROR', messageId: c.messageId, subject: c.subject, from: c.from, error: r.reason?.message || 'extraction failed' });
        claudeErrors++;
        lastClaudeError = r.reason?.message || 'extraction failed';
        continue;
      }
      const { extracted, claudeMs, imageCount } = r.value;
      const { messageId, subject, from, dateSent, senderName, senderEmail, fpKey, threadId } = c;
      await traceEmail(email, { runId,
        stage: 'SENT-TO-AI', messageId, subject, from, claudeEvents: extracted.length,
        claudeMs, preClaudeMs: 0, elapsedMs: Date.now() - startedAt,
        // An events=0 result is ambiguous without these: it can mean the email
        // genuinely had no dates, or that the body was cut short before the
        // schedule appeared, or that the content was in an unfetched image.
        bodyLen: c.body.length, truncated: c.body.length > EXTRACTION_CHAR_LIMIT, imgs: imageCount,
        // Without the titles, a count cannot distinguish "Claude never saw the
        // reminder" from "Claude found it and a later stage dropped it" — the
        // two have completely different fixes. Type included because the
        // deadlines and financial reminders are what keep going missing while
        // the plain events from the same email come through.
        claudeTitles: extracted.map(e => `${e.source_type || 'event'}:${e.title || '(untitled)'}@${e.date || '(no date)'}`),
      });

      try {
        // Fingerprint only after a successful extraction, so anything we did
        // not reach stays eligible for the next scan. The message-id key is
        // written in the same breath and with the same TTL: if these two ever
        // disagree, the cheap one would skip mail the authoritative one still
        // considers unread.
        await redis.set(fpKey, email, 'EX', 30 * 24 * 60 * 60);
        await redis.set(processedMessageKey(email, messageId), '1', 'EX', 30 * 24 * 60 * 60);

        for (const ev of extracted) {
          // Normalize partial dates (e.g. "August 12" → "2026-08-12")
          if (ev.date && !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) {
            const norm = normalizeEventDate(ev.date, dateSent);
            if (norm) { await traceEmail(email, { runId, stage: 'DATE-NORM', messageId, subject, rawDate: ev.date, normalized: norm }); ev.date = norm; }
          }
          if (!ev.title || !ev.date) { await traceEmail(email, { runId, stage: 'DROPPED', messageId, subject, reason: !ev.title ? 'no-title' : 'bad-date', rawDate: ev.date }); continue; }
          // Deadlines come back as midnight; move them to 6am here as well as in
          // buildCalendarTimes so the stored record and the UI agree with the
          // calendar rather than showing "12:00 AM".
          shiftMidnightToMorning(ev);
          const bfTzNote = normalizeEventTimezone(ev, userTz);
          if (bfTzNote) ev.notes = [ev.notes, bfTzNote].filter(Boolean).join(' ');

          const intent = ev.intent || 'new_event';
          if (intent === 'cancellation' || intent === 'reschedule') {
            // "Rescheduled from Aug 25 3:30pm to Aug 25 3:30pm" is not a
            // reschedule. The model reports one whenever an email restates an
            // existing time, and the card that results asks the user to approve
            // moving an event to where it already is. Only queue a change when
            // something actually changed.
            if (intent === 'reschedule' && ev.old_date && ev.old_date === ev.date
                && (ev.old_time || '') === (ev.start_time || '')) {
              await traceEmail(email, { runId, stage: 'DROPPED', messageId, subject, reason: 'reschedule-no-change', rawDate: ev.date });
              continue;
            }
            // Two emails about one cancellation, or two extractions of the same
            // email, produced two identical cards the user had to dismiss twice.
            // One notice per event is enough.
            const already = knownPendingChanges.find(p =>
              p.intent === intent
              && (p.old_date || p.date || '') === (ev.old_date || ev.date || '')
              && titlesLooselyMatch(p.old_title || p.title || '', ev.old_title || ev.title || ''));
            if (already) {
              await traceEmail(email, { runId, stage: 'DROPPED', messageId, subject, reason: 'duplicate-change-notice', rawDate: ev.date });
              continue;
            }
            const matchResult = await findMatchingApprovedEvent(eventsStore, ev.old_title || ev.title, ev.old_date || ev.date);
            const evId = randomUUID();
            await eventsStore.set(evId, {
              id: evId, intent, title: ev.title, date: ev.date, end_date: ev.end_date || '',
              time: ev.start_time || '', end_time: ev.end_time || '',
              location: ev.location || '', is_all_day: !!ev.is_all_day,
              attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
              notes: ev.notes || null, source_type: ev.source_type || null,
              old_title: ev.old_title || null, old_date: ev.old_date || null, old_time: ev.old_time || null,
              matched_event_id: matchResult?.event?.id || null, matched_event_title: matchResult?.event?.title || null,
              matched_event_confidence: matchResult?.score ?? null,
              source: 'gmail', gmail_message_id: messageId, thread_id: threadId || null,
              sender_name: senderName, sender_email: senderEmail, subject,
              status: intent === 'cancellation' ? 'pending_cancellation' : 'pending_reschedule',
              type: ev.is_all_day ? 'other' : 'timed', created_at: new Date().toISOString(),
            });
            // Visible to the rest of this same run, or two notices arriving in
            // one scan both pass the check above and both get stored.
            knownPendingChanges.push({
              intent, title: ev.title, date: ev.date,
              old_title: ev.old_title || null, old_date: ev.old_date || null,
            });
            eventsStored++; continue;
          }

          // Decision gate before dedup — same contract as the webhook path:
          // a prior "no" always resurfaces for review, never silently drops.
          const refusal = await priorRefusal(email, ev.date, ev.title);
          if (!refusal && isDuplicateEventIn(knownEvents, ev.title, ev.date, { time: ev.start_time || '', recurrence: ev.recurrence, threadId })) continue;
          const startTime = ev.start_time || '', endTime = ev.end_time || '';

          // Already on the calendar from somewhere else — typically a club's
          // subscribed feed. Record it so the user can see Criba found it and
          // chose not to add a second copy, but do not write.
          const existingCalEvents = await existingCalendarEventsFor(ev.date);
          const calDup = findCalendarDuplicate(existingCalEvents, ev.title, ev.date, startTime);
          // A refusal outranks the calendar-duplicate shortcut: the point of the
          // gate is that the user sees the card and decides, so fall through to
          // the main store where the hold text is attached.
          if (calDup && !refusal) {
            const dupId = randomUUID();
            await eventsStore.set(dupId, {
              id: dupId, title: ev.title, date: ev.date, end_date: ev.end_date || '',
              time: startTime, end_time: endTime, location: ev.location || '',
              is_all_day: !!ev.is_all_day, attendees: [],
              notes: ev.notes || null,
              conflict_note: `Already on your calendar as "${calDup.title}" — not added again`,
              duplicate_of_calendar: true,
              source_type: ev.source_type || null, recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null,
              source: 'gmail', gmail_message_id: messageId, thread_id: threadId || null,
              sender_name: senderName, sender_email: senderEmail, subject,
              status: 'duplicate', reviewed: false, calEventId: null,
              type: ev.is_all_day ? 'other' : 'timed', created_at: new Date().toISOString(),
            });
            knownEvents.push({ title: ev.title, date: ev.date, time: startTime, status: 'duplicate' });
            continue;
          }

          // Conflicts against Criba's own events and against everything else on
          // the calendar are both worth surfacing; prefer whichever we find.
          const conflictNote = findConflictIn(knownEvents, ev.date, startTime, endTime)
            || findCalendarConflict(existingCalEvents, ev.date, startTime, endTime);
          const combinedNotes = ev.notes || null;
          // Colour at write time, so an auto-added event lands on the calendar
          // already the right colour instead of grey until someone opens it.
          // Falls back to what this sender has meant every other time — see
          // learnSenderAttribution. Deliberately does not set member_id on the
          // stored event: that field is the record of what the user chose, and
          // writing guesses into it would let the learner train on itself.
          const attrText = [ev.title, ev.location, ev.notes, subject].filter(Boolean).join(' ');
          let bfColorId = resolveColorIn(familyMembers, Array.isArray(ev.attendees) ? ev.attendees : [], attrText);
          // Recorded activities are consulted before sender history, and an
          // ambiguous verdict blocks the fallback rather than deferring to it —
          // otherwise the domain guess would paint the colour that the activity
          // check just established we cannot justify.
          let bfAmbiguity = null;
          if (!bfColorId) {
            const act = resolveAttribution(familyMembers, attrText, senderEmail);
            if (act.ambiguous) {
              bfAmbiguity = act.ambiguityReason;
              await traceEmail(email, { runId, stage: 'AMBIGUOUS', messageId, subject, from, title: ev.title, reason: act.ambiguityReason });
            } else if (act.memberId) {
              const am = familyMembers.find(x => x.id === act.memberId);
              if (am) bfColorId = am.eventColor || am.color || null;
            }
          }
          if (!bfColorId && !bfAmbiguity) {
            const dom = String(senderEmail || '').toLowerCase().split('@')[1];
            const hit = dom ? learnedAttribution.get(dom) : null;
            const lm = hit && familyMembers.find(x => x.id === hit.memberId);
            if (lm) bfColorId = lm.eventColor || lm.color || null;
          }
          // A school newsletter covers every grade in the school. Writing the
          // Kindergarten schedule to the calendar of a family whose youngest is
          // in third grade is how a calendar stops being worth reading.
          //
          // Held back rather than discarded: it still appears in the queue with
          // the reason shown, and one click adds it. Criba guessing wrong about
          // your family should cost you a click, not an event.
          const relevance = eventRelevance(
            [ev.title, ev.notes, subject].filter(Boolean).join(' '), familyMembers,
            exclusionRules, senderEmail, ev.audience);

          let calEventId = null;
          // autoWriteToCalendar checks every calendar the user subscribes to and
          // the persistent write-guard before inserting, so a scan can auto-add
          // without ever landing a second copy.
          const bfWriteObj = { title: ev.title, date: ev.date, end_date: ev.end_date || '', time: startTime, end_time: endTime, location: ev.location || '', recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null, recurring_note: null, attendees: [],
            // Carried purely so buildEventDescription can write the details and
            // the back-link to the source email into the calendar entry.
            notes: combinedNotes, sender_name: senderName, sender_email: senderEmail, subject, gmail_message_id: messageId };
          const hold = refusal ? refusalHold(refusal) : null;
          if (hold) {
            await traceEmail(email, { runId, stage: 'HELD-REFUSAL', messageId, subject, from,
              title: ev.title, date: ev.date, refusedVia: refusal.via || null, decidedAt: refusal.decided_at || null });
          } else if (relevance.relevant) {
            try {
              calEventId = await autoWriteToCalendar(bfCalApi, bfCalId, bfWriteObj, bfColorId, { timezone: userTz, email });
            } catch (calErr) { console.error(`[backfill] GCal write failed "${ev.title}":`, calErr.message); }
          }
          const otherCalDup = bfWriteObj.duplicate_of || null;
          const evId = randomUUID();
          const stored = {
            id: evId, title: ev.title, date: ev.date, end_date: ev.end_date || '',
            time: startTime, end_time: endTime, location: ev.location || '',
            is_all_day: !!ev.is_all_day, attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
            notes: combinedNotes,
            conflict_note: hold
              ? hold.conflict_note
              : otherCalDup
                ? calDupNote(otherCalDup, bfCalId)
                : (relevance.reason ? `Not added — ${relevance.reason}` : conflictNote || null),
            held_reason: hold ? hold.held_reason : (relevance.reason || null),
            duplicate_of_calendar: !!otherCalDup,
            source_type: ev.source_type || null, recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null,
            source: 'gmail', gmail_message_id: messageId, thread_id: threadId || null,
            sender_name: senderName, sender_email: senderEmail, subject,
            status: calEventId ? 'added' : (otherCalDup ? 'duplicate' : 'pending'), reviewed: false,
            calEventId: calEventId || null, gcalId: calEventId ? bfCalId : null,
            approved_at: calEventId ? new Date().toISOString() : null,
            type: ev.is_all_day ? 'other' : 'timed', created_at: new Date().toISOString(),
          };
          await eventsStore.set(evId, stored);
          // Keep the cache current so later events in this same run still see it.
          knownEvents.push(stored);
          await traceEmail(email, { runId, stage: 'STORED', messageId, subject, from, title: ev.title, date: ev.date, calEventId, status: calEventId ? 'added' : 'pending' });
          eventsStored++;
        }
      } catch (err) {
        console.error(`[backfill] store error msg=${messageId}:`, err.message);
        await traceEmail(email, { runId, stage: 'ERROR', messageId, subject, from, error: err.message });
      }
    }
  }
  if (claudeCalls < candidates.length) hitLimit = true;

  console.log(`[backfill] DONE scanned=${scanned} skippedCat=${skippedCategory} skippedDedup=${skippedDedup} skippedSignal=${skippedPreFilter} claudeCalls=${claudeCalls} eventsStored=${eventsStored}`);

  if (dryRun) {
    const wouldSend = dryRunMessages.filter(m => m.verdict === 'WOULD_SEND').length;
    await releaseLock();
    return res.json({
      dryRun: true, days, query: q,
      totalFound: messageIds.length, scanned,
      wouldExtract: wouldSend,
      skippedCategory, skippedPreFilter, skippedDedup,
      totalEstTokens: dryRunMessages.filter(m => m.verdict === 'WOULD_SEND').reduce((s, m) => s + (m.estTokens || 0), 0),
      messages: dryRunMessages,
    });
  }

  // Recorded only on a real run that reached the end, so a scan that failed
  // early does not spend the user's 24 hours.
  await redis.set(`backfillLastRun:${email}`, String(Date.now()), 'EX', BACKFILL_COOLDOWN_SEC);
  await releaseLock();
  res.json({ ok: true, runId, days, scanned, skippedCategory, skippedPreFilter, skippedDedup, claudeCalls, claudeErrors, lastClaudeError: summariseApiError(lastClaudeError), eventsStored, totalFound: messageIds.length, hitLimit });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Criba running on port ${PORT}`));

export default app;
