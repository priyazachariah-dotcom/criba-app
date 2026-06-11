import express from 'express';
import session from 'express-session';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import ical from 'node-ical';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 20 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const store = {
  users: new Map(),
  usersByEmail: new Map(),
  calendars: new Map(),
  events: new Map(),
};

const db = {
  getUser: (id) => store.users.get(id),
  getUserByEmail: (email) => { const id = store.usersByEmail.get(email); return id ? store.users.get(id) : null; },
  saveUser: (user) => { store.users.set(user.id, user); store.usersByEmail.set(user.email, user.id); },
  getCalendars: (userId) => [...store.calendars.values()].filter(c => c.user_id === userId).sort((a,b) => b.created_at > a.created_at ? 1 : -1),
  saveCalendar: (cal) => store.calendars.set(cal.id, cal),
  deleteCalendar: (id) => store.calendars.delete(id),
  getPendingEvents: (userId) => [...store.events.values()].filter(e => e.user_id === userId && e.status === 'pending').sort((a,b) => a.date > b.date ? 1 : -1),
  saveEvent: (ev) => store.events.set(ev.id, ev),
  updateEventStatus: (id, status) => { const ev = store.events.get(id); if (ev) { ev.status = status; store.events.set(id, ev); } },
  getEventsByCalendar: (calId, userId, status) => [...store.events.values()].filter(e => e.calendar_id === calId && e.user_id === userId && (!status || e.status === status)),
  updateCalendarCount: (calId, count) => { const cal = store.calendars.get(calId); if (cal) { cal.event_count = count; store.calendars.set(calId, cal); } },
};

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
app.use(session({
  secret: process.env.SESSION_SECRET || 'criba-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '../public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function getOAuthClient(user) {
  const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  client.setCredentials({ access_token: user.access_token, refresh_token: user.refresh_token });
  return client;
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
    let user = db.getUserByEmail(data.email);
    if (!user) {
      user = { id: randomUUID(), email: data.email, name: data.name, access_token: tokens.access_token, refresh_token: tokens.refresh_token || '' };
    } else {
      user.access_token = tokens.access_token;
      if (tokens.refresh_token) user.refresh_token = tokens.refresh_token;
      user.name = data.name;
    }
    db.saveUser(user);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not found' });
  res.json({ id: user.id, email: user.email, name: user.name });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/contacts/search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  const user = db.getUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not found' });
  try {
    const auth = getOAuthClient(user);
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
    console.error('Contacts error:', err);
    res.json([]);
  }
});

app.get('/api/events/pending', requireAuth, (req, res) => {
  res.json(db.getPendingEvents(req.session.userId));
});

app.post('/api/events/approve', requireAuth, async (req, res) => {
  const { id, title, date, time, location, attendees, shareToBharat } = req.body;
  const user = db.getUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not found' });
  const event = [...store.events.values()].find(e => e.id === id && e.user_id === user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  try {
    const auth = getOAuthClient(user);
    const calendar = google.calendar({ version: 'v3', auth });
    const tz = 'America/Los_Angeles';
    let start, end;
    if (!date) return res.status(400).json({ error: 'Date is required' });
    if (time && time !== '') {
      start = { dateTime: `${date}T${time}:00`, timeZone: tz };
      const [h, m] = time.split(':').map(Number);
      const endH = String(h + 1).padStart(2, '0');
      end = { dateTime: `${date}T${endH}:${String(m).padStart(2,'0')}:00`, timeZone: tz };
    } else {
      start = { date }; end = { date };
    }
    const eventAttendees = [];
    if (shareToBharat) eventAttendees.push({ email: 'bharatguruprakash@gmail.com' });
    if (attendees && Array.isArray(attendees)) {
      attendees.forEach(a => { if (a.email) eventAttendees.push({ email: a.email }); });
    }
    await calendar.events.insert({
      calendarId: 'primary',
      resource: { summary: title || event.title, location: location || event.location || '', start, end, attendees: eventAttendees, description: 'Added via Criba' }
    });
    db.updateEventStatus(id, 'approved');
    res.json({ ok: true });
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.status(500).json({ error: 'Failed to add to Google Calendar: ' + err.message });
  }
});

app.post('/api/events/dismiss', requireAuth, (req, res) => {
  db.updateEventStatus(req.body.id, 'dismissed');
  res.json({ ok: true });
});
app.get('/api/calendars', requireAuth, (req, res) => {
  res.json(db.getCalendars(req.session.userId));
});

app.delete('/api/calendars/:id', requireAuth, (req, res) => {
  db.deleteCalendar(req.params.id);
  res.json({ ok: true });
});

app.post('/api/calendars/add-ical', requireAuth, async (req, res) => {
  const { name, person, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL are required' });
  try {
    const events = await ical.async.fromURL(url);
    const today = new Date(); today.setHours(0,0,0,0);
    const endOfYear = new Date('2027-08-31');
    const futureEvents = Object.values(events).filter(ev => {
      if (ev.type !== 'VEVENT') return false;
      const start = ev.start ? new Date(ev.start) : null;
      return start && start >= today && start <= endOfYear;
    });
    if (futureEvents.length === 0) return res.status(400).json({ error: 'No upcoming events found in this calendar' });
    const calId = randomUUID();
    db.saveCalendar({ id: calId, user_id: req.session.userId, name, person, source: 'ical', url, event_count: futureEvents.length, created_at: new Date().toISOString() });
    for (const ev of futureEvents) {
      const start = new Date(ev.start);
      const dateStr = start.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const isAllDay = ev.datetype === 'date' || !ev.start?.toTimeString;
      const timeStr = isAllDay ? '' : start.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
      db.saveEvent({ id: randomUUID(), user_id: req.session.userId, calendar_id: calId, title: ev.summary || 'Untitled Event', date: dateStr, time: timeStr, location: ev.location || '', person, category: 'School', source: name, status: 'pending', created_at: new Date().toISOString() });
    }
    res.json({ ok: true, eventCount: futureEvents.length, calendarId: calId });
  } catch (err) {
    console.error('iCal error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar. Check the URL and try again.' });
  }
});

app.post('/api/calendars/add-pdf', requireAuth, upload.single('pdf'), async (req, res) => {
  const { name, person } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  if (!name) return res.status(400).json({ error: 'Calendar name is required' });
  const pdfPath = req.file.path;
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfBase64 = pdfBuffer.toString('base64');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `This is a school calendar PDF. Extract ALL events, dates and holidays. Today is ${new Date().toISOString().split('T')[0]}. Only include events from today onward. Return JSON: {"categories":[{"name":"Category name","count":number,"events":[{"title":"Event name","date":"YYYY-MM-DD","time":null,"location":null}]}]}. Group by category from the document. Return ONLY valid JSON.` }
        ]
      }]
    });
    const text = response.content[0].text;
    let parsed;
    try { parsed = JSON.parse(text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()); }
    catch { return res.status(500).json({ error: 'AI could not parse this PDF.' }); }
    if (!parsed.categories || !parsed.categories.length) return res.status(400).json({ error: 'No events found in this PDF' });
    const calId = randomUUID();
    const totalEvents = parsed.categories.reduce((sum, c) => sum + (c.events?.length || 0), 0);
    db.saveCalendar({ id: calId, user_id: req.session.userId, name, person, source: 'pdf', url: req.file.originalname || 'upload.pdf', event_count: 0, created_at: new Date().toISOString() });
    for (const cat of parsed.categories) {
      for (const ev of (cat.events || [])) {
        db.saveEvent({ id: randomUUID(), user_id: req.session.userId, calendar_id: calId, title: ev.title, date: ev.date, time: ev.time || '', location: ev.location || '', person, category: cat.name, source: name, status: 'draft', created_at: new Date().toISOString() });
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
  const drafts = db.getEventsByCalendar(calendarId, req.session.userId, 'draft');
  let addedCount = 0;
  for (const ev of drafts) {
    if (selectedCategories.includes(ev.category)) { db.updateEventStatus(ev.id, 'pending'); addedCount++; }
    else { db.updateEventStatus(ev.id, 'rejected'); }
  }
  db.updateCalendarCount(calendarId, addedCount);
  res.json({ ok: true, addedCount });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Criba running on port ${PORT}`));

export default app;
