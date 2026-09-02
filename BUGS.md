# Criba — known bugs

Live document. Updated as bugs are found, fixed, or disproved.

Two rules, both learned the hard way:

1. **Mark what was verified and what was assumed.** Several entries here were
   once "likely mis-parse" and turned out to be Criba reading the email
   correctly. A suspicion recorded as a fact wastes someone's afternoon.
2. **Don't delete disproved entries — move them to Not bugs.** The reason
   something *isn't* broken is worth as much as the reason something is, and
   without it the same false alarm gets raised again in a month.

Last reviewed: 2026-09-02

---

## Blocks trust — a user would notice and lose confidence

### 5. The 81 draft events silently suppress real school email
**Verified. The most severe open bug.**

297 events sit in neither feed — 216 `dismissed` + 81 `draft`. They cannot be
seen, approved, or cleared from any screen. That much is cosmetic. The
suppression is not.

`isDuplicateEventIn` opens with `if (ev.status === 'dismissed') return false;`,
so the 216 dismissed rows are inert — correctly excluded. **`draft` is not
excluded.** The Gmail webhook checks every extracted event against every stored
event (`isDuplicateEvent`, `api/server.js:5567`) and on a match does:

```js
console.log(`DEDUP SKIP event "${ev.title}" already exists`);
continue;
```

Dropped. Not held, not queued, not visible anywhere in the UI.

Those 81 drafts are a shadow copy of the St. Ignatius calendar. So an SI email
about an event that exists as a draft is silently discarded — a school
newsletter event missed, caused by debris from a period when nothing worked.
This is the exact failure the product cannot have.

Unknown: how many real emails this has already eaten. Checkable by grepping
Vercel logs for `DEDUP SKIP`.

Fix is not "reconcile the 297" — that was explicitly declined, and the dismissed
ones genuinely do not matter. It is narrower: stop `draft` counting as an
existing event for dedupe purposes, the same way `dismissed` already doesn't.

### 1. Deleting an email does not undo what Criba did with it
**Verified. Filed, not being fixed.**

The Gmail webhook fires on delivery. Measured on a real message: email landed
18:00:32, three events were on the calendar by 18:01:16 — 41 seconds. Deleting
the email afterwards leaves all three in place.

Every user's mental model is "I threw that away, so it doesn't count." That is
false, and no amount of relevance filtering fixes it: a gate decides what to do
with mail Criba *reads*, and it cannot know the user was about to bin it.

Considered and rejected for now:
- *Delay the webhook 10–15 min.* Vercel Hobby allows 2 crons at once a day, so
  a short-interval cron needs Pro ($20/mo). A self-nudging queue avoids that
  (~30–40 lines, reusing the existing `gmailBacklog:` key and the 02:00 drain),
  but the last email before a quiet stretch waits for the next one to arrive.
  Rejected mainly because it only helps if users delete *fast*, and we have no
  evidence they do — the one measured case has an unknown deletion time.
- *Listen for the deletion and pull the events back off the calendar.* Correct
  behaviour, meaningfully more code, more ways to be wrong. Revisit if beta
  testers report this.

Repro: send yourself a newsletter, wait a minute, delete it, check the calendar.

### 2. `audience: 'open'` is not gated
**Verified in code; effect on real mail unconfirmed.**

`eventRelevance` (`api/server.js`) holds back `third_party` and `opportunity`.
`open` — a public event anyone may attend — writes through.

This is a deliberate trade, made on the instruction to err toward adding: a
school event saying "all families welcome" would land in the same bucket as a
public meetup, and missing a school event is worse than an extra meetup. The
cost is real though: the Tally Berlin / Kuala Lumpur / International Generalist
Day meetups are the likely shape of it.

Prefer fixing this by teaching the extractor to tag newsletter meetups as
`opportunity`, not by widening the gate.

### 3. The newsletter gate has never been observed firing
**Verification gap, not a bug.**

Shipped 2026-09-02 (`9b5723c`) and only affects mail arriving after that. No
`[gmail-process] HELD` line has been seen in production, and — more important —
nobody has confirmed it does *not* fire on a school email.

An unverified gate is indistinguishable from no gate. Before beta: find one
HELD line in the Vercel logs, and one school email that passed.

### 4. A single newsletter can produce many events
**Verified.**

One Samaritan House mailing yielded three events (registration, tour,
volunteering) written within 2.6 seconds. Arguably correct — the email really
does describe three things — but one mass mailing can triple the review queue.

---

## Data integrity — mostly invisible, mostly Priya's account

### 6. `draft` status has no approval path
**Verified.** `draft` is in neither `VISIBLE_IN_REVIEW` nor `VISIBLE_IN_EDIT`.
Anything that reaches that status is stranded. One-line filter change; not done
because it would surface all 81 at once.

### 7. 79 of the 81 drafts belong to deleted calendars
**Verified.** "Aaravs SI calendar", "Arin's Flag football", "Arin's school
calendar" no longer exist, so `/api/calendars/:id/draft-events` cannot reach
them either. Deleting a calendar does not clean up its events.

### 8. The same event stored twice under two titles
**Verified.** Arin's flag football: 9 real games stored as 18 rows, each as both
"Week N Game" and "Week N – League Game Day". Plus 4 exact duplicate pairs in
the drafts (Mass of the Holy Spirit, Holy Thursday, Good Friday, Transition
Liturgy). Title-based dedupe does not catch two different names for one event.

### 9. "Team Practice, Fri Sep 4" is missing with no way to add it
**Verified.** Of the 81 drafts, this is the only event genuinely not on the
calendar — the other 80 are a shadow copy of the SI feed already subscribed to
in Google. Blocked by #6.

---

## Minor

### 10. `CIRCLE_PRESETS` is declared but not enforced
`normalizeCircle` lowercases and trims whatever it is given, so the API would
accept and store `circle: "banana"`. The UI only offers the five presets, so
this is theoretical.

### 11. Circles has no behaviour yet
A grouping label with a UI and nothing reading it — nothing filters, routes, or
gates by circle. By design, but beta testers will find it and ask what it does.
Decide whether it ships visible.

### 12. Possible duplicate "Bharat" on review cards
**Unverified.** A review card showed Bharat both as an attribution chip and as a
checkbox. Plausibly a legitimate "invite by email" control rather than a
duplicate. Needs someone to actually look before it is called a bug.

---

## Not bugs — investigated and disproved

Kept so the same false alarms are not raised twice.

- **Samaritan House events dated Nov 9, 2026.** Flagged as a year-inference
  mis-parse on the belief it was 14 months out. It is roughly ten weeks out;
  the date is ordinary and almost certainly correct. The suspicion was an
  arithmetic error against the wrong year, not a finding.
- **St. Ignatius Back to School Night at 6:55 PM.** Flagged as a mis-parse
  because 6:55 is an unusual start time. It is the actual start time. Criba
  read it correctly.

Both were raised because something *looked* odd, without checking it against
reality. That is the failure mode this file exists to resist.
