# Criba: how the user profile is built today

A map of what Criba currently knows about a user, where that knowledge comes
from, and where it is weak. Written as a starting point for making Criba
smarter at inferring things about its users.

Traced from the code, not from memory. Line numbers are `api/server.js` unless
stated otherwise; the frontend is the single file `public/index.html`.

---

## 1. What the profile actually is

Stored per user in Redis. Two stores plus a flag.

**Family members** (`getUserFamily`, :67) — one record per person:

```js
{
  id, name, color, grade,
  activities: [{ sport_or_type, org, team_tier, sender_domain, confidence }],
  senders:    [{ domain, confidence }]
}
```

**Exclusion rules** — standing negatives. Four types only: `grade`, `sender`,
`tier`, `activity`.

**`onboarded:{email}`** — a timestamp flag, nothing more.

That is the entire model. Everything Criba "knows" is those two lists.

---

## 2. Onboarding: there isn't one

On first sign-in (:5385) Criba:

1. Checks the `onboarded` flag.
2. Runs a **24-hour Gmail backfill** so the queue is not empty.
3. Writes the flag — **on attempt, not on success** (:5405), so a failed first
   scan still lands the user in the normal app rather than re-scanning forever.

**It asks the user nothing.** There is no wizard, no "who is in your family",
no "which schools". Family members are added later, by hand, on the Settings
page, and nothing prompts the user to do it.

A user who never visits that page has an empty family permanently. That
matters more than it sounds: with no members, the grade filter, the tier
filter and the whole attribution system are inert.

Members are created with `{ name, color }` only (`index.html`:1309). Grade,
activities and senders are each added afterwards, individually.

---

## 3. The four ways a fact gets created

| # | Trigger | What it writes | Confidence |
|---|---|---|---|
| 1 | User types it on the Family page | activity / sender / grade | `confirmed` |
| 2 | User assigns an event to a member | activity + sender | `confirmed` |
| 3 | Criba counts sender→member history | attribution guess only | never persisted |
| 4 | User dismisses an event and says why | exclusion rule | `confirmed` |

### #2 — `learnFromMemberAssignment` (:875)

Calls `recordActivityFromEvent` (:832) and `recordSenderFromEvent` (:857),
deliberately not short-circuited: an event can teach the activity, the sender,
or both. It fills blanks in an existing activity record and hardens a guess
into a confirmed fact.

**Critical limitation:** it is called from exactly two places (:2014, :2144),
both gated on `targetMemberId`. Learning therefore only happens when the user
does the extra work of assigning an event to a specific person.

**Plain approval teaches nothing at all.**

### #3 — `learnSenderAttribution` (:530)

Counts `member_id` per sender domain. Requires **at least 2 events and at
least 75% consistency** (:548). The reasoning in the comment is sound: one
pick is an anecdote, and a sender split evenly between two children is a
sender that genuinely serves both, where guessing is worse than the blank the
user can fill in.

It skips any event without a `member_id`, so it feeds on the output of #2 and
inherits its gate. It is a runtime guess and is never written to the profile.

### #4 — dismissal becomes a rule

User dismisses an event → modal asks "Why not *X*?" with five presets
(`index.html`:1153) → `exclusionCandidates` (:435) reduces the answer to the
narrowest rule it can defend → a second confirm dialog before it becomes
standing (`index.html`:2021).

Consumer mailbox domains (gmail.com, outlook.com, …) are refused outright
(:396) — a rule about a freemail domain identifies no organisation and would
hide every friend, relative and self-addressed note.

---

## 4. How the facts are used

### `resolveAttribution` (:780)

Evidence order, and it stops rather than degrading:

1. **Activities first.** They carry the tier discriminators, so they are the
   only thing that can tell a frosh mail from a varsity one when both come
   from the same school and both say "football".
2. **Confirmed senders next.** Two children at one school returns `ambiguous`
   rather than a coin flip.
3. An ambiguous verdict **stops the search**. It never falls through to the
   counted guess, which is precisely the evidence just established as not good
   enough.

### `eventRelevance` (:381)

The gate. Asks, in order:

1. Is this someone else's event, mentioned in a newsletter?
2. Does the grade match anyone in the family?
3. Sender rule?
4. Tier rule?
5. Activity rule?

Anything held reaches the review queue **with the reason attached** — nothing
is discarded. Criba guessing wrong should cost the user a click, not an event.

### `familyHasPositive` (:404)

A **confirmed** positive fact always beats a negative one. This is the safety
valve on stale exclusions: grades change, teams change, and an exclusion that
outlives the truth would otherwise silently hide a real child's real event.

---

## 5. The confidence model

Two values: `inferred` / `guess`, and `confirmed`. Only `confirmed` can
override an exclusion rule.

**`confirmed` is only ever written by an explicit human action.** The comment
at :828 gives the reasoning: nothing derived from Criba's own guesses is
written here, because that is what would let a single bad guess confirm itself
forever.

The principle is right. The consequence is that **confidence can never be
earned by evidence** — only granted by a click.

---

## 6. Where this is weak

Ordered roughly by leverage.

1. **No onboarding interview.** The single biggest gap. Five questions at
   signup — children, grades, schools, sports, teams — would populate more
   profile in one minute than months of current usage.

2. **The learning loop is gated behind manual member-assignment.** Approval is
   the least ambiguous signal in the product and it teaches nothing. Dismissal
   is the most ambiguous and it writes permanent rules. That is backwards.

3. **Dismissal is treated as unambiguous when it isn't.** "Wrong kid's team",
   "already knew about it", "not interested this season", "duplicate" and "bad
   extraction" are indistinguishable to Criba, yet one of them can become
   *"never show events containing the word varsity"*.

4. **Rules are coarser than the model already supports.** An activity record
   can express `{ org: 'siprep.org', sport_or_type: 'football', team_tier:
   'varsity' }`. A dismissal collapses all of that into a single-axis word ban.
   The structure for something better already exists at :556 and the dismissal
   path simply does not use it.

5. **Confidence cannot be earned.** Three approved soccer events all attributed
   to Arin should be enough to confirm that activity. It stays a guess, and an
   unconfirmed fact cannot override a stale exclusion — so the rule keeps
   winning against reality.

6. **The user's existing Google Calendar is never read for signal.** Years of
   ground truth about what this family actually attends, sitting unused.

7. **Attribution is honest about ambiguity but does nothing with it.**
   `resolveAttribution` returns `ambiguityReason: "Aarav and Arin both get mail
   from siprep.org"` — a perfectly formed question that is never asked.

---

## 7. Suggested first moves

Smallest first, each independently shippable.

1. **Learn from every approval, not just member-assignments.** If the sender or
   a name in the event points at exactly one person, record it. A few lines,
   no new UI, and it turns the learning loop the right way round.

2. **Let repetition earn confirmation.** N consistent observations promote a
   fact to `confirmed`, so positive knowledge can beat stale exclusions.
   Preserves the "no guess confirms itself" principle if N is evidence from
   distinct events rather than one guess echoing.

3. **Make dismissal produce a narrowing, not a ban.** "Not Arin's team" should
   attach a negative to that specific activity/org/tier, not create a global
   word rule.

4. **Ask the ambiguous question.** When attribution returns `ambiguous`, that
   is the one moment the user can answer cheaply and the answer is worth the
   most.

5. **An onboarding interview**, feeding straight into the family model.
