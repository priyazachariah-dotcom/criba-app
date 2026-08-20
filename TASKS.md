# Criba — running task list

Kept by hand. Newest thinking at the top of each section; check things off
rather than deleting them, so the history of what was decided stays readable.

---

## This week — beta rollout + setup flow

The three items below are really one feature. They all answer the same
question: *where does this event go, and whose is it?* Criba answers that
once, globally, today. It needs to answer it per-event.

- [ ] **Member model first.** Children as first-class records, each with a
      colour. Everything else depends on this, so building setup before the
      model means rebuilding setup.
      - Open question: a recurring series approved once must stay one child's
        colour across all ~30 occurrences, but Google Calendar colours are
        per-event, not per-series. Decide whether colour is applied at series
        creation or per instance — it changes the data model.
- [ ] **New-user setup flow.** Collects members and up to three destination
      calendars (self / spouse / family) so a user can write to all three.
- [ ] **Colour on write**, with a per-event override on the approval card for
      when the default guess is wrong.

## Blocking more beta users

- [ ] **Publish the Google Cloud app + OAuth verification.** Two hard limits
      while the app sits in Testing: 100 test users total, and refresh tokens
      expire every 7 days so each beta user must re-authorize weekly.
      Verification takes weeks, not days — the clock is worth starting well
      before the pain arrives.
- [x] Add jishangiras@gmail.com as an OAuth test user, send him the link.

## Cleanup owed from recent fixes

The fixes below shipped, but each only prevents *new* bad data. Existing rows
predate them and need clearing by hand.

- [ ] Delete the 4 duplicate "Vincent Mason" drafts.
- [ ] Re-upload the school PDF — 51 drafts predate the category-collapse fix.
- [ ] Verify the edit-button / duplicate fix end to end. The Sutter
      appointment is the test case.

## Domains and marketing

- [ ] **App onto `app.criba.app`**, keeping `criba.app` as the marketing site.
      A visitor landing straight on a Google sign-in wall converts badly.
      Requires changing `GOOGLE_REDIRECT_URI` *and* the authorized redirect
      URI in Google Cloud Console — both, or sign-in breaks.
- [ ] **Rewrite the landing copy** around what actually exists. Current copy
      promises WhatsApp, iMessage and a daily text; `api/server.js` has zero
      references to any of them. Honest and sharper version: anything with a
      date goes in, one calendar comes out, nothing lands without approval.
      Source lives in a separate Vercel project, not this repo.

## Carried over

- [ ] Re-enter Bharat's address in "Share with partner".
- [ ] Test onboarding end to end on a fresh Google account.
- [ ] PWA manifest.
- [ ] Fix the misleading "Scan timed out" message.
- [ ] The "CHANGE" group for uploads (reschedules, as distinct from adds and
      removals). Deferred by agreement.

## Someday / unlikely

- [ ] Publish as a real app (native or store-distributed). Noted as very
      unlikely, but if it ever happens the OAuth verification above is a
      prerequisite, not a parallel track.
