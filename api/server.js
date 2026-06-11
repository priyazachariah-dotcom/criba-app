import express from 'express';
import session from 'express-session';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import ical from 'node-ical';
import multer from 'multer';
import { pdfToPng } from 'pdf-to-png-converter';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: '/tmp/uploads/' });
const db = new Database('criba.db');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// DB setup
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    access_token TEXT,
    refresh_token TEXT
  );
  CREATE TABLE IF NOT EXISTS calendars (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT,
    person TEXT,
    source TEXT,
    url TEXT,
    event_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pending_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    calendar_id TEXT,
    title TEXT,
    date TEXT,
    time TEXT,
    location TEXT,
    person TEXT,
    category TEXT,
    source TEXT,
    raw_data TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Google OAuth config
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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'criba-secret-' + randomUUID(),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function getOAuthClient(user) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({
    access_token: user.access_token,
    refresh_token: user.refresh_token,
  });
  return client;
}

// ── AUTH ROUTES ──

app.get('/api/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(data.email);
    if (!user) {
      const id = randomUUID();
      db.prepare('INSERT INTO users (id, email, name, access_token, refresh_token) VALUES (?, ?, ?, ?, ?)')
        .run(id, data.email, data.name, tokens.access_token, tokens.refresh_token || '');
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else {
      db.prepare('UPDATE users SET access_token = ?, refresh_token = COALESCE(?, refresh_token), name = ? WHERE email = ?')
        .run(tokens.access_token, tokens.refresh_token, data.name, data.email);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(data.email);
    }
    
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not found' });
  res.json(user);
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── EVENTS ROUTES ──

app.get('/api/events/pending', requireAuth, (req, res) => {
  const events = db.prepare("SELECT * FROM pending_events WHERE user_id = ? AND status = 'pending' ORDER BY date ASC, created_at ASC").all(req.session.userId);
  res.json(events);
});

app.post('/api/events/approve', requireAuth, async (req, res) => {
  const { id, title, date, time, location, person, shareToBharat } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not found' });

  const event = db.prepare('SELECT * FROM pending_events WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  try {
    const auth = getOAuthClient(user);
    const calendar = google.calendar({ version: 'v3', auth });

    // Build datetime
    let start, end;
    if (date) {
      if (time) {
        const dt = `${date}T${time}:00`;
        const tz = 'America/Los_Angeles';
        start = { dateTime: dt, timeZone: tz };
        end = { dateTime: new Date(new Date(dt).getTime() + 60 * 60 * 1000).toISOString().replace('Z', ''), timeZone: tz };
      } else {
        start = { date };
        end = { date };
      }
    } else {
      return res.status(400).json({ error: 'Date is required' });
    }

    const attendees = shareToBharat ? [{ email: 'bharatguruprakash@gmail.com' }] : [];

    await calendar.events.insert({
      calendarId: 'primary',
      resource: {
        summary: title || event.title,
        location: location || event.location || '',
        start,
        end,
        attendees,
        description: `Added via Criba · For: ${person || event.person}`,
      }
    });

    db.prepare("UPDATE pending_events SET status = 'approved' WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Calendar error:', err);
    res.status(500).json({ error: 'Failed to add to Google Calendar' });
  }
});

app.post('/api/events/dismiss', requireAuth, (req, res) => {
  const { id } = req.body;
  db.prepare("UPDATE pending_events SET status = 'dismissed' WHERE id = ? AND user_id = ?").run(id, req.session.userId);
  res.json({ ok: true });
});

// ── CALENDARS ROUTES ──

app.get('/api/calendars', requireAuth, (req, res) => {
  const cals = db.prepare('SELECT * FROM calendars WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  res.json(cals);
});

app.delete('/api/calendars/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM calendars WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
  db.prepare("DELETE FROM pending_events WHERE calendar_id = ? AND status = 'pending'").run(req.params.id);
  res.json({ ok: true });
});

// iCal subscription
app.post('/api/calendars/add-ical', requireAuth, async (req, res) => {
  const { name, person, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL are required' });

  try {
    const events = await ical.async.fromURL(url);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfYear = new Date('2026-12-31');

    // Filter to future events only
    const futureEvents = Object.values(events).filter(ev => {
      if (ev.type !== 'VEVENT') return false;
      const start = ev.start ? new Date(ev.start) : null;
      if (!start) return false;
      return start >= today && start <= endOfYear;
    });

    if (futureEvents.length === 0) {
      return res.status(400).json({ error: 'No upcoming events found in this calendar' });
    }

    // Save calendar
    const calId = randomUUID();
    db.prepare('INSERT INTO calendars (id, user_id, name, person, source, url, event_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(calId, req.session.userId, name, person, 'ical', url, futureEvents.length);

    // Add events to pending queue
    const insertEvent = db.prepare('INSERT INTO pending_events (id, user_id, calendar_id, title, date, time, location, person, category, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    
    for (const ev of futureEvents) {
      const start = new Date(ev.start);
      const dateStr = start.toISOString().split('T')[0];
      const timeStr = ev.start && !ev.allDay ? 
        start.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' }) : '';
      
      insertEvent.run(
        randomUUID(),
        req.session.userId,
        calId,
        ev.summary || 'Untitled Event',
        dateStr,
        timeStr,
        ev.location || '',
        person,
        'School',
        name,
        'pending'
      );
    }

    res.json({ ok: true, eventCount: futureEvents.length, calendarId: calId });
  } catch (err) {
    console.error('iCal error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar. Check the URL and try again.' });
  }
});

// PDF upload
app.post('/api/calendars/add-pdf', requireAuth, upload.single('pdf'), async (req, res) => {
  const { name, person } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  if (!name) return res.status(400).json({ error: 'Calendar name is required' });

  const pdfPath = req.file.path;

  try {
    // Convert PDF pages to images
    const pages = await pdfToPng(pdfPath, {
      disableFontFace: true,
      useSystemFonts: true,
      viewportScale: 2.0,
      outputFileMask: 'page',
    });

    if (!pages || pages.length === 0) {
      return res.status(400).json({ error: 'Could not read PDF pages' });
    }

    // Send pages to Claude vision
    const imageContents = pages.slice(0, 5).map(page => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: page.content.toString('base64'),
      }
    }));

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          ...imageContents,
          {
            type: 'text',
            text: `This is a school calendar PDF. Extract ALL events and dates you can see.
            
Today is ${new Date().toISOString().split('T')[0]}. Only include events from today through June 30, 2026.

Return a JSON object with this structure:
{
  "categories": [
    {
      "name": "Category name (e.g. Holidays, School Days, Sports, Minimum Days)",
      "count": number,
      "events": [
        {
          "title": "Event name",
          "date": "YYYY-MM-DD",
          "time": "HH:MM or null",
          "location": "location or null"
        }
      ]
    }
  ]
}

Group events by category. Categories should come from what you actually see in the calendar, not a preset list.
Return ONLY valid JSON, no explanation.`
          }
        ]
      }]
    });

    const text = response.content[0].text;
    let parsed;
    try {
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'AI could not parse this PDF. Please try a different file.' });
    }

    if (!parsed.categories || parsed.categories.length === 0) {
      return res.status(400).json({ error: 'No events found in this PDF' });
    }

    // Save calendar temporarily (no events yet — wait for category selection)
    const calId = randomUUID();
    const totalEvents = parsed.categories.reduce((sum, c) => sum + c.events.length, 0);
    
    db.prepare('INSERT INTO calendars (id, user_id, name, person, source, url, event_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(calId, req.session.userId, name, person, 'pdf', req.file.originalname || 'upload.pdf', 0);

    // Store extracted events temporarily in DB as 'draft'
    const insertEvent = db.prepare('INSERT INTO pending_events (id, user_id, calendar_id, title, date, time, location, person, category, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    
    for (const cat of parsed.categories) {
      for (const ev of cat.events) {
        insertEvent.run(
          randomUUID(),
          req.session.userId,
          calId,
          ev.title,
          ev.date,
          ev.time || '',
          ev.location || '',
          person,
          cat.name,
          name,
          'draft'
        );
      }
    }

    // Clean up temp file
    fs.unlinkSync(pdfPath);

    res.json({
      ok: true,
      calendarId: calId,
      totalEvents,
      categories: parsed.categories.map(c => ({ name: c.name, count: c.events.length }))
    });

  } catch (err) {
    console.error('PDF error:', err);
    try { fs.unlinkSync(pdfPath); } catch {}
    res.status(500).json({ error: 'Failed to process PDF: ' + err.message });
  }
});

// Confirm category selection
app.post('/api/calendars/confirm-categories', requireAuth, (req, res) => {
  const { calendarId, selectedCategories } = req.body;
  if (!calendarId || !selectedCategories) return res.status(400).json({ error: 'Missing data' });

  // Activate selected draft events
  const placeholders = selectedCategories.map(() => '?').join(',');
  db.prepare(`UPDATE pending_events SET status = 'pending' WHERE calendar_id = ? AND user_id = ? AND category IN (${placeholders}) AND status = 'draft'`)
    .run(calendarId, req.session.userId, ...selectedCategories);

  // Delete unselected drafts
  db.prepare(`DELETE FROM pending_events WHERE calendar_id = ? AND user_id = ? AND status = 'draft'`).run(calendarId, req.session.userId);

  const addedCount = db.prepare("SELECT COUNT(*) as count FROM pending_events WHERE calendar_id = ? AND status = 'pending'").get(calendarId).count;
  
  // Update calendar event count
  db.prepare('UPDATE calendars SET event_count = ? WHERE id = ?').run(addedCount, calendarId);

  res.json({ ok: true, addedCount });
});

// Serve app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Criba running on port ${PORT}`));
