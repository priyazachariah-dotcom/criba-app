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

    // The People API's searchContacts endpoint uses a lazy, per-account
    // cache: the first search after login (or after the cache expires)
    // silently returns zero results until a "warmup" request with an
    // empty query has synced it. See:
    // https://developers.google.com/people/api/rest/v1/people/searchContacts
    // https://github.com/googleapis/google-api-nodejs-client/issues/3277
    // We warm it at most once every 10 minutes per user (tracked in Redis)
    // so normal keystroke-by-keystroke searches don't pay for it every time.
    const warmKey = `contacts_warm:${req.user.email}`;
    const alreadyWarm = await redis.get(warmKey);
    if (!alreadyWarm) {
      try {
        const warmup = await people.people.searchContacts({ query: '', readMask: 'names,emailAddresses', pageSize: 1 });
        console.log('Contacts warmup response:', JSON.stringify(warmup.data));
      } catch (warmErr) {
        console.error('Contacts warmup error:', JSON.stringify(warmErr.response?.data || warmErr.message));
      }
      await redis.set(warmKey, '1', 'EX', 600);
    }

    const response = await people.people.searchContacts({
      query: q,
      readMask: 'names,emailAddresses',
      pageSize: 10,
    });
    console.log(`Contacts search "${q}" raw response:`, JSON.stringify(response.data));
    const contacts = (response.data.results || []).map(r => ({
      name: r.person?.names?.[0]?.displayName || '',
      email: r.person?.emailAddresses?.[0]?.value || '',
    })).filter(c => c.email);
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
      calendarId: 'primary',
      sendUpdates: 'all',
      resource: { summary: title || event.title, location: location || event.location || '', start, end, attendees: eventAttendees, description }
    });
    event.status = 'approved';
    event.calEventId = calEvent.data.id;
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
    await calendar.events.delete({ calendarId: 'primary', eventId: event.calEventId });
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
      calendarId: 'primary',
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
  const { name, url } = req.body;
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
    await cals.set(calId, { id: calId, name, source: 'ical', url, event_count: 0, created_at: new Date().toISOString() });

    const events = getUserEvents(req.user.email);
    const eventPairs = finalEvents.map(ev => {
      const evId = randomUUID();
      return [evId, { id: evId, calendar_id: calId, ...ev, source: name, status: 'draft', created_at: new Date().toISOString() }];
    });
    await events.setMany(eventPairs);

    res.json({ ok: true, calendarId: calId, totalEvents: finalEvents.length, categories });
  } catch (err) {
    console.error('iCal error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar: ' + err.message });
  }
});

app.post('/api/calendars/add-pdf', requireAuth, upload.single('pdf'), async (req, res) => {
  const { name } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  if (!name) return res.status(400).json({ error: 'Calendar name is required' });
  const pdfPath = req.file.path;
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfBase64 = pdfBuffer.toString('base64');
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
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
    await cals.set(calId, { id: calId, name, source: 'pdf', url: req.file.originalname || 'upload.pdf', event_count: 0, created_at: new Date().toISOString() });
    const events = getUserEvents(req.user.email);
    const eventPairs = [];
    for (const cat of parsed.categories) {
      for (const ev of (cat.events || [])) {
        const evId = randomUUID();
        const norm = normalizeExtractedEvent(ev);
        eventPairs.push([evId, { id: evId, calendar_id: calId, title: ev.title, ...norm, category: cat.name, source: name, status: 'draft', created_at: new Date().toISOString() }]);
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Criba running on port ${PORT}`));

export default app;
