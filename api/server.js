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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 20 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SECRET = process.env.SESSION_SECRET || 'criba-secret-key-2026';

const userEvents = new Map();
const userCalendars = new Map();

function getUserEvents(email) {
  if (!userEvents.has(email)) userEvents.set(email, new Map());
  return userEvents.get(email);
}

function getUserCalendars(email) {
  if (!userCalendars.has(email)) userCalendars.set(email, new Map());
  return userCalendars.get(email);
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
    const response = await people.people.searchContacts({
      query: q,
      readMask: 'names,emailAddresses',
      pageSize: 10,
    });
    const contacts = (response.data.results || []).map(r => ({
      name: r.person?.names?.[0]?.displayName || '',
      email: r.person?.emailAddresses?.[0]?.value || '',
    })).filter(c => c.email);
    res.json(contacts);
  } catch (err) {
    console.error('Contacts error:', err.message);
    res.json([]);
  }
});
app.get('/api/events/pending', requireAuth, (req, res) => {
  const events = getUserEvents(req.user.email);
  const pending = [...events.values()].filter(e => e.status === 'pending').sort((a,b) => a.date > b.date ? 1 : -1);
  res.json(pending);
});

app.get('/api/events/recent', requireAuth, (req, res) => {
  const events = getUserEvents(req.user.email);
  const approved = [...events.values()]
    .filter(e => e.status === 'approved')
    .sort((a,b) => b.approved_at > a.approved_at ? 1 : -1)
    .slice(0, 20);
  res.json(approved);
});

app.post('/api/events/approve', requireAuth, async (req, res) => {
  const { id, title, date, time, location, attendees, shareToBharat } = req.body;
  const events = getUserEvents(req.user.email);
  const event = events.get(id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = getOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    const tz = 'America/Los_Angeles';
    let start, end;
    if (!date) return res.status(400).json({ error: 'Date is required' });
    if (time && time.trim() !== '') {
      start = { dateTime: `${date}T${time}:00`, timeZone: tz };
      const [h, m] = time.split(':').map(Number);
      const endHour = h + 1 > 23 ? 23 : h + 1;
      end = { dateTime: `${date}T${String(endHour).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`, timeZone: tz };
    } else {
      start = { date };
      end = { date };
    }
    const eventAttendees = [];
    if (shareToBharat) eventAttendees.push({ email: 'bharatguruprakash@gmail.com' });
    if (attendees && Array.isArray(attendees)) {
      attendees.forEach(a => { if (a.email) eventAttendees.push({ email: a.email }); });
    }
    const calEvent = await calendar.events.insert({
      calendarId: 'primary',
      resource: { summary: title || event.title, location: location || event.location || '', start, end, attendees: eventAttendees, description: 'Added via Criba' }
    });
    event.status = 'approved';
    event.calEventId = calEvent.data.id;
    event.approved_at = new Date().toISOString();
    event.title = title || event.title;
    event.date = date;
    event.time = time || '';
    event.location = location || event.location || '';
    events.set(id, event);
    res.json({ ok: true, calEventId: calEvent.data.id });
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.status(500).json({ error: 'Failed to add to Google Calendar: ' + err.message });
  }
});

app.post('/api/events/undo', requireAuth, async (req, res) => {
  const { id } = req.body;
  const events = getUserEvents(req.user.email);
  const event = events.get(id);
  if (!event || !event.calEventId) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = getOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId: event.calEventId });
    event.status = 'pending';
    event.calEventId = null;
    event.approved_at = null;
    events.set(id, event);
    res.json({ ok: true });
  } catch (err) {
    console.error('Undo error:', err.message);
    res.status(500).json({ error: 'Failed to undo: ' + err.message });
  }
});

app.post('/api/events/update', requireAuth, async (req, res) => {
  const { id, title, date, time, location, attendees } = req.body;
  const events = getUserEvents(req.user.email);
  const event = events.get(id);
  if (!event || !event.calEventId) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = getOAuthClient(req.user);
    const calendar = google.calendar({ version: 'v3', auth });
    const tz = 'America/Los_Angeles';
    let start, end;
    if (time && time.trim() !== '') {
      start = { dateTime: `${date}T${time}:00`, timeZone: tz };
      const [h, m] = time.split(':').map(Number);
      const endHour = h + 1 > 23 ? 23 : h + 1;
      end = { dateTime: `${date}T${String(endHour).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`, timeZone: tz };
    } else {
      start = { date }; end = { date };
    }
    const eventAttendees = (attendees || []).filter(a => a.email).map(a => ({ email: a.email }));
    await calendar.events.patch({
      calendarId: 'primary',
      eventId: event.calEventId,
      resource: { summary: title, location: location || '', start, end, attendees: eventAttendees }
    });
    event.title = title; event.date = date; event.time = time || ''; event.location = location || '';
    events.set(id, event);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update error:', err.message);
    res.status(500).json({ error: 'Failed to update: ' + err.message });
  }
});

app.post('/api/events/dismiss', requireAuth, (req, res) => {
  const events = getUserEvents(req.user.email);
  const event = events.get(req.body.id);
  if (event) { event.status = 'dismissed'; events.set(req.body.id, event); }
  res.json({ ok: true });
});
app.get('/api/calendars', requireAuth, (req, res) => {
  const cals = getUserCalendars(req.user.email);
  res.json([...cals.values()].sort((a,b) => b.created_at > a.created_at ? 1 : -1));
});

app.delete('/api/calendars/:id', requireAuth, (req, res) => {
  const cals = getUserCalendars(req.user.email);
  cals.delete(req.params.id);
  const events = getUserEvents(req.user.email);
  for (const [eid, ev] of events) {
    if (ev.calendar_id === req.params.id && ev.status === 'pending') events.delete(eid);
  }
  res.json({ ok: true });
});

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

    // Group by category for selection
    const categoryMap = new Map();
    for (const ev of futureEvents) {
      const cat = ev.categories?.[0] || 'School Events';
      if (!categoryMap.has(cat)) categoryMap.set(cat, []);
      categoryMap.get(cat).push(ev);
    }
    const categories = [...categoryMap.entries()].map(([name, evs]) => ({ name, count: evs.length }));

    const calId = randomUUID();
    const cals = getUserCalendars(req.user.email);
    cals.set(calId, { id: calId, name, source: 'ical', url, event_count: 0, created_at: new Date().toISOString() });

    const events = getUserEvents(req.user.email);
    for (const ev of futureEvents) {
      const start = new Date(ev.start);
      const dateStr = start.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const isAllDay = ev.datetype === 'date';
      const timeStr = isAllDay ? '' : start.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
      const cat = ev.categories?.[0] || 'School Events';
      const evId = randomUUID();
      events.set(evId, { id: evId, calendar_id: calId, title: ev.summary || 'Untitled Event', date: dateStr, time: timeStr, location: ev.location || '', category: cat, source: name, status: 'draft', created_at: new Date().toISOString() });
    }

    res.json({ ok: true, calendarId: calId, totalEvents: futureEvents.length, categories });
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
          { type: 'text', text: `This is a school calendar PDF. Extract ALL events, dates and holidays. Today is ${new Date().toISOString().split('T')[0]}. Only include events from today onward. Return JSON: {"categories":[{"name":"Category name","count":number,"events":[{"title":"Event name","date":"YYYY-MM-DD","time":null,"location":null}]}]}. Group by category from the document. Return ONLY valid JSON, no markdown.` }
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
    cals.set(calId, { id: calId, name, source: 'pdf', url: req.file.originalname || 'upload.pdf', event_count: 0, created_at: new Date().toISOString() });
    const events = getUserEvents(req.user.email);
    for (const cat of parsed.categories) {
      for (const ev of (cat.events || [])) {
        const evId = randomUUID();
        events.set(evId, { id: evId, calendar_id: calId, title: ev.title, date: ev.date, time: ev.time || '', location: ev.location || '', category: cat.name, source: name, status: 'draft', created_at: new Date().toISOString() });
      }
    }
    try { fs.unlinkSync(pdfPath); } catch {}
    res.json({ ok: true, calendarId: calId, totalEvents, categories: parsed.categories.map(c => ({ name: c.name, count: c.events?.length || 0 })) });
  } catch (err) {
    console.error('PDF error:', err);
    try { fs.unlinkSync(pdfPath); } catch {}
    res.status(500).json({ error: 'Failed to process PDF: ' + err.message });
  }
});

app.post('/api/calendars/confirm-categories', requireAuth, (req, res) => {
  const { calendarId, selectedCategories } = req.body;
  if (!calendarId || !selectedCategories) return res.status(400).json({ error: 'Missing data' });
  const events = getUserEvents(req.user.email);
  let addedCount = 0;
  for (const [, ev] of events) {
    if (ev.calendar_id === calendarId && ev.status === 'draft') {
      if (selectedCategories.includes(ev.category)) { ev.status = 'pending'; addedCount++; }
      else { ev.status = 'rejected'; }
    }
  }
  const cals = getUserCalendars(req.user.email);
  const cal = cals.get(calendarId);
  if (cal) { cal.event_count = addedCount; cals.set(calendarId, cal); }
  res.json({ ok: true, addedCount });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Criba running on port ${PORT}`));

export default app;
