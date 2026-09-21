# Decision record

A running, plain-English log of *why* notable changes were made — the context
that a diff alone doesn't capture. Newest first. For live bugs see `BUGS.md`;
for the OAuth launch path see `VERIFICATION.md`; for the calendar-learning
feature in depth see `docs/LEARNING.md`.

---

## 2026-09-21 — Today (daily digest), Surface 2; Review's future deferred

**Why:** A daily digest of what is actually happening today, as one thing to
look at rather than a queue to work through.

**Decision:** Build the in-app view standalone. The push notification (Surface
1) is deferred until this exists and is used.

**One content model, two surfaces.** `GET /api/today` owns the definition and
the view only renders it, so the notification can later summarise the identical
payload. Two implementations of "what is today" would eventually disagree, and
the notification would promise something the screen did not show.

- **Today is the user's today**, resolved through `getUserTimezone`. Criba runs
  in UTC; without this a parent in California sees tomorrow's events from
  mid-afternoon.
- **`financial_reminder` goes in Reminders.** The original spec assigned
  `deadline` and `action_item` to Reminders and `event` to Today, leaving the
  fourth `source_type` with nowhere to go — it would have silently vanished.
  It is in live use (6 items in Pria's queue at time of writing).
- **All-day items sort first**, then chronologically. An all-day item has no
  time to sort by, and burying it last is how a minimum day gets missed.
- Empty sections are omitted; a heading over nothing reads as a failed load.

### Review's retirement: deliberately NOT decided yet

Retiring Review was scoped and **deferred for a week of real use**. The reason is
a ratio: at the time of writing Pria's queue held **67 items, of which 6 were
dated today**. Today surfaces 6; the other 61 include **29 carrying a
`held_reason`** (refusal holds, learned-mute holds, relevance holds) and a
`pending_reschedule`. Those are not "today's plan" — they are pending questions,
and they have no home in a digest by definition. Review also owns the editor,
member/circle pickers and the agenda/month views.

So "retirement" cannot mean deletion, and the three readings — Today as default
landing with Review renamed; Today absorbing Review wholesale; or Today shipping
standalone first — are materially different builds. Designing a home for held
items and reschedules now means designing blind against a mockup that only
covers today.

**Accepted cost, stated plainly:** until that decision, two screens show
overlapping data with different interaction models. That is a known temporary
state, not an oversight. Revisit after a week of Today in use.

## 2026-09-21 — Bulk remove-by-source (extends the Sep 16 decision)

**Why:** The Sep 16 design says learn from what people already do, with no
training step. Real data showed it had a hole. One SF Grind newsletter produced
**19 events in a single batch**; Pria removed 13 of them and `senderStats` for
`thesfgrind.com` stayed **empty**. The sender only stopped because someone
hand-muted the domain -- the manual fallback the design was meant to make
unnecessary.

The cause is structural, not a bug in the tally. `learnFromCalendar` only
considers events that still have a `calEventId`, which is exactly how it tells
*your* deletion in Google Calendar from *Criba's own*. Deleting through Criba's
UI nulls that field. So a deletion made **inside Criba can never be observed by
the watcher, by construction** -- and clearing a 19-event batch by hand is 19
clicks that teach it nothing.

**Decision:** Group the calendar events Criba added by their source, and let a
whole batch go in one action that also records the intent. This is an
**extension, not a reversal**: it is not a new place to go and train Criba, it
is the same "delete the junk" gesture made once instead of nineteen times, on a
tab that already exists.

**Shape:**
- **Grouped by exact From address**, not domain. `newsletters@siprep.org` and a
  teacher at the same domain must stay separable, or stopping a newsletter
  silences a real person. A domain roll-up appears only where a domain sends
  from several addresses (Amazon), and the per-address groups remain alongside.
- **Upcoming events only.** Past events are a record of what happened; "stop
  sending me these" is not a request to rewrite history. 14 of the 19 SF Grind
  events were already past. The confirmation says so.
- **The mute is written explicitly** (`source: 'explicit'`), not inferred.
  `reconcileLearnedMutes` rebuilds the mute set from the deletion tally, so an
  explicit mute -- which has no tally behind it by design -- would have been
  silently rebuilt away on the next app open. Explicit entries are now carried
  forward.
- **Reversal is the existing control**: Circles → *Start adding again*, the same
  one Step 3 shipped. Address-scope mutes appear there like any other.

**Rejected:** the interruptive ask-first design (hold the batch, push-notify
"add events from this newsletter?"). It contradicts "no training screen" by
making the user answer a question before anything lands, and it fails closed on
silence -- a missed prompt means missed school events. Also noted: there is **no
web-push infrastructure** in the codebase and none in progress, and on iOS web
push needs a Home-Screen install, which for school parents is a real barrier.

**Not built:** grouping delivery/logistics by category. There is **no
delivery/logistics category in the data model** -- Amazon and FedEx events are
`source_category: 'event'`, indistinguishable from a school event by category
alone. Per-address grouping covers the same ground today; a real category tag
would be needed to do it by category.

## 2026-09-16 — Learn from calendar activity (beta feedback)

**Why:** Beta testers said (1) Amazon deliveries split the room, (2) random
newsletters flooded the calendar while valid ones (school) were wanted, and
(3) — the big one — nobody wanted to train Criba in-app; they wanted to delete
junk off their calendar and have Criba learn.

**Decision:** One mechanism for all three — learn passively from calendar
deletions, keyed per *(sender-domain, category)*, held-not-dropped and fully
reversible. Shipped in steps: measure → act → newsletters/UI. Full write-up in
`docs/LEARNING.md`. No new Google scopes; builds on the existing per-user
trusted/muted-domain machinery.

## 2026-09-16 — UX overhaul: one design system across every tab

**Why:** The app had drifted into **two design languages** — a brutalist system
on the Review page/header (radius 0, 1.5px ink borders, ink/outline buttons) and
a softer "dashboard" language on Calendar Upload / What's Ahead (rounded corners,
accent-fill buttons). Several button classes were even defined twice, with the
soft copy silently overriding the intended brutalist one. A beta user also asked
"what does the white mean?" — the card colours weren't self-explanatory.

**Decision:** Unify everything on the brutalist system, in small reviewable
slices (buttons/pills → cards → frame → legend/empty-states → cross-tab cleanup →
boxed history list). Added a **colour legend** on Review and a **receipt strip**
("Criba added N events") so auto-add isn't a black box.

**Notable fixes found along the way:**
- `--line` was referenced but never defined, so several borders (e.g. the What's
  Ahead summary box) silently did not render. Added it as an ink alias.
- Two colliding `.empty-state` definitions were mixing type treatments.
- Kept as deliberate exceptions: the Google-Calendar-style inline editor (its
  blue signals "writes to Google") and the semantic red/amber delete/update
  buttons.

## 2026-09-16 — Reverted the fleet extraction-model swap (kept fable-5/8192)

**Why:** A change had switched the default Gmail extraction model to sonnet-5.
Investigation showed the fleet default must stay `claude-fable-5` at 8192 tokens
(sonnet truncates at 8192 and wasn't proven safe to cut over; sonnet is only a
per-account canary). Reverted. **Rule going forward: model/cost changes route
through the owner (Priya), not ad-hoc.**

## 2026-09-16 — Fixed Gmail watch-renewal cron starvation

**Why:** Renew + backlog-drain ran in one loop under the 60s function cap; slow
drains starved later renewals, so some mailboxes' watches expired and they went
dark. **Decision:** two passes — renew *every* watch first (Pass 1), then drain
best-effort under a deadline (Pass 2). See `BUGS.md` entry for detail.
