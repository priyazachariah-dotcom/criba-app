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
async function autoWriteToCalendar(calendarApi, targetCalId, ev, colorId, opts = {}) {
  if (!opts.skipDuplicateCheck) {
    const dup = await findExistingOnAnyCalendar(calendarApi, targetCalId, ev);
    if (dup) {
      ev.duplicate_of = dup;
      console.log(`[calendar-dedup] SKIP "${ev.title}" on ${ev.date} — already on "${dup.calendarName}" as "${dup.title}"`);
      return null;
    }
  }
  const { start, end } = buildCalendarTimes(ev.date, ev.time || '', ev.end_date || '', ev.end_time || '');
  // Only append the suffix when there is actually a note to append. The backfill
  // always passes recurring_note: null, which produced the dangling
  // "Added via Criba — recurring:" on every recurring event.
  const description = ev.recurrence_rule && ev.recurring_note
    ? `Added via Criba — recurring: ${ev.recurring_note}`
    : 'Added via Criba';
  const resource = {
    summary: ev.title,
    location: ev.location || '',
    start, end, description,
    attendees: (ev.attendees || []).filter(a => a?.email).map(a => ({ email: a.email })),
  };
  if (ev.recurrence_rule) resource.recurrence = [ensureRecurrenceEnd(ev.recurrence_rule, ev.date, ev.recurrence_end_date)];
  if (colorId) resource.colorId = String(colorId);
  const result = await calendarApi.events.insert({ calendarId: targetCalId, sendUpdates: 'none', resource });
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

7. Never miss an event because it seems minor. "Return library books" is on the calendar. "Submit grad photo" is on the calendar. "Verify card is current" is on the calendar. Busy people miss these exactly because they seem small.

8. Recurring events. If something repeats on a schedule ("every Tuesday at 4pm", "weekly practice", "meets every Monday and Wednesday"), output ONE event with:
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
  const time = allDayType ? '' : (ev.time || '');
  let endTime = allDayType ? '' : (ev.end_time || '');
  if (time && !endTime && (type === 'timed' || type === 'minimum_day')) {
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
    end_time: (type === 'timed' || type === 'minimum_day') ? endTime : '',
    location: ev.location || '',
    recurring_note: type === 'recurring' ? (ev.recurring_note || '') : '',
    notes: ev.notes || null,
    source_type: ev.source_type || null,
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

const LOCAL_TZ = 'America/Los_Angeles';

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
function convertToLocalTime(date, time, fromTz) {
  if (!date || !time || !fromTz || fromTz === LOCAL_TZ) return { date, time };
  try {
    const instant = new Date(zonedWallClockToUtc(date, time, fromTz));
    if (isNaN(instant)) return { date, time };
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: LOCAL_TZ, hour12: false,
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
function normalizeEventTimezone(ev) {
  const tz = ev.timezone || ev.time_zone || null;
  if (!tz || tz === LOCAL_TZ || !ev.date) return null;
  const startKey = ev.start_time !== undefined && ev.start_time !== null ? 'start_time' : 'time';
  const startVal = ev[startKey];
  if (!startVal) return null;
  const start = convertToLocalTime(ev.date, startVal, tz);
  if (start.time === startVal && start.date === ev.date) return null;
  if (ev.end_time) {
    const end = convertToLocalTime(ev.end_date || ev.date, ev.end_time, tz);
    ev.end_time = end.time;
    if (ev.end_date) ev.end_date = end.date;
  }
  ev[startKey] = start.time;
  ev.date = start.date;
  return `Stated as ${startVal} ${tz.split('/').pop().replace(/_/g, ' ')} time.`;
}

function buildCalendarTimes(date, time, endDate, endTime) {
  const tz = LOCAL_TZ;
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
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
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
    const all = [
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
    res.json(contacts);
  } catch (err) {
    console.error('Contacts error:', JSON.stringify(err.response?.data || {}), err.message, err.stack);
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
  const pending = all.filter(e => {
    if (e.status === 'pending_cancellation' || e.status === 'pending_reschedule') return true;
    // Post-write review: 'added' events not yet reviewed and not yet past
    if ((e.status === 'added' || e.status === 'pending') && !e.reviewed && !isPast(e)) return true;
    // Found on the calendar already and deliberately not written. Shown so the
    // user can see Criba noticed it rather than silently dropping it.
    if (e.status === 'duplicate' && !e.reviewed && !isPast(e)) return true;
    return false;
  }).sort((a, b) => (a.date || '') > (b.date || '') ? 1 : -1);
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
  const { id, title, date, time, endDate, endTime, location, attendees, sharePartner } = req.body;
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

    const finalEndDate = endDate || event.end_date || '';
    const finalEndTime = endTime || event.end_time || '';
    const { start, end } = buildCalendarTimes(date, time, finalEndDate, finalEndTime);
    const eventAttendees = [];
    // Was a hardcoded personal address behind a "share to Bharat" flag. Fine
    // when the only user was its author; a privacy problem the moment anyone
    // else signs in. Now each user nominates their own partner in settings, and
    // the checkbox only appears once they have.
    if (sharePartner) {
      const partnerEmail = await getUserSettings(req.user.email).get('partnerEmail');
      if (partnerEmail) eventAttendees.push({ email: partnerEmail });
    }
    if (attendees && Array.isArray(attendees)) {
      attendees.forEach(a => { if (a.email) eventAttendees.push({ email: a.email }); });
    }
    const description = event.type === 'recurring' && event.recurring_note
      ? `Added via Criba — recurring: ${event.recurring_note}`
      : 'Added via Criba';

    // Use the RRULE from body if the user kept it, or fall back to the stored rule.
    // The frontend sends recurrenceRule: null to remove recurrence before adding.
    const recurrenceRule = Object.prototype.hasOwnProperty.call(req.body, 'recurrenceRule')
      ? req.body.recurrenceRule
      : event.recurrence_rule;

    const calEventResource = { summary: title || event.title, location: location || event.location || '', start, end, attendees: eventAttendees, description };
    if (recurrenceRule) calEventResource.recurrence = [ensureRecurrenceEnd(recurrenceRule, date, req.body.recurrenceEndDate || event.recurrence_end_date)];
    if (colorId) calEventResource.colorId = String(colorId);

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
      const dup = await findExistingOnAnyCalendar(calendar, targetCalId, {
        title: calEventResource.summary, date, time: time || '',
      });
      if (dup?.id) {
        event.gcalId = dup.calendarId || targetCalId;
        if (dup.recurringEventId) {
          // A single instance of a series. Patching it would detach that one
          // occurrence and leave the rest untouched, which is worse than
          // leaving it alone — adopt it and change nothing.
          calEvent = { data: { id: dup.recurringEventId } };
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
    event.reviewed = true; // manually approved events are already reviewed
    event.calEventId = calEvent.data.id;
    // Keep the calendar we actually wrote to. Overwriting it with the target
    // would strand an event we adopted or patched on a different calendar,
    // making later undo and update calls fail.
    event.gcalId = event.gcalId || targetCalId;
    event.approved_at = new Date().toISOString();
    event.title = title || event.title;
    event.date = date;
    event.time = time || '';
    event.end_date = finalEndDate;
    event.end_time = finalEndTime;
    event.location = location || event.location || '';
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
    await calendar.events.delete({ calendarId: event.gcalId || 'primary', eventId: event.calEventId });
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
  if (!event || !event.calEventId) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = await getUserOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    const finalEndDate = endDate || event.end_date || '';
    const finalEndTime = endTime || event.end_time || '';
    const { start, end } = buildCalendarTimes(date, time, finalEndDate, finalEndTime);
    const eventAttendees = (attendees || []).filter(a => a.email).map(a => ({ email: a.email }));
    await calendar.events.patch({
      calendarId: event.gcalId || 'primary',
      eventId: event.calEventId,
      sendUpdates: 'all',
      resource: { summary: title, location: location || '', start, end, attendees: eventAttendees }
    });
    event.title = title; event.date = date; event.time = time || '';
    event.end_date = finalEndDate; event.end_time = finalEndTime;
    event.location = location || '';
    await events.set(id, event);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update error:', err.message);
    res.status(500).json({ error: 'Failed to update: ' + err.message });
  }
});

app.post('/api/events/dismiss', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const event = await events.get(req.body.id);
  if (event) { event.status = 'dismissed'; await events.set(req.body.id, event); }
  res.json({ ok: true });
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

// Mark every event currently in the review queue as reviewed.
//
// The queue is post-write: everything in it is already on the calendar, so for
// most people most of the time the correct action on the whole list is "yes,
// fine". Without this the only way to empty a long queue was to press OK on
// each card, which is why the tab grew unbounded.
//
// Deliberately only touches events the queue itself would show — same predicate
// as GET /api/events/pending — so a bulk OK can never silently clear something
// that needs a decision, like a cancellation or a reschedule.
app.post('/api/events/review-all-ok', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const all = await events.values();
  let cleared = 0;
  for (const ev of all) {
    if (ev.status === 'pending_cancellation' || ev.status === 'pending_reschedule') continue;
    if ((ev.status === 'added' || ev.status === 'pending') && !ev.reviewed) {
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
    if (event.calEventId) {
      const auth = await getUserOAuthClient(req.user);
      const calendar = google.calendar({ version: 'v3', auth });
      await calendar.events.delete({ calendarId: event.gcalId || 'primary', eventId: event.calEventId });
    }
    event.status = 'dismissed';
    event.calEventId = null;
    await events.set(id, event);
    res.json({ ok: true });
  } catch (err) {
    if (err.message?.includes('410') || err.message?.includes('Resource has been deleted') || err.message?.includes('404')) {
      // Already deleted from GCal — still mark as dismissed in Redis
      event.status = 'dismissed';
      event.calEventId = null;
      await events.set(id, event);
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
async function cancelOneOccurrence(calendarApi, calendarId, seriesId, date) {
  if (!seriesId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  try {
    const resp = await calendarApi.events.instances({
      calendarId, eventId: seriesId,
      timeMin: new Date(`${date}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${date}T23:59:59Z`).toISOString(),
      maxResults: 10,
      // The window is in UTC, so an evening class in a western timezone can
      // land outside it. Widen by a day either side and match on local date.
      timeZone: LOCAL_TZ,
    });
    const items = resp.data.items || [];
    const hit = items.find(i => (i.start?.date || (i.start?.dateTime || '').slice(0, 10)) === date) || items[0];
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
          ? await cancelOneOccurrence(calendar, calId, matchedEv.calEventId, targetDate)
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
      }
      await eventsStore.set(matchedId, matchedEv);
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
  if (ev) { ev.status = 'dismissed'; await eventsStore.set(req.body.id, ev); }
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
    const { start, end } = buildCalendarTimes(pendingEv.date, pendingEv.time, pendingEv.end_date || '', pendingEv.end_time || '');
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
  if (ev) { ev.status = 'dismissed'; await eventsStore.set(req.body.id, ev); }
  res.json({ ok: true });
});
app.get('/api/calendars', requireAuth, async (req, res) => {
  const cals = getUserCalendars(req.user.email);
  res.json((await cals.values()).sort((a,b) => b.created_at > a.created_at ? 1 : -1));
});

app.delete('/api/calendars/:id', requireAuth, async (req, res) => {
  const cals = getUserCalendars(req.user.email);
  await cals.delete(req.params.id);
  const events = getUserEvents(req.user.email);
  for (const [eid, ev] of await events.entries()) {
    if (ev.calendar_id === req.params.id && ev.status === 'pending') await events.delete(eid);
  }
  res.json({ ok: true });
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

async function classifyIcalEventsWithAI(rawEvents) {
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
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: Math.min(8192, 1000 + rawEvents.length * 40),
    messages: [{ role: 'user', content: prompt }],
  });
  const text = getResponseText(response);
  const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  if (!Array.isArray(parsed.results)) throw new Error('AI classification response missing results array');
  return parsed.results;
}

app.post('/api/calendars/add-ical', requireAuth, async (req, res) => {
  const { name, url, memberId } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL are required' });
  try {
    const icalEvents = await ical.async.fromURL(url);
    const today = new Date(); today.setHours(0,0,0,0);
    const endDate = new Date('2027-08-31');
    const futureEvents = Object.values(icalEvents).filter(ev => {
      if (ev.type !== 'VEVENT') return false;
      const start = ev.start ? new Date(ev.start) : null;
      return start && start >= today && start <= endDate;
    });
    if (futureEvents.length === 0) return res.status(400).json({ error: 'No upcoming events found in this calendar' });

    const rawEvents = futureEvents.map(ev => ({
      title: ev.summary || 'Untitled Event',
      location: ev.location || '',
      source_category: ev.categories?.[0] || 'School Events',
      ...parseIcalEventDates(ev),
    }));

    // AI classification is best-effort: if it fails, fall back to the
    // previous behavior (group by the feed's own category, type "other")
    // rather than failing the whole import.
    let classifications;
    try {
      classifications = await classifyIcalEventsWithAI(rawEvents);
    } catch (aiErr) {
      console.error('iCal AI classification failed, falling back to raw categories:', aiErr.message);
      classifications = rawEvents.map((r, index) => ({ index, type: 'other', category: r.source_category, recurring_note: null }));
    }
    const classByIndex = new Map(classifications.map(c => [c.index, c]));

    const finalEvents = rawEvents.map((r, index) => {
      const cls = classByIndex.get(index) || { type: 'other', category: r.source_category, recurring_note: null };
      const norm = normalizeExtractedEvent({ ...r, type: cls.type, recurring_note: cls.recurring_note });
      return { title: r.title, ...norm, category: cls.category || r.source_category };
    });

    const categoryMap = new Map();
    for (const ev of finalEvents) {
      if (!categoryMap.has(ev.category)) categoryMap.set(ev.category, 0);
      categoryMap.set(ev.category, categoryMap.get(ev.category) + 1);
    }
    const categories = [...categoryMap.entries()].map(([catName, count]) => ({ name: catName, count }));

    const calId = randomUUID();
    const cals = getUserCalendars(req.user.email);
    await cals.set(calId, { id: calId, name, source: 'ical', url, memberId: memberId || null, event_count: 0, created_at: new Date().toISOString() });

    const events = getUserEvents(req.user.email);
    const eventPairs = finalEvents.map(ev => {
      const evId = randomUUID();
      return [evId, { id: evId, calendar_id: calId, ...ev, attendees: [], source: name, status: 'draft', created_at: new Date().toISOString() }];
    });
    await events.setMany(eventPairs);

    res.json({ ok: true, calendarId: calId, totalEvents: finalEvents.length, categories });
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

async function extractClosures(contentBlock, todayStr) {
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-fable-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: `Today is ${todayStr}.\n\n${CLOSURES_PROMPT}` }] }],
    });
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

app.post('/api/calendars/add-pdf', requireAuth, upload.single('pdf'), async (req, res) => {
  const { name, memberId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  if (!name) return res.status(400).json({ error: 'Calendar name is required' });
  const pdfPath = req.file.path;
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfBase64 = pdfBuffer.toString('base64');
    const response = await anthropic.messages.create({
      model: 'claude-fable-5',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `This is a school/family calendar PDF. Today is ${new Date().toISOString().split('T')[0]}. Only include events from today onward.\n\n${FULL_EXTRACTION_PROMPT}` }
        ]
      }]
    });
    const pdfBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } };
    const closures = await extractClosures(pdfBlock, new Date().toISOString().split('T')[0]);
    const removals = closures.length
      ? matchClosuresToEvents(closures, await liveCalendarEvents(req.user.email))
      : [];

    const text = getResponseText(response);
    let flatEvents;
    try {
      const raw = JSON.parse(text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim());
      flatEvents = Array.isArray(raw) ? raw : [];
    } catch { return res.status(500).json({ error: 'AI could not parse this PDF.' }); }
    // A closure list produces no additions and that is a success, not a
    // failure — it is the whole point of uploading one. Only error when the
    // document had no effect on the calendar at all.
    if (!flatEvents.length && !removals.length) {
      return res.status(400).json({ error: 'No events found in this PDF' });
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

    const calId = randomUUID();
    const totalEvents = flatEvents.length;
    const cals = getUserCalendars(req.user.email);
    await cals.set(calId, { id: calId, name, source: 'pdf', url: req.file.originalname || 'upload.pdf', memberId: memberId || null, event_count: 0, created_at: new Date().toISOString() });
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
        eventPairs.push([evId, { id: evId, calendar_id: calId, title: ev.title, ...norm, notes: combinedNotes, conflict_note: conflictNote || null, attendees: Array.isArray(ev.attendees) ? ev.attendees : [], category: cat.name, source: name, status: 'draft', created_at: new Date().toISOString() }]);
      }
    }
    await events.setMany(eventPairs);
    try { fs.unlinkSync(pdfPath); } catch {}
    res.json({ ok: true, calendarId: calId, totalEvents, categories: parsed.categories.map(c => ({ name: c.name, count: c.events?.length || 0 })), removals });
  } catch (err) {
    console.error('PDF error:', err);
    try { fs.unlinkSync(pdfPath); } catch {}
    res.status(500).json({ error: 'Failed to process PDF: ' + err.message });
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
          const ok = await cancelOneOccurrence(calendar, calId, ev.calEventId, date);
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
  let addedCount = 0;
  const updates = [];
  for (const [id, ev] of await events.entries()) {
    if (ev.calendar_id === calendarId && ev.status === 'draft') {
      if (selectedCategories.includes(ev.category)) {
        try {
          const calEventId = await autoWriteToCalendar(calendar, targetCalId, ev, colorId);
          if (!calEventId) {
            // Already on a calendar — nothing written, so don't claim it was.
            ev.status = 'duplicate'; ev.reviewed = false;
            ev.duplicate_of_calendar = true;
            ev.conflict_note = `Already on your calendar as "${ev.duplicate_of?.title || ev.title}" — not added again`;
            ev.calEventId = null; ev.gcalId = null;
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
        }
      } else {
        ev.status = 'rejected';
      }
      updates.push([id, ev]);
    }
  }
  await events.setMany(updates);
  const cal = await cals.get(calendarId);
  if (cal) { cal.event_count = addedCount; await cals.set(calendarId, cal); }
  res.json({ ok: true, addedCount });
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
app.post('/api/calendars/group-approve', requireAuth, async (req, res) => {
  const { calendarId, category } = req.body;
  if (!calendarId || !category) return res.status(400).json({ error: 'Missing data' });
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

  let addedCount = 0;
  const failed = [];
  const updates = [];
  for (const [id, ev] of groupEvents) {
    try {
      if (!ev.date) throw new Error('Missing date');
      const { start, end } = buildCalendarTimes(ev.date, ev.time, ev.end_date, ev.end_time);
      const eventAttendees = (ev.attendees || []).filter(a => a.email).map(a => ({ email: a.email }));
      const description = ev.type === 'recurring' && ev.recurring_note
        ? `Added via Criba — recurring: ${ev.recurring_note}`
        : 'Added via Criba';
      const resource = { summary: ev.title, location: ev.location || '', start, end, attendees: eventAttendees, description };
      if (ev.recurrence_rule) resource.recurrence = [ensureRecurrenceEnd(ev.recurrence_rule, ev.date, ev.recurrence_end_date)];
      if (colorId) resource.colorId = String(colorId);
      const calEvent = await calendar.events.insert({ calendarId: targetCalId, sendUpdates: 'none', resource });
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
  let count = 0;
  const updates = [];
  for (const [id, ev] of groupEvents) {
    try {
      if (!ev.date) throw new Error('Missing date');
      const calEventId = await autoWriteToCalendar(calendar, targetCalId, ev, colorId);
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
    }
  }
  await events.setMany(updates);
  if (count > 0) {
    const cal = await cals.get(calendarId);
    if (cal) { cal.event_count = (cal.event_count || 0) + count; await cals.set(calendarId, cal); }
  }
  res.json({ ok: true, count });
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
  const { name, color, eventColor } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = randomUUID();
  const member = { id, name: name.trim(), color: color || '7', eventColor: eventColor || color || '7', googleCalendarId: null };
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
  res.json({ testCalendarId, partnerEmail });
});

app.patch('/api/settings', requireAuth, async (req, res) => {
  const settings = getUserSettings(req.user.email);
  const { testCalendarId, partnerEmail } = req.body;
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
function extractEmailBody(payload) {
  const htmlParts = [];
  const plainText = _extractEmailBodyInner(payload, htmlParts);
  const html = htmlParts.length ? stripHtmlTags(htmlParts.join('\n')) : '';

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

// Recursively collect image parts from the MIME tree (inline + attached).
// Returns raw descriptor objects — no data fetching here.
function collectImageParts(payload, parts = []) {
  const mime = (payload.mimeType || '').toLowerCase().split(';')[0].trim();
  if (VISION_IMAGE_TYPES.has(mime) && (payload.body?.data || payload.body?.attachmentId)) {
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
  const MAX_SIZE_BYTES = 1024 * 1024; // 1 MB
  const rawParts = collectImageParts(payload);
  // Prefer smaller images; skip oversized ones (large marketing graphics rarely help)
  const eligible = rawParts
    .filter(p => p.size === 0 || p.size <= MAX_SIZE_BYTES)
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
  console.log(`[vision] msg=${messageId} fetched ${images.length} image(s) for vision extraction`);
  return images;
}

// Call Claude to extract calendar events from a single email.
// When images are supplied (image-heavy emails / flyers), uses multimodal API.
async function extractGmailEvents(body, senderName, senderEmail, subject, images = [], dateSent = '', familyNames = []) {
  const textContent = [subject ? `Subject: ${subject}\n\n` : '', body].join('').slice(0, 8000);

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
    ? `${FULL_EXTRACTION_PROMPT}\n\n${context}\n\nEmail text (may be minimal — event details may be in the attached image(s)):\n${textContent}`
    : `${FULL_EXTRACTION_PROMPT}\n\n${context}\n\nEmail:\n${textContent}`;

  const messageContent = images.length > 0
    ? [
        { type: 'text', text: promptText },
        ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64data } })),
      ]
    : promptText;

  const response = await anthropic.messages.create({
    model: 'claude-fable-5',
    // 2048 was not enough. The budget is shared with the model's thinking
    // tokens, so a multi-event email (a week of practices, a weekly digest)
    // could spend the whole allowance before finishing the JSON array. The
    // reply came back cut off mid-array and the parse below threw.
    max_tokens: 8192,
    messages: [{ role: 'user', content: messageContent }]
  });
  const text = getResponseText(response).trim();
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Claude response truncated at max_tokens (${text.length} chars) — event list too long to fit`);
  }
  try {
    const raw = JSON.parse(text.replace(/^```json\s*/,'').replace(/\s*```$/,''));
    const events = Array.isArray(raw) ? raw : [];
    // Inject sender as attendee name string so it shows in the review card
    return events.map(ev => ({
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
  if (/UNTIL=|COUNT=/.test(up)) return rule;

  let until = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : null;
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
function isDuplicateEventIn(all, title, date, opts = {}) {
  const norm = (s) => (s || '').toLowerCase().trim();
  const shape = recurrenceShape(opts.recurrence);
  const time = opts.time || '';
  return all.some(ev => {
    if (ev.status === 'dismissed') return false;
    if (norm(ev.title) !== norm(title)) return false;
    if (ev.date === date) return true;
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
async function eventsOnDate(calendarApi, calId, date) {
  const key = `${calId}|${date}`;
  const hit = _calDayCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.events;
  const events = await fetchExistingCalendarEvents(calendarApi, calId, [date, date]);
  _calDayCache.set(key, { events, at: Date.now() });
  return events;
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
      .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w))
  );
}
function titlesLooselyMatch(a, b) {
  const ta = titleTokens(a), tb = titleTokens(b);
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
  if (small.size < 2) return false;
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

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

// Fetch new messages since the last known historyId and run extraction.
async function processNewGmailEmails(email, refreshToken, newHistoryId) {
  console.log(`[gmail-process] START email=${email} newHistoryId=${newHistoryId}`);
  const watchDataStr = await redis.get(`gmailWatch:${email}`);
  if (!watchDataStr) {
    console.error(`[gmail-process] ABORT email=${email} — no gmailWatch record in Redis`);
    return;
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
  const gpFamily = await getUserFamily(email).values();
  const gpFamilyNames = gpFamily.map(m => m.name).filter(Boolean);

  // Always advance historyId first so we don't reprocess on retry
  watchData.historyId = newHistoryId || startHistoryId;
  await redis.set(`gmailWatch:${email}`, JSON.stringify(watchData));

  let historyData;
  try {
    const histRes = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    });
    historyData = histRes.data;
  } catch (err) {
    console.error(`Gmail history.list error for ${email}:`, err.message);
    return;
  }

  const messageIds = new Set();
  for (const record of (historyData.history || [])) {
    for (const added of (record.messagesAdded || [])) {
      messageIds.add(added.message.id);
    }
  }
  console.log(`[gmail-process] email=${email} found ${messageIds.size} new message(s) in history`);
  if (!messageIds.size) return;

  const eventsStore = getUserEvents(email);

  for (const messageId of messageIds) {
    console.log(`[gmail-process] email=${email} processing messageId=${messageId}`);
    // Per-message lock — prevents double-processing if Pub/Sub retries
    const lockKey = `gmailMsgLock:${email}:${messageId}`;
    const locked = await redis.set(lockKey, '1', 'EX', 3600, 'NX');
    if (!locked) {
      console.log(`[gmail-process] SKIP messageId=${messageId} — already locked (Pub/Sub retry)`);
      continue;
    }

    try {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const msg = msgRes.data;
      // Skip Promotions / Social tabs — see GMAIL_NOISE_LABELS comment for why Updates/Forums are excluded
      const labelIds = msg.labelIds || [];
      if (labelIds.some(l => GMAIL_NOISE_LABELS.has(l))) {
        console.log(`[gmail-process] SKIP msg=${messageId} — noise category label: ${labelIds.filter(l => GMAIL_NOISE_LABELS.has(l)).join(',')}`);
        continue;
      }
      const headers = msg.payload.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const dateSent = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      const { senderName, senderEmail } = parseFrom(from);
      const body = extractEmailBody(msg.payload);

      // Detect image attachments/inline images in the email.
      // An "image-heavy" email has images but minimal text — the calendar info is
      // likely in a visual flyer (e.g. sports schedules, school newsletters as images).
      const imageParts = collectImageParts(msg.payload);
      const isImageHeavy = imageParts.length > 0 && body.trim().length < 300;
      console.log(`[gmail-process] msg=${messageId} from="${senderEmail}" subject="${subject}" bodyLen=${body.length} images=${imageParts.length} imageHeavy=${isImageHeavy}`);

      // Pre-filter: skip if no calendar keywords in text AND email is not image-heavy.
      // Image-heavy emails bypass the keyword check because event details are in the image.
      if (!checkPreFilter(`${subject} ${body}`, subject, messageId, email) && !isImageHeavy) continue;
      if (isImageHeavy && !checkPreFilter(`${subject} ${body}`, subject, messageId, email)) {
        console.log(`[gmail-process] IMAGE-HEAVY BYPASS msg=${messageId} — skipping pre-filter for vision extraction`);
      }

      // Cross-user duplicate guard: same email sent to multiple family members
      // (e.g. school newsletter to both Priya and Bharat) should only be extracted once.
      // Fingerprint = SHA-256 of senderEmail + subject + Date header (normalised).
      const fpRaw = `${senderEmail.toLowerCase()}:${subject.trim()}:${dateSent.trim()}`;
      const fingerprint = crypto.createHash('sha256').update(fpRaw).digest('hex');
      const fpKey = `processedEmail:${fingerprint}`;
      const alreadyProcessed = await redis.exists(fpKey);
      if (alreadyProcessed) {
        console.log(`[gmail-process] DEDUP SKIP msg=${messageId} fingerprint=${fingerprint.slice(0, 12)}… already extracted for another user`);
        continue;
      }
      // Fetch image data for vision extraction (only when images present)
      const images = imageParts.length > 0
        ? await fetchEmailImages(msg.payload, gmail, messageId)
        : [];

      console.log(`[gmail-process] EXTRACT msg=${messageId} calling Claude subject="${subject}" images=${images.length}`);
      const extracted = await extractGmailEvents(body, senderName, senderEmail, subject, images, dateSent, gpFamilyNames);
      console.log(`[gmail-process] EXTRACT msg=${messageId} Claude returned ${extracted.length} event(s)`);

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
        const tzNote = normalizeEventTimezone(ev);
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
            source: 'gmail', gmail_message_id: messageId,
            sender_name: senderName, sender_email: senderEmail, subject,
            status, type: ev.is_all_day ? 'other' : 'timed',
            created_at: new Date().toISOString(),
          });
          console.log(`[gmail-process] ${intent.toUpperCase()} "${ev.title}" matched="${matchedEvent?.title || 'none'}" confidence=${matchedScore?.toFixed(2) ?? 'n/a'} stored (id=${evId})`);
          continue;
        }

        if (await isDuplicateEvent(eventsStore, ev.title, ev.date, { time: ev.start_time || '', recurrence: ev.recurrence })) {
          console.log(`[gmail-process] msg=${messageId} DEDUP SKIP event "${ev.title}" on ${ev.date} already exists`);
          continue;
        }

        const startTime = ev.start_time || '';
        const endTime = ev.end_time || '';
        const conflictNote = await findConflict(eventsStore, ev.date, startTime, endTime);
        const combinedNotes = ev.notes || null;

        // Auto-write to calendar immediately
        const colorId = await resolveEventColorByNames(email, Array.isArray(ev.attendees) ? ev.attendees : [], [ev.title, ev.location, ev.notes].filter(Boolean).join(' '));
        const evObj = { title: ev.title, date: ev.date, end_date: ev.end_date || '', time: startTime, end_time: endTime, location: ev.location || '', recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null, recurring_note: ev.recurring_note || null, attendees: [] };
        let calEventId = null;
        try {
          calEventId = await autoWriteToCalendar(calendarApi, targetCalId, evObj, colorId);
          console.log(`[gmail-process] GCal WRITE "${ev.title}" on ${ev.date} calEventId=${calEventId}`);
        } catch (calErr) {
          console.error(`[gmail-process] GCal write failed for "${ev.title}":`, calErr.message);
        }
        // Not written because it is already on one of the user's calendars.
        // Recorded as 'duplicate' rather than 'pending' so the review queue says
        // "already on your calendar" instead of looking like a failed write.
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
          conflict_note: calDup
            ? `Already on your calendar as "${calDup.title}"${calDup.calendarName && calDup.calendarId !== targetCalId ? ` (${calDup.calendarName})` : ''} — not added again`
            : conflictNote || null,
          source_type: ev.source_type || null,
          recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null,
          source: 'gmail',
          gmail_message_id: messageId,
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
      }
    } catch (err) {
      console.error(`[gmail-process] ERROR messageId=${messageId} email=${email}:`, err.message, err.stack?.split('\n')[1]);
    }
  }
  console.log(`[gmail-process] DONE email=${email}`);
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
  res.json({ ok: true, email, registered: true, historyId: watchData.historyId, expiresAt, expiredAlready, hasRefreshToken: !!refreshToken, inWatchedSet: !!inWatchedSet, disconnectedAt });
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
    const validEmails = ['gmail-api-push@system.gserviceaccount.com'];
    if (!payload.email_verified || !validEmails.includes(payload.email)) {
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

  res.json({ ok: true, watchedUsers: watchedEmails.length, renewedCount, notifiedCount });
});

// Exposes non-secret client-side configuration. The Places API key is
// publishable (it's restricted by HTTP referrer in Google Cloud Console)
// so returning it here is safe — it never exposes server secrets.
app.get('/api/config', (req, res) => {
  res.json({ placesApiKey: process.env.GOOGLE_PLACES_API_KEY || '' });
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
  { name: 'month-day',  re: /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?/i },
  // Also catch bare ordinals near common date prepositions: "due on the 15th", "by the 3rd"
  { name: 'ordinal',    re: /\b(?:on|by|the|due)\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)\b/i },
  { name: 'weekday',    re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i },
  { name: 'relative',   re: /\b(today|tomorrow|this week|next week|this weekend)\b/i },
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
  for (const { name, re } of SNIPPET_DATE_PATTERNS) {
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
      extracted = await extractGmailEvents(body, h('from'), h('from'), subject, [], dateSent);
    } catch (err) {
      extractError = err.message;
    }
    res.json({
      messageId: id, subject, dateSent,
      bodyLength: body.length, truncatedAt8000: body.length > 8000,
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
      const fpRaw = `${senderEmail}:${subject.trim()}:${dateSent.trim()}`;
      const fpKey = `processedEmail:${crypto.createHash('sha256').update(fpRaw).digest('hex')}`;
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
    console.log(`[fingerprints] cleared email=${email} force=${force} deleted=${deleted} skipped=${skipped} scanned=${scanned} sampleValues=${JSON.stringify(sample)}`);
    res.json({ ok: true, deleted, skipped, scanned, force, sampleValues: sample });
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
    return res.status(500).json({ error: 'Failed to list Gmail messages: ' + err.message });
  }

  console.log(`[backfill] found ${messageIds.length} messages`);

  let scanned = 0, skippedCategory = 0, skippedDedup = 0, skippedPreFilter = 0;
  let claudeCalls = 0, eventsStored = 0, hitLimit = false;
  const dryRunMessages = [];

  // Built once, not per extracted event — this was a redundant OAuth client
  // plus a target-calendar lookup on every single event written.
  const bfCalApi = google.calendar({ version: 'v3', auth: getOAuthClientFromRefreshToken(refreshToken) });
  // Loaded once per request rather than three times per extracted event.
  const knownEvents = dryRun ? [] : await eventsStore.values();
  const familyMembers = dryRun ? [] : await getUserFamily(email).values();
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
      await traceEmail(email, { stage: 'TIMING', note: 'deadline-in-collect', scanned, elapsedMs: Date.now() - startedAt });
      hitLimit = true;
      break;
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
    const fpRaw = `${senderEmail.toLowerCase()}:${subject.trim()}:${dateSent.trim()}`;
    const fingerprint = crypto.createHash('sha256').update(fpRaw).digest('hex');
    const fpKey = `processedEmail:${fingerprint}`;
    if (await redis.exists(fpKey)) {
      skippedDedup++;
      await traceEmail(email, { stage: 'SKIP-DEDUP', messageId, subject, from });
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

    const isImageHeavy = imageParts.length > 0 && body.trim().length < 300;
    if (!snippetScan.pass && !isImageHeavy) {
      const bodyScan = scanForDateContent(`${subject} ${body.slice(0, 5000)}`);
      if (!bodyScan.pass) {
        skippedPreFilter++;
        await traceEmail(email, { stage: 'SKIP-BODY', messageId, subject, from, bodyLen: body.length });
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
      body, imageParts, payload: fullRes.data.payload, fpKey,
    });
    await traceEmail(email, { stage: 'TIMING', messageId, subject, msgMs: Date.now() - msgStart, elapsedMs: Date.now() - startedAt });
  }

  // ── Parallel extraction ────────────────────────────────────────────────────
  // Extractions run in waves. Storage stays serial because it mutates
  // knownEvents for in-run duplicate detection and writes to Google Calendar.
  const CONCURRENCY = 5;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      hitLimit = true;
      await traceEmail(email, { stage: 'TIMING', note: 'deadline-before-wave', scanned: candidates.length - i, elapsedMs: Date.now() - startedAt });
      break;
    }
    const wave = candidates.slice(i, i + CONCURRENCY);
    const waveStart = Date.now();
    const results = await Promise.allSettled(wave.map(async (c) => {
      const images = c.imageParts.length > 0 ? await fetchEmailImages(c.payload, gmail, c.messageId) : [];
      const t0 = Date.now();
      const extracted = await extractGmailEvents(c.body, c.senderName, c.senderEmail, c.subject, images, c.dateSent, familyMembers.map(m => m.name).filter(Boolean));
      return { extracted, claudeMs: Date.now() - t0, imageCount: images.length };
    }));
    console.log(`[backfill] wave of ${wave.length} finished in ${Date.now() - waveStart}ms elapsed=${Date.now() - startedAt}`);

    for (let j = 0; j < wave.length; j++) {
      const c = wave[j];
      const r = results[j];
      claudeCalls++;
      if (r.status === 'rejected') {
        console.error(`[backfill] extraction failed msg=${c.messageId}:`, r.reason?.message);
        await traceEmail(email, { stage: 'ERROR', messageId: c.messageId, subject: c.subject, from: c.from, error: r.reason?.message || 'extraction failed' });
        continue;
      }
      const { extracted, claudeMs, imageCount } = r.value;
      const { messageId, subject, from, dateSent, senderName, senderEmail, fpKey } = c;
      await traceEmail(email, {
        stage: 'SENT-TO-AI', messageId, subject, from, claudeEvents: extracted.length,
        claudeMs, preClaudeMs: 0, elapsedMs: Date.now() - startedAt,
        // An events=0 result is ambiguous without these: it can mean the email
        // genuinely had no dates, or that the body was cut at 8000 chars before
        // the schedule appeared, or that the content was in an unfetched image.
        bodyLen: c.body.length, truncated: c.body.length > 8000, imgs: imageCount,
      });

      try {
        // Fingerprint only after a successful extraction, so anything we did
        // not reach stays eligible for the next scan.
        await redis.set(fpKey, email, 'EX', 30 * 24 * 60 * 60);

        for (const ev of extracted) {
          // Normalize partial dates (e.g. "August 12" → "2026-08-12")
          if (ev.date && !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) {
            const norm = normalizeEventDate(ev.date, dateSent);
            if (norm) { await traceEmail(email, { stage: 'DATE-NORM', messageId, subject, rawDate: ev.date, normalized: norm }); ev.date = norm; }
          }
          if (!ev.title || !ev.date) { await traceEmail(email, { stage: 'DROPPED', messageId, subject, reason: !ev.title ? 'no-title' : 'bad-date', rawDate: ev.date }); continue; }
          // Deadlines come back as midnight; move them to 6am here as well as in
          // buildCalendarTimes so the stored record and the UI agree with the
          // calendar rather than showing "12:00 AM".
          shiftMidnightToMorning(ev);
          const bfTzNote = normalizeEventTimezone(ev);
          if (bfTzNote) ev.notes = [ev.notes, bfTzNote].filter(Boolean).join(' ');

          const intent = ev.intent || 'new_event';
          if (intent === 'cancellation' || intent === 'reschedule') {
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
              source: 'gmail', gmail_message_id: messageId,
              sender_name: senderName, sender_email: senderEmail, subject,
              status: intent === 'cancellation' ? 'pending_cancellation' : 'pending_reschedule',
              type: ev.is_all_day ? 'other' : 'timed', created_at: new Date().toISOString(),
            });
            eventsStored++; continue;
          }

          if (isDuplicateEventIn(knownEvents, ev.title, ev.date, { time: ev.start_time || '', recurrence: ev.recurrence })) continue;
          const startTime = ev.start_time || '', endTime = ev.end_time || '';

          // Already on the calendar from somewhere else — typically a club's
          // subscribed feed. Record it so the user can see Criba found it and
          // chose not to add a second copy, but do not write.
          const existingCalEvents = await existingCalendarEventsFor(ev.date);
          const calDup = findCalendarDuplicate(existingCalEvents, ev.title, ev.date, startTime);
          if (calDup) {
            const dupId = randomUUID();
            await eventsStore.set(dupId, {
              id: dupId, title: ev.title, date: ev.date, end_date: ev.end_date || '',
              time: startTime, end_time: endTime, location: ev.location || '',
              is_all_day: !!ev.is_all_day, attendees: [],
              notes: ev.notes || null,
              conflict_note: `Already on your calendar as "${calDup.title}" — not added again`,
              duplicate_of_calendar: true,
              source_type: ev.source_type || null, recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null,
              source: 'gmail', gmail_message_id: messageId,
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
          const bfColorId = resolveColorIn(familyMembers, Array.isArray(ev.attendees) ? ev.attendees : [], [ev.title, ev.location, ev.notes].filter(Boolean).join(' '));
          let calEventId = null;
          // The check above only saw the target calendar; autoWriteToCalendar
          // additionally checks every other calendar the user subscribes to and
          // returns null (setting duplicate_of) instead of writing a second copy.
          const bfWriteObj = { title: ev.title, date: ev.date, end_date: ev.end_date || '', time: startTime, end_time: endTime, location: ev.location || '', recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null, recurring_note: null, attendees: [] };
          try {
            calEventId = await autoWriteToCalendar(bfCalApi, bfCalId, bfWriteObj, bfColorId);
          } catch (calErr) { console.error(`[backfill] GCal write failed "${ev.title}":`, calErr.message); }
          const otherCalDup = bfWriteObj.duplicate_of || null;
          const evId = randomUUID();
          const stored = {
            id: evId, title: ev.title, date: ev.date, end_date: ev.end_date || '',
            time: startTime, end_time: endTime, location: ev.location || '',
            is_all_day: !!ev.is_all_day, attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
            notes: combinedNotes,
            conflict_note: otherCalDup
              ? `Already on your calendar as "${otherCalDup.title}"${otherCalDup.calendarName && otherCalDup.calendarId !== bfCalId ? ` (${otherCalDup.calendarName})` : ''} — not added again`
              : conflictNote || null,
            duplicate_of_calendar: !!otherCalDup,
            source_type: ev.source_type || null, recurrence_rule: ev.recurrence || null, recurrence_end_date: ev.recurrence_end_date || null,
            source: 'gmail', gmail_message_id: messageId,
            sender_name: senderName, sender_email: senderEmail, subject,
            status: calEventId ? 'added' : (otherCalDup ? 'duplicate' : 'pending'), reviewed: false,
            calEventId: calEventId || null, gcalId: calEventId ? bfCalId : null,
            approved_at: calEventId ? new Date().toISOString() : null,
            type: ev.is_all_day ? 'other' : 'timed', created_at: new Date().toISOString(),
          };
          await eventsStore.set(evId, stored);
          // Keep the cache current so later events in this same run still see it.
          knownEvents.push(stored);
          await traceEmail(email, { stage: 'STORED', messageId, subject, from, title: ev.title, date: ev.date, calEventId, status: calEventId ? 'added' : 'pending' });
          eventsStored++;
        }
      } catch (err) {
        console.error(`[backfill] store error msg=${messageId}:`, err.message);
        await traceEmail(email, { stage: 'ERROR', messageId, subject, from, error: err.message });
      }
    }
  }
  if (claudeCalls < candidates.length) hitLimit = true;

  console.log(`[backfill] DONE scanned=${scanned} skippedCat=${skippedCategory} skippedDedup=${skippedDedup} skippedSignal=${skippedPreFilter} claudeCalls=${claudeCalls} eventsStored=${eventsStored}`);

  if (dryRun) {
    const wouldSend = dryRunMessages.filter(m => m.verdict === 'WOULD_SEND').length;
    return res.json({
      dryRun: true, days, query: q,
      totalFound: messageIds.length, scanned,
      wouldExtract: wouldSend,
      skippedCategory, skippedPreFilter, skippedDedup,
      totalEstTokens: dryRunMessages.filter(m => m.verdict === 'WOULD_SEND').reduce((s, m) => s + (m.estTokens || 0), 0),
      messages: dryRunMessages,
    });
  }

  res.json({ ok: true, days, scanned, skippedCategory, skippedPreFilter, skippedDedup, claudeCalls, eventsStored, totalFound: messageIds.length, hitLimit });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Criba running on port ${PORT}`));

export default app;
