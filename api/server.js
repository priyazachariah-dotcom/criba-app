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
- Do NOT expand recurring events into individual occurrences.
- For non-recurring events, recurrence = null.

For each extracted item return a JSON object with:
- title (clear, specific — not generic)
- date (YYYY-MM-DD)
- end_date (YYYY-MM-DD, only if multi-day, else null)
- start_time (HH:MM 24hr format, null if all-day)
- end_time (HH:MM 24hr format, null if all-day or unknown — default 1 hour after start if timed)
- location (full address if available, venue name if not, null if none)
- is_all_day (boolean)
- attendees (array of family member name strings tagged to this event, empty array if none specified)
- notes (all relevant details — attire, what to bring, action required, financial amounts, RSVP info; null if nothing extra)
- source_type ("event", "deadline", "action_item", or "financial_reminder")
- recurrence (Google Calendar RRULE string if recurring, null if one-time)

Return a JSON array only. No other text. If nothing calendar-worthy is found, return [].`;

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
    notes: ev.notes || null,
    source_type: ev.source_type || null,
    recurrence_rule: ev.recurrence || null,
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

    // Use the RRULE from body if the user kept it, or fall back to the stored rule.
    // The frontend sends recurrenceRule: null to remove recurrence before adding.
    const recurrenceRule = Object.prototype.hasOwnProperty.call(req.body, 'recurrenceRule')
      ? req.body.recurrenceRule
      : event.recurrence_rule;

    const calEventResource = { summary: title || event.title, location: location || event.location || '', start, end, attendees: eventAttendees, description };
    if (recurrenceRule) calEventResource.recurrence = [recurrenceRule];

    const calEvent = await calendar.events.insert({
      calendarId: targetCalId,
      sendUpdates: 'all',
      resource: calEventResource,
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
          { type: 'text', text: `This is a school/family calendar PDF. Today is ${new Date().toISOString().split('T')[0]}. Only include events from today onward.\n\n${FULL_EXTRACTION_PROMPT}` }
        ]
      }]
    });
    const text = response.content[0].text;
    let flatEvents;
    try {
      const raw = JSON.parse(text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim());
      flatEvents = Array.isArray(raw) ? raw : [];
    } catch { return res.status(500).json({ error: 'AI could not parse this PDF.' }); }
    if (!flatEvents.length) return res.status(400).json({ error: 'No events found in this PDF' });

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
        const combinedNotes = [norm.notes, conflictNote].filter(Boolean).join('\n') || null;
        eventPairs.push([evId, { id: evId, calendar_id: calId, title: ev.title, ...norm, notes: combinedNotes, conflict_note: conflictNote || null, attendees: Array.isArray(ev.attendees) ? ev.attendees : [], category: cat.name, source: name, status: 'draft', created_at: new Date().toISOString() }]);
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

// Wrapper used inside processNewGmailEmails — logs the pre-filter decision.
function checkPreFilter(text, subject, messageId, email) {
  const lower = text.toLowerCase();
  const matchedPattern = PREFILTER_PATTERNS.find(p => lower.includes(p));
  if (matchedPattern) {
    console.log(`[prefilter] PASS msg=${messageId} user=${email} subject="${subject}" matched pattern "${matchedPattern}"`);
    return true;
  }
  const words = lower.split(/\W+/);
  const matchedWord = words.find(w => PREFILTER_WORDS.has(w));
  if (matchedWord) {
    console.log(`[prefilter] PASS msg=${messageId} user=${email} subject="${subject}" matched word "${matchedWord}"`);
    return true;
  }
  console.log(`[prefilter] SKIP msg=${messageId} user=${email} subject="${subject}" — no calendar keywords found`);
  return false;
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
async function extractGmailEvents(body, senderName, senderEmail, subject, images = []) {
  const textContent = [subject ? `Subject: ${subject}\n\n` : '', body].join('').slice(0, 8000);
  const promptText = images.length > 0
    ? `${FULL_EXTRACTION_PROMPT}\n\nEmail text (may be minimal — event details may be in the attached image(s)):\n${textContent}`
    : `${FULL_EXTRACTION_PROMPT}\n\nEmail:\n${textContent}`;

  const messageContent = images.length > 0
    ? [
        { type: 'text', text: promptText },
        ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64data } })),
      ]
    : promptText;

  const response = await anthropic.messages.create({
    model: 'claude-fable-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: messageContent }]
  });
  const text = response.content[0].text.trim();
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

// Convert "HH:MM" to minutes since midnight for overlap comparison
function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
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
      // Skip Promotions / Social / noise category tabs — calendar events don't live there
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
      // Mark as processed for 30 days before extraction so concurrent webhooks don't race
      await redis.set(fpKey, email, 'EX', 30 * 24 * 60 * 60);

      // Fetch image data for vision extraction (only when images present)
      const images = imageParts.length > 0
        ? await fetchEmailImages(msg.payload, gmail, messageId)
        : [];

      console.log(`[gmail-process] EXTRACT msg=${messageId} calling Claude subject="${subject}" images=${images.length}`);
      const extracted = await extractGmailEvents(body, senderName, senderEmail, subject, images);
      console.log(`[gmail-process] EXTRACT msg=${messageId} Claude returned ${extracted.length} event(s)`);

      for (const ev of extracted) {
        if (!ev.title || !ev.date) {
          console.log(`[gmail-process] msg=${messageId} skipping event missing title/date: ${JSON.stringify(ev).slice(0,100)}`);
          continue;
        }
        if (await isDuplicateEvent(eventsStore, ev.title, ev.date)) {
          console.log(`[gmail-process] msg=${messageId} DEDUP SKIP event "${ev.title}" on ${ev.date} already exists`);
          continue;
        }

        const startTime = ev.start_time || '';
        const endTime = ev.end_time || '';
        const conflictNote = await findConflict(eventsStore, ev.date, startTime, endTime);
        const combinedNotes = [ev.notes, conflictNote].filter(Boolean).join('\n') || null;

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
          conflict_note: conflictNote || null,
          source_type: ev.source_type || null,
          recurrence_rule: ev.recurrence || null,
          source: 'gmail',
          gmail_message_id: messageId,
          sender_name: senderName,
          sender_email: senderEmail,
          subject,
          status: 'pending',
          type: ev.is_all_day ? 'other' : 'timed',
          created_at: new Date().toISOString(),
        });
        console.log(`[gmail-process] STORED event "${ev.title}" on ${ev.date} for ${email} (id=${evId})`);
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
  res.json({ gmailDisconnected: !!disconnectedAt, gmailDisconnectedAt: disconnectedAt || null });
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
    // Gmail push notifications are signed by this Google service account
    const validEmails = ['gmail-api-push@system.gserviceaccount.com'];
    if (!validEmails.includes(payload.email) && !payload.email_verified) {
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

// Gmail category labels that indicate noise (Promotions / Social / Updates / Forums tabs).
// Excluded at query level for backfill and by label check in the live webhook.
const GMAIL_NOISE_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);

// POST /api/gmail/backfill — scan recent Gmail inbox for calendar events.
// Default window: 2 days (48h). Max Claude extractions per run: 10.
// Uses two-stage fetch: metadata only first, full body only if subject passes pre-filter.
// Safe to call multiple times — fingerprint + per-message lock prevent re-extraction.
app.post('/api/gmail/backfill', requireAuth, async (req, res) => {
  const email = req.user.email;
  // Default 2 days for quick first-run; caller can request up to 30 for deeper scan
  const days = Math.min(parseInt(req.body?.days || '2'), 30);
  // Cap Claude calls per run so we always finish within the 60s Vercel limit.
  // Each Claude call takes ~3-5s; 10 calls = ~30-50s, leaving headroom.
  const MAX_EXTRACT = 10;

  const refreshToken = await redis.get(`refreshToken:${email}`);
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token — please sign out and sign back in' });

  const auth = getOAuthClientFromRefreshToken(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });
  const eventsStore = getUserEvents(email);

  // Exclude noise categories at query level so we never even fetch their metadata
  const afterDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const afterUnix = Math.floor(afterDate.getTime() / 1000);
  const q = `in:inbox after:${afterUnix} -category:promotions -category:social -category:updates -category:forums`;

  console.log(`[backfill] START email=${email} days=${days} maxExtract=${MAX_EXTRACT} query="${q}"`);

  // Collect message IDs from list (cheap — no body)
  let allMessageIds = [];
  let pageToken;
  try {
    do {
      const listRes = await gmail.users.messages.list({
        userId: 'me', q, maxResults: 100,
        ...(pageToken ? { pageToken } : {}),
      });
      const msgs = listRes.data.messages || [];
      allMessageIds.push(...msgs.map(m => m.id));
      pageToken = listRes.data.nextPageToken;
    } while (pageToken && allMessageIds.length < 300); // safety cap
  } catch (err) {
    console.error('[backfill] messages.list failed:', err.message);
    return res.status(500).json({ error: 'Failed to list Gmail messages: ' + err.message });
  }

  console.log(`[backfill] email=${email} found ${allMessageIds.length} message IDs`);

  let scanned = 0;
  let skippedLock = 0;
  let skippedCategory = 0;
  let skippedPreFilter = 0;
  let skippedDedup = 0;
  let claudeCalls = 0;
  let eventsExtracted = 0;
  let eventsStored = 0;
  let truncated = false;

  for (const messageId of allMessageIds) {
    // Stop calling Claude if we've hit the per-run cap — still finish the loop
    // for accounting, but don't fetch full bodies we can't process this run.
    if (claudeCalls >= MAX_EXTRACT) {
      truncated = true;
      break; // remaining messages will be re-eligible on the next backfill run
    }

    scanned++;

    // Per-message lock — skip if already processed by live webhook or a prior backfill
    const lockKey = `gmailMsgLock:${email}:${messageId}`;
    const locked = await redis.set(lockKey, '1', 'EX', 3600, 'NX');
    if (!locked) { skippedLock++; continue; }

    try {
      // Stage 1: metadata-only fetch (headers only — much cheaper than format:full)
      const metaRes = await gmail.users.messages.get({
        userId: 'me', id: messageId, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const meta = metaRes.data;

      // Skip noise categories even if they slipped through the query filter
      const labelIds = meta.labelIds || [];
      if (labelIds.some(l => GMAIL_NOISE_LABELS.has(l))) {
        skippedCategory++;
        await redis.del(lockKey); // let the live webhook handle if it somehow gets it
        continue;
      }

      const metaHeaders = meta.payload?.headers || [];
      const subject = metaHeaders.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const from = metaHeaders.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const dateSent = metaHeaders.find(h => h.name.toLowerCase() === 'date')?.value || '';
      const sizeEstimate = meta.sizeEstimate || 0;

      const subjectPassesFilter = checkPreFilter(subject, subject, messageId, email);
      // Route to Stage 2 if: subject matches keywords, OR email is large enough to
      // plausibly contain image attachments (>30 KB threshold). Small emails with no
      // subject keywords are text-only and safe to skip.
      const LARGE_EMAIL_BYTES = 30000;
      const mightHaveImages = sizeEstimate >= LARGE_EMAIL_BYTES;
      if (!subjectPassesFilter && !mightHaveImages) {
        skippedPreFilter++;
        await redis.del(lockKey); // release — webhook will handle live arrivals
        continue;
      }
      if (!subjectPassesFilter && mightHaveImages) {
        console.log(`[backfill] msg=${messageId} subject failed pre-filter but size=${sizeEstimate}B — routing to Stage 2 for image check`);
      }

      // Cross-user fingerprint dedup (subject-level, before full fetch)
      const { senderName, senderEmail } = parseFrom(from);
      const fpRaw = `${senderEmail.toLowerCase()}:${subject.trim()}:${dateSent.trim()}`;
      const fingerprint = crypto.createHash('sha256').update(fpRaw).digest('hex');
      const fpKey = `processedEmail:${fingerprint}`;
      const alreadyProcessed = await redis.exists(fpKey);
      if (alreadyProcessed) {
        skippedDedup++;
        await redis.del(lockKey);
        continue;
      }

      // Stage 2: full fetch — only for messages that passed routing gate + dedup
      const fullRes = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      const body = extractEmailBody(fullRes.data.payload);

      // Detect images
      const imageParts = collectImageParts(fullRes.data.payload);
      const isImageHeavy = imageParts.length > 0 && body.trim().length < 300;

      // Full pre-filter on subject+body; image-heavy emails bypass it
      if (!checkPreFilter(`${subject} ${body}`, subject, messageId, email) && !isImageHeavy) {
        skippedPreFilter++;
        await redis.del(lockKey);
        continue;
      }
      if (isImageHeavy && !checkPreFilter(`${subject} ${body}`, subject, messageId, email)) {
        console.log(`[backfill] IMAGE-HEAVY BYPASS msg=${messageId} — ${imageParts.length} image(s), bodyLen=${body.length}`);
      }

      // Mark fingerprint before Claude call to prevent concurrent race
      await redis.set(fpKey, email, 'EX', 30 * 24 * 60 * 60);

      // Fetch image data for vision extraction
      const images = imageParts.length > 0
        ? await fetchEmailImages(fullRes.data.payload, gmail, messageId)
        : [];

      claudeCalls++;
      const extracted = await extractGmailEvents(body, senderName, senderEmail, subject, images);
      eventsExtracted += extracted.length;
      console.log(`[backfill] msg=${messageId} Claude returned ${extracted.length} event(s) images=${images.length} (call ${claudeCalls}/${MAX_EXTRACT})`);

      for (const ev of extracted) {
        if (!ev.title || !ev.date) continue;
        if (await isDuplicateEvent(eventsStore, ev.title, ev.date)) continue;

        const startTime = ev.start_time || '';
        const endTime = ev.end_time || '';
        const conflictNote = await findConflict(eventsStore, ev.date, startTime, endTime);
        const combinedNotes = [ev.notes, conflictNote].filter(Boolean).join('\n') || null;

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
          conflict_note: conflictNote || null,
          source_type: ev.source_type || null,
          recurrence_rule: ev.recurrence || null,
          source: 'gmail',
          gmail_message_id: messageId,
          sender_name: senderName,
          sender_email: senderEmail,
          subject,
          status: 'pending',
          type: ev.is_all_day ? 'other' : 'timed',
          created_at: new Date().toISOString(),
        });
        eventsStored++;
      }
    } catch (err) {
      console.error(`[backfill] ERROR messageId=${messageId}:`, err.message);
      await redis.del(lockKey); // release so next run can retry
    }
  }

  console.log(`[backfill] DONE email=${email} scanned=${scanned} skippedLock=${skippedLock} skippedCategory=${skippedCategory} skippedPreFilter=${skippedPreFilter} skippedDedup=${skippedDedup} claudeCalls=${claudeCalls} eventsExtracted=${eventsExtracted} eventsStored=${eventsStored} truncated=${truncated}`);
  res.json({ ok: true, scanned, skippedLock, skippedCategory, skippedPreFilter, skippedDedup, claudeCalls, eventsExtracted, eventsStored, days, truncated });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Criba running on port ${PORT}`));

export default app;
