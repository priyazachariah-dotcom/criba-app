# Criba — Claude Code Instructions

## Project overview
Criba is an AI-powered approval layer that sits between a user's communication sources and Google Calendar. It extracts calendar-worthy events from PDFs, iCal feeds, Gmail, iMessage, and WhatsApp, surfaces them in a review queue, and writes approved events to Google Calendar. Nothing reaches Google Calendar without user approval.

## Stack
- Hosting: Vercel (serverless)
- Backend: Node.js / Express
- Auth: Google OAuth 2.0 (cookie-based HMAC-signed sessions)
- AI: Anthropic API (Claude) — PDF extraction and event detection
- Calendar: Google Calendar API, node-ical
- Contacts: Google People API
- Storage: Vercel KV (migration in progress — replacing in-memory Map())
- Repo: github.com/priyazachariah-dotcom/criba-app
- Live app: criba.app

## How Gmail scanning works
Criba does not poll Gmail. On sign-in it registers a Gmail **watch**, and Google
pushes every new message to `/api/gmail/webhook`, which extracts and writes
immediately. The nightly cron (`/api/cron/gmail`, 02:00 UTC) only renews
expiring watches and sends the evening summary.

Because the watch only delivers mail that arrives *after* it is registered, a
new account would otherwise start with an empty queue. So on first sign-in Criba
runs one automatic **24-hour scan** (`needsOnboardingScan` on
`/api/user/status`, cleared by `POST /api/user/onboarded`).

**Criba starts working from the moment you sign in.** Email older than 24 hours
at sign-up is out of scope by design — 24h reliably finishes inside the 60s
function budget, so a new user's first experience can never be a timeout. The
manual "Scan now" button remains for backfilling after an outage; it is not
needed in normal use.

## Git workflow
- Commit after completing each logical fix or feature
- Push to the main branch automatically — do not wait for approval
- Use clear commit messages describing what changed (e.g. "fix: replace in-memory Map with Vercel KV storage")
- Never force push

## Code principles
- Do not change working features while fixing bugs
- Preserve all existing function signatures when refactoring storage
- Flag anything that doesn't translate cleanly before changing it
- Test the fix end-to-end before committing

## Current priorities (in order)
1. Fix persistent storage — replace in-memory Map() with Vercel KV
2. Build "Add all events?" gate before category screen
3. Build group-level approve on category screen
4. Fix PDF extraction timeout
5. Verify session/cookie handling
