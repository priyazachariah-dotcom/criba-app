# Criba — known bugs

Live document. Updated as bugs are found, fixed, or disproved.

Two rules, both learned the hard way:

1. **Mark what was verified and what was assumed.** Several entries here were
   once "likely mis-parse" and turned out to be Criba reading the email
   correctly. A suspicion recorded as a fact wastes someone's afternoon.
2. **Don't delete disproved entries — move them to Not bugs.** The reason
   something *isn't* broken is worth as much as the reason something is, and
   without it the same false alarm gets raised again in a month.

Last reviewed: 2026-09-03

---

## Blocks trust — a user would notice and lose confidence

### 14. A dismissal does not survive the next email
**Verified against live data 2026-09-03. Open — nothing built.**

There is no record of what the user *decided*. Four stores record what Criba
*did* — `status`, `calEventId`, `gcalWritten:${email}`, and the `processedMsg:`
fingerprints — and none of them survives contact with a second email about the
same event.

The root cause, stated plainly: **rows are created per extraction, not per
event.** `randomUUID()` mints a fresh row for every extraction, so a dismissal
attaches to a disposable artifact of one email. The next email mints another row
and never consults the first. The decision is orphaned, not overwritten.
`status` — a mutable pipeline position — was overloaded to carry durable
decisions because there was nowhere else to put them, which is how ten dismissal
paths ended up writing four different statuses (`dismissed`, `cancelled`,
`rejected`, plus `skipped_dates`, which is invisible to dedup entirely).

Measured with `/api/debug/decisions` (read-only, added in `cddee0e`) against 548
stored events: **243 distinct refusals derived, and 12 events sat on the
calendar that had previously been refused.** Among them AYSO Soccer Practice on
both Fridays and Sundays, both Onam events, and HIVE Summer Camp Week 9 — stored
twice under two titles, refused under both.

Those 12 are **explicitly not to be reconciled**. Some were accidental
dismissals, the user is happy with them on the calendar, and three of them
(Building Belonging Week, WPG Dues, Ruby Bridges Walk) are still ahead. They are
recorded here as the measurement of the gap, not as a work item.

Scoping, decided but not implemented: **date-scoped** — "no to this event on
this date" — not title-scoped. Date-scoped fails safely. Worst case something
resurfaces and gets dismissed again; title-scoped would risk silently
suppressing a genuinely different future event that happened to share wording,
which is the exact silent-drop failure #5 was about.

Known weakness of the date-scoped key, measured: **43 same-date pairs** would
fail to match if the wording changed between emails. That failure surfaces the
event rather than hiding it, which is the right direction to fail in.

This is the one open item that would stop a hand-off to someone else. A
duplicate is annoying; "I said no and it did it anyway" is the app overruling
the user.

### 15. `held_reason` is written once and never re-evaluated
**Verified 2026-09-03.** `held_reason` is stamped at extraction time and nothing
ever revisits it. A review card kept showing "you asked Criba to stop showing
frosh events" in red after `tier:frosh` had been auto-overridden by Aarav's
confirmed `football/frosh` activity — so the gate was *not* holding the event
back, but the card still said it was.

The gate itself was correct: `familyHasPositive` overrides the rule in both
`eventRelevance` and `/api/exclusions`. Only the stored sentence was stale.
Cosmetic in effect, corrosive in practice — it is the sentence a user reads when
deciding whether Criba is trustworthy, and it was describing a rule that had
stopped applying.

### 5. The 81 draft events silently suppress real school email
**Verified. FIXED 2026-09-02 (`0a17791`), confirmed against live data.**

A stored event may now block an incoming one only if `calEventId` is set (it is
really on the calendar) or its status is one the review queue renders (it is
awaiting a decision). Dead records — `draft`, `cancelled`, `dismissed`, and
`added`/`reviewed` rows whose write never landed — are no longer consulted.
Blocking rows dropped from 305 to 189; 116 phantoms neutralised.

Confirmed with `/api/debug/dedup` (added in `304e987`) on four events a draft
would have swallowed — Mass of the Holy Spirit, Week 7 League Game Day, Student
Testing Day PSAT, Team Practice Sep 4. All four were skipped before, all four
pass now.

Fixed the inverse too: a `dismissed` event that *did* reach the calendar was
previously excluded from the check, so re-extraction wrote a real duplicate.
Six rows were in that state.

**Still open, and not addressed by this fix:** `gcalWritten:${email}`
(`api/server.js:1033`) is a separate Redis set holding a `date|title` signature
for every event Criba successfully auto-wrote, TTL 400 days. The 30 cancelled
events left signatures behind. If the school resends one, `autoWriteToCalendar`
returns `GUARD-SKIP` and the calendar write is refused — though unlike the dedup
path, the event is still stored and still appears in the review queue flagged as
a duplicate, so it is visible rather than silent. There is no endpoint that
reads or clears this set; it is referenced in exactly one place in the codebase.

The original report follows.

---

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

### 4. A single newsletter can produce many events
**Verified.**

One Samaritan House mailing yielded three events (registration, tour,
volunteering) written within 2.6 seconds. Arguably correct — the email really
does describe three things — but one mass mailing can triple the review queue.

---

## Data integrity — mostly invisible, mostly Priya's account

### 6. `draft` status has no approval path
**FIXED 2026-09-03 (`1efad57`).**

`draft` was in neither `VISIBLE_IN_REVIEW` nor `VISIBLE_IN_EDIT`, so an iCal or
PDF import whose calendar write failed was stranded — unapprovable, uneditable,
undiscardable.

It was not the one-line filter change this entry claimed. Two halves were wrong:
the server's pending filter never returned drafts, *and* the client's `isDraft`
test was `status === 'pending'` only, so a draft that did arrive rendered as
"On your calendar" with a Delete button for a Google event that never existed.

The "would surface all 81 at once" objection was also wrong in shape. Measured
via the new `/api/debug/drafts`: only **1** of the 81 is future-dated on a
calendar that still exists (Team Practice, 2026-09-04 — bug #9's event). 79
belong to deleted calendars. The fix surfaces live-calendar drafts only; the
dead ones remain #7's problem.

`/api/events/approve` needed no change — a draft has no `calEventId`, so it
takes the insert branch, where `findExistingOnAnyCalendar` patches an existing
copy rather than duplicating it.

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
**Closed 2026-09-03 — not an outstanding gap.** Of the 81 drafts this was the
only event genuinely not on the calendar, and it was blocked by #6 (`draft` has
no approval path). The event is on the calendar now, added outside Criba. The
underlying #6 remains open; only this instance is closed.

---

### 16. A reply restating an event produced a second copy
**FIXED 2026-09-03 (`0a80f01`). Forward-only; not yet observed in the wild.**

A reply is where title matching fails hardest. The school sends "Frosh Football
— Parents Pregame Gathering", a parent replies "reminder, pregame is Friday at
6", and Claude extracts a title with almost no words in common.
`titlesLooselyMatch` rejects the pair, dedup passes, and the gathering lands
twice.

Stripping quoted history (`0b878c4`, 2026-08-31) does not cover this: the reply
restates the event in its own *new* words, which is exactly the content that fix
deliberately keeps.

Gmail returns `threadId` on every message and Criba was discarding it — it
appeared nowhere in the codebase. It is now stored as `thread_id` on every
event and consulted by dedup, in the webhook and the backfill alike so a manual
scan cannot re-create what the webhook merged.

The rule is deliberately narrow: same thread **and** same date **and** same
time. A thread announcing practice at 4 and team dinner at 7 on one day keeps
both. The thread clause runs behind `blocksDuplicate` like every other clause,
so a dead record can no more suppress mail via its thread than via its title —
#5 is not reopened through a side door.

**Unverified:** `thread_id` is null on all 548 pre-existing rows, so there is no
before/after against real data the way #5 had. It can only act on mail arriving
after the deploy, and no real reply has been through it yet. Proving it needs a
live test.

Also in this commit: `DEDUP SKIP` now writes a trace entry. This is the path
that ate real school mail, and a drop that exists only in a Vercel log line is a
drop nobody can audit.

### 13. `titlesLooselyMatch` matches far more widely than expected
**Verified while testing #5.** "Week 7 – League Game Day" fuzzy-matches 23
stored rows spanning January to February — every "Week N" variant matches every
other. No harm results, because the date check then rejects them, but that means
dedup safety rests on dates far more than on titles. Worth knowing before anyone
loosens the date comparison.

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

- **The newsletter gate had never been observed firing** (was #3, "an
  unverified gate is indistinguishable from no gate"). Disproved 2026-09-03 by a
  screenshot of a live review card: "Parents Pregame Gathering at Perry's in
  Larkspur", held, surfaced in Review, with the reason attached. The gate fires,
  it explains itself, and it holds rather than discards — exactly as designed.
  This was the highest pre-beta risk on the list. (The *sentence* on that card
  was stale, which is #15 — a different bug in a different place.)
- **`/api/exclusions` appeared to lose rules.** Two reads minutes apart returned
  6 rules then 9, and the 6 were missing precisely the three newest — an ordered
  subset, which reads like truncation, not random loss. It was neither.
  `exclusions:${email}` is a single Redis hash read with one `hgetall`: atomic,
  no pagination, no TTL, no cache, no in-memory fallback. There is no mechanism
  that could return a subset. The timestamps settle it — `tier:jv`, `tier:varsity`
  and `sender:inhersight.com` were created at 02:18:33, 02:18:34 and 02:21:36,
  between the two reads, by the user answering "stop showing these?" prompts.
  The response is sorted by `created_at`, which is exactly why three new rows
  appearing at the end looked like a clean truncation of the front. Filed as
  unexplained loss before the timestamps were checked; that check should have
  come first.

Both were raised because something *looked* odd, without checking it against
reality. That is the failure mode this file exists to resist.
