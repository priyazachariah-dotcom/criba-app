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

// Creates a dedicated Google Calendar for a family member on first approval,
// sets the chosen color, persists the calendarId back to Redis, and returns it.
// On subsequent calls the stored calendarId is returned immediately.
async function ensureMemberCalendar(calendarApi, member, email) {
  if (member.googleCalendarId) return member.googleCalendarId;
  const cal = await calendarApi.calendars.insert({
    resource: { summary: member.name, description: `Criba calendar for ${member.name}` }
  });
  const gcalId = cal.data.id;
  try {
    await calendarApi.calendarList.patch({
      calendarId: gcalId,
      resource: { colorId: member.color || '7' }
    });
  } catch (e) {
    console.error('Could not set calendar color:', e.message);
  }
  member.googleCalendarId = gcalId;
  await getUserFamily(email).set(member.id, member);
  return gcalId;
}

// Shared event-classification rules used by both the PDF and iCal
// extraction prompts, so a break/holiday/timed-event/minimum-day/
// recurring-pattern is turned into the right shape of calendar entry
// instead of being copied verbatim from the source.
const EVENT_CLASSIFICATION_RULES = `Classify every event into exactly one "type" and follow its rules:
- "break": a multi-day break or vacation (Thanksgiving Break, Winter Break, Spring Break, or any other span of consecutive non-school days). Output ONE event for the whole break: "date" = first day, "end_date" = last day. Never output one event per day of a break.
- "holiday": a single-day public/federal holiday (Columbus Day, Veterans Day, MLK Day, Labor Day, etc). Output one all-day event on that date. Leave "time", "end_time" and "end_date" null.
- "timed": a school event with a specific time (Back to School Night, Open House, Picture Day with a time, concerts, games). Set "time" to the start time. Set "end_time" to the given end time, or exactly one hour after "time" if no end time is stated.
- "minimum_day": a minimum/early-dismissal day or a late-start day tied to one specific date. Set "time" if a dismissal/start time is given, otherwise leave it null (all-day).
- "recurring": a pattern that repeats on a schedule rather than fixed one-off dates (e.g. "every Tuesday is a late start day", "early dismissal every first Friday"). Output ONE event with "recurring_note" describing the pattern in plain English (e.g. "Every Tuesday"). Never expand this into one event per occurrence.
- "other": anything that doesn't fit the above — treat as a normal single event, all-day unless a specific time is stated.`;

const EVENT_JSON_SCHEMA = `{"categories":[{"name":"Category name","events":[{"title":"Event name","type":"holiday|break|timed|minimum_day|recurring|other","date":"YYYY-MM-DD","end_date":"YYYY-MM-DD or null (only for type=break)","time":"HH:MM or null (24hr)","end_time":"HH:MM or null (only for type=timed/minimum_day)","location":"string or null","recurring_note":"string or null (only for type=recurring)"}]}]}`;

// Applies defaults/safety-net rules server-side in case the model's
// output doesn't perfectly follow the schema (e.g. a timed event missing
// end_time, or a break missing end_date).
function normalizeExtractedEvent(ev) {
  const validTypes = ['break', 'holiday', 'timed', 'minimum_day', 'recurring', 'other'];
  const type = validTypes.includes(ev.type) ? ev.type : 'other';
  const time = ev.time || '';
  let endTime = ev.end_time || '';
  if (time && !endTime && (type === 'timed' || type === 'minimum_day')) {
    const [h, m] = time.split(':').map(Number);
    const endHour = h + 1 > 23 ? 23 : h + 1;
    endTime = `${String(endHour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return {
    type,
    date: ev.date,
    end_date: type === 'break' ? (ev.end_date || ev.date) : '',
    time,
    end_time: (type === 'timed' || type === 'minimum_day') ? endTime : '',
    location: ev.location || '',
    recurring_note: type === 'recurring' ? (ev.recurring_note || '') : '',
  };
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
function buildCalendarTimes(date, time, endDate, endTime) {
  const tz = 'America/Los_Angeles';
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
    const auth = getOAuthClient(req.user);
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
  const pending = (await events.values()).filter(e => e.status === 'pending').sort((a,b) => a.date > b.date ? 1 : -1);
  res.json(pending);
});

app.get('/api/events/recent', requireAuth, async (req, res) => {
  const events = getUserEvents(req.user.email);
  const approved = (await events.values())
    .filter(e => e.status === 'approved')
    .sort((a,b) => b.approved_at > a.approved_at ? 1 : -1)
    .slice(0, 20);
  res.json(approved);
});

app.post('/api/events/approve', requireAuth, async (req, res) => {
  const { id, title, date, time, endDate, endTime, location, attendees, shareToBharat } = req.body;
  const events = getUserEvents(req.user.email);
  const event = await events.get(id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = getOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    if (!date) return res.status(400).json({ error: 'Date is required' });

    // Resolve the target Google Calendar. Priority:
    // 1. Explicit targetMemberId from UI (e.g. review queue family selector)
    // 2. Member assignment stored on the source calendar (PDF/iCal flow)
    // 3. Primary calendar
    const { targetMemberId } = req.body;
    let targetCalId = 'primary';
    if (targetMemberId) {
      const member = await getUserFamily(req.user.email).get(targetMemberId);
      if (member) targetCalId = await ensureMemberCalendar(calendar, member, req.user.email);
    } else if (event.calendar_id) {
      const cals = getUserCalendars(req.user.email);
      const calSrc = await cals.get(event.calendar_id);
      if (calSrc?.memberId) {
        const member = await getUserFamily(req.user.email).get(calSrc.memberId);
        if (member) targetCalId = await ensureMemberCalendar(calendar, member, req.user.email);
      }
    }

    const finalEndDate = endDate || event.end_date || '';
    const finalEndTime = endTime || event.end_time || '';
    const { start, end } = buildCalendarTimes(date, time, finalEndDate, finalEndTime);
    const eventAttendees = [];
    if (shareToBharat) eventAttendees.push({ email: 'bharatguruprakash@gmail.com' });
    if (attendees && Array.isArray(attendees)) {
      attendees.forEach(a => { if (a.email) eventAttendees.push({ email: a.email }); });
    }
    const description = event.type === 'recurring' && event.recurring_note
      ? `Added via Criba — recurring: ${event.recurring_note}`
      : 'Added via Criba';
    const calEvent = await calendar.events.insert({
      calendarId: targetCalId,
      sendUpdates: 'all',
      resource: { summary: title || event.title, location: location || event.location || '', start, end, attendees: eventAttendees, description }
    });
    event.status = 'approved';
    event.calEventId = calEvent.data.id;
    event.gcalId = targetCalId;
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
    const auth = getOAuthClient(req.user);
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
    const auth = getOAuthClient(req.user);
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
  const text = response.content[0].text;
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
          { type: 'text', text: `This is a school calendar PDF. Extract ALL events, dates and holidays. Today is ${new Date().toISOString().split('T')[0]}. Only include events from today onward.

${EVENT_CLASSIFICATION_RULES}

Return JSON: ${EVENT_JSON_SCHEMA}. Group by category from the document. Return ONLY valid JSON, no markdown.` }
        ]
      }]
    });
    const text = response.content[0].text;
    let parsed;
    try { parsed = JSON.parse(text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()); }
    catch { return res.status(500).json({ error: 'AI could not parse this PDF.' }); }
    if (!parsed.categories?.length) return res.status(400).json({ error: 'No events found in this PDF' });
    const calId = randomUUID();
    const totalEvents = parsed.categories.reduce((sum, c) => sum + (c.events?.length || 0), 0);
    const cals = getUserCalendars(req.user.email);
    await cals.set(calId, { id: calId, name, source: 'pdf', url: req.file.originalname || 'upload.pdf', memberId: memberId || null, event_count: 0, created_at: new Date().toISOString() });
    const events = getUserEvents(req.user.email);
    const eventPairs = [];
    for (const cat of parsed.categories) {
      for (const ev of (cat.events || [])) {
        const evId = randomUUID();
        const norm = normalizeExtractedEvent(ev);
        eventPairs.push([evId, { id: evId, calendar_id: calId, title: ev.title, ...norm, attendees: [], category: cat.name, source: name, status: 'draft', created_at: new Date().toISOString() }]);
      }
    }
    await events.setMany(eventPairs);
    try { fs.unlinkSync(pdfPath); } catch {}
    res.json({ ok: true, calendarId: calId, totalEvents, categories: parsed.categories.map(c => ({ name: c.name, count: c.events?.length || 0 })) });
  } catch (err) {
    console.error('PDF error:', err);
    try { fs.unlinkSync(pdfPath); } catch {}
    res.status(500).json({ error: 'Failed to process PDF: ' + err.message });
  }
});

app.post('/api/calendars/confirm-categories', requireAuth, async (req, res) => {
  const { calendarId, selectedCategories } = req.body;
  if (!calendarId || !selectedCategories) return res.status(400).json({ error: 'Missing data' });
  const events = getUserEvents(req.user.email);
  let addedCount = 0;
  const updates = [];
  for (const [id, ev] of await events.entries()) {
    if (ev.calendar_id === calendarId && ev.status === 'draft') {
      if (selectedCategories.includes(ev.category)) { ev.status = 'pending'; addedCount++; }
      else { ev.status = 'rejected'; }
      updates.push([id, ev]);
    }
  }
  await events.setMany(updates);
  const cals = getUserCalendars(req.user.email);
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

  const auth = getOAuthClient(req.user);
  const calendar = google.calendar({ version: 'v3', auth });

  // Resolve target Google Calendar once for the whole group
  const cals = getUserCalendars(req.user.email);
  let targetCalId = 'primary';
  const calSrc = await cals.get(calendarId);
  if (calSrc?.memberId) {
    const member = await getUserFamily(req.user.email).get(calSrc.memberId);
    if (member) targetCalId = await ensureMemberCalendar(calendar, member, req.user.email);
  }

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
      const calEvent = await calendar.events.insert({
        calendarId: targetCalId,
        sendUpdates: 'all',
        resource: { summary: ev.title, location: ev.location || '', start, end, attendees: eventAttendees, description }
      });
      ev.status = 'approved';
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

// Sends every draft event in one category into the existing per-event
// review queue (status 'pending'), leaving other categories untouched so
// the user can act on groups independently instead of an all-or-nothing
// confirm step.
app.post('/api/calendars/group-review', requireAuth, async (req, res) => {
  const { calendarId, category } = req.body;
  if (!calendarId || !category) return res.status(400).json({ error: 'Missing data' });
  const events = getUserEvents(req.user.email);
  let count = 0;
  const updates = [];
  for (const [id, ev] of await events.entries()) {
    if (ev.calendar_id === calendarId && ev.category === category && ev.status === 'draft') {
      ev.status = 'pending';
      updates.push([id, ev]);
      count++;
    }
  }
  await events.setMany(updates);
  if (count > 0) {
    const cals = getUserCalendars(req.user.email);
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
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = randomUUID();
  const member = { id, name: name.trim(), color: color || '7', googleCalendarId: null };
  await getUserFamily(req.user.email).set(id, member);
  res.json(member);
});

app.patch('/api/family/:id', requireAuth, async (req, res) => {
  const fam = getUserFamily(req.user.email);
  const member = await fam.get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) member.name = req.body.name.trim();
  if (req.body.color) member.color = req.body.color;
  await fam.set(req.params.id, member);
  res.json(member);
});

app.delete('/api/family/:id', requireAuth, async (req, res) => {
  await getUserFamily(req.user.email).delete(req.params.id);
  res.json({ ok: true });
});

// ── Gmail push notifications ───────────────────────────────────────────────

// Pre-filter keyword sets — only pay Claude if the email looks calendar-relevant.
const PREFILTER_WORDS = new Set([
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
  'tomorrow','tonight','next week',
  'january','february','march','april','may','june','july','august',
  'september','october','november','december',
  'meeting','game','practice','rehearsal','appointment','coffee','lunch',
  'dinner','breakfast','pickup','dropoff','tournament','recital','concert',
  'performance','schedule','reminder','event','class','session','camp',
]);
// Patterns checked separately because they're substrings, not whole words
const PREFILTER_PATTERNS = ['am','pm',"o'clock"];

function passesPreFilter(text) {
  const lower = text.toLowerCase();
  if (PREFILTER_PATTERNS.some(p => lower.includes(p))) return true;
  const words = lower.split(/\W+/);
  return words.some(w => PREFILTER_WORDS.has(w));
}

// Parse "Name <email>" or "email" from a From header
function parseFrom(fromHeader) {
  const match = fromHeader.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) return { senderName: match[1].replace(/^"|"$/g, '').trim(), senderEmail: match[2].trim() };
  return { senderName: '', senderEmail: fromHeader.trim() };
}

// Recursively find plain-text body in Gmail message payload
function extractEmailBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  for (const part of (payload.parts || [])) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
  }
  for (const part of (payload.parts || [])) {
    const text = extractEmailBody(part);
    if (text) return text;
  }
  return '';
}

// Call Claude to extract calendar events from a single email
async function extractGmailEvents(body, senderName, senderEmail, subject) {
  const content = [subject ? `Subject: ${subject}\n\n` : '', body].join('').slice(0, 8000);
  const response = await anthropic.messages.create({
    model: 'claude-fable-5',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Extract all calendar-worthy events from this email. For each event return JSON with these fields:
- title (string)
- date (YYYY-MM-DD)
- end_date (YYYY-MM-DD, only for multi-day events, else null)
- start_time (HH:MM 24hr, null if all-day)
- end_time (HH:MM 24hr, null if all-day; default 1hr after start if not given)
- location (string or null)
- is_all_day (boolean)
- attendees (array of {name, email} — always include the sender)

Classification rules:
- A break/vacation → single multi-day event (date=first day, end_date=last day), is_all_day:true
- A holiday → single all-day event, is_all_day:true
- A timed event → is_all_day:false, set start_time and end_time (default +1hr)
- No time mentioned → is_all_day:true
- Sender is always an attendee: {name:"${senderName}",email:"${senderEmail}"}
- If no calendar-worthy events exist, return {"events":[]}

Return ONLY valid JSON like: {"events":[{...},{...}]}

Email:
${content}`
    }]
  });
  const text = response.content[0].text.trim();
  try {
    const json = JSON.parse(text.replace(/^```json\s*/,'').replace(/\s*```$/,''));
    return Array.isArray(json.events) ? json.events : [];
  } catch {
    console.error('Gmail extraction: JSON parse failed:', text.slice(0, 200));
    return [];
  }
}

// Check our Redis event store for an event with the same title+date.
// NOTE: This catches duplicates already managed by Criba. It does NOT check
// events added to Google Calendar outside of Criba (would need a slow GCal
// API call per event).
async function isDuplicateEvent(eventsStore, title, date) {
  const all = await eventsStore.values();
  const norm = (s) => (s || '').toLowerCase().trim();
  return all.some(ev =>
    norm(ev.title) === norm(title) &&
    ev.date === date &&
    ev.status !== 'dismissed'
  );
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
  const watchDataStr = await redis.get(`gmailWatch:${email}`);
  if (!watchDataStr) return;
  const watchData = JSON.parse(watchDataStr);
  const startHistoryId = watchData.historyId;

  const auth = getOAuthClientFromRefreshToken(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });

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
  if (!messageIds.size) return;

  const eventsStore = getUserEvents(email);

  for (const messageId of messageIds) {
    // Per-message lock — prevents double-processing if Pub/Sub retries
    const lockKey = `gmailMsgLock:${email}:${messageId}`;
    const locked = await redis.set(lockKey, '1', 'EX', 3600, 'NX');
    if (!locked) continue; // already processed

    try {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const msg = msgRes.data;
      const headers = msg.payload.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const { senderName, senderEmail } = parseFrom(from);
      const body = extractEmailBody(msg.payload);

      if (!passesPreFilter(`${subject} ${body}`)) continue;

      const extracted = await extractGmailEvents(body, senderName, senderEmail, subject);

      for (const ev of extracted) {
        if (!ev.title || !ev.date) continue;
        if (await isDuplicateEvent(eventsStore, ev.title, ev.date)) continue;

        const evId = randomUUID();
        await eventsStore.set(evId, {
          id: evId,
          title: ev.title,
          date: ev.date,
          end_date: ev.end_date || '',
          time: ev.start_time || '',
          end_time: ev.end_time || '',
          location: ev.location || '',
          is_all_day: !!ev.is_all_day,
          attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
          source: 'gmail',
          gmail_message_id: messageId,
          sender_name: senderName,
          sender_email: senderEmail,
          subject,
          status: 'pending',
          type: ev.is_all_day ? 'other' : 'timed',
          created_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`Gmail processing error for message ${messageId}:`, err.message);
    }
  }
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

// POST /api/gmail/webhook — receives Google Pub/Sub push notifications.
// Must be public (no requireAuth). Verified via Google-signed JWT in Authorization header.
app.post('/api/gmail/webhook', async (req, res) => {
  // Verify the request carries a valid Google-signed Bearer JWT
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth header' });
  }
  const token = authHeader.slice(7);
  try {
    const verifier = new google.auth.OAuth2();
    const ticket = await verifier.verifyIdToken({ idToken: token });
    const payload = ticket.getPayload();
    // Gmail push notifications are signed by this Google service account
    const validEmails = ['gmail-api-push@system.gserviceaccount.com'];
    if (!validEmails.includes(payload.email) && !payload.email_verified) {
      return res.status(401).json({ error: 'Invalid token issuer' });
    }
  } catch (err) {
    console.error('Pub/Sub JWT verification failed:', err.message);
    return res.status(401).json({ error: 'JWT verification failed' });
  }

  const { message } = req.body || {};
  if (!message?.data) return res.status(200).json({ ok: true }); // ack empty messages

  let emailAddress, historyId;
  try {
    const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf-8'));
    emailAddress = decoded.emailAddress;
    historyId = decoded.historyId;
  } catch {
    return res.status(200).json({ ok: true }); // ack malformed messages
  }

  if (!emailAddress) return res.status(200).json({ ok: true });

  const refreshToken = await redis.get(`refreshToken:${emailAddress}`);
  if (!refreshToken) {
    console.log(`Gmail webhook: no refresh token for ${emailAddress}`);
    return res.status(200).json({ ok: true });
  }

  // Process synchronously before responding — Vercel terminates functions
  // after the response is sent. 60-second limit is enough for ~6 emails.
  try {
    await processNewGmailEmails(emailAddress, refreshToken, historyId);
  } catch (err) {
    console.error('Gmail processing error:', err.message);
  }

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
            await registerGmailWatch(email, refreshToken);
            renewedCount++;
          }
        }
      }

      // Send notification if user has pending Gmail events
      const eventsStore = getUserEvents(email);
      const pendingGmail = (await eventsStore.values()).filter(e => e.status === 'pending' && e.source === 'gmail');
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Criba running on port ${PORT}`));

export default app;
