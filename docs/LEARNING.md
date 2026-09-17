# Learning from your calendar

*How Criba learns what you want — by watching your calendar, not by making you
train it. Written for anyone picking this up later: the plain-English "why"
first, the technical detail second.*

---

## 1. Why this exists (the beta feedback)

Three complaints from beta testers, all really the same problem:

1. **Amazon deliveries** — some people wanted delivery events on their calendar,
   some were annoyed by them. There is no single right answer.
2. **Newsletters** — people subscribe to random newsletters, and Criba was
   pulling *every* announced event out of them. Some newsletters are valuable
   (the school one); most are noise.
3. **The big one** — *nobody* wanted to go into Criba and dismiss events to
   "train" it. They wanted to just **delete the junk off their calendar** and
   have Criba **learn from that**.

The insight from #3 is the whole design: **stop asking people to train Criba;
learn from what they already do in their calendar.** A dismissal inside Criba is
a weak, effortful signal. Deleting an event off Google Calendar is the strongest
possible "I didn't want this" — and it costs the user nothing extra.

That one mechanism solves all three: deletions teach Criba, per person, which
senders and which *kinds* of event to stop adding.

## 2. The principle (one loop)

```
   Criba adds an event  ─────────────►  you keep it, or delete it
          ▲                                    (in Google Calendar)
          │                                          │
          └──── adds more of what you keep,  ◄───────┘
                pauses what you keep deleting
```

No training screen. Criba only asks you anything when *you* want to change
something.

## 3. The signal — how Criba knows you deleted something

There is a clean, reliable tell already in the codebase:

- When you delete an event **through Criba's own UI**, Criba sets its stored
  `calEventId` to `null`.
- So any event whose `calEventId` is **still set**, but which Google Calendar now
  reports as `status: "cancelled"` (or returns `404` / `410`), was deleted by
  **you, directly in Google Calendar**.

That distinction is what lets Criba count *your* deletions without mistaking its
own deletions for a signal. Events that simply passed their date and are gone are
not counted as deletions — only `cancelled`/missing ones are.

## 4. How it works, in three steps

The feature ships in three deliberately separate steps so each is small and
reviewable, and so the automatic behaviour is tuned from real data.

### Step 1 — Measure (shipped, behaviour-neutral)
`learnFromCalendar()` re-checks a bounded batch (12) of Criba-added Gmail events
against Google Calendar and records each as **kept** (survived to its date) or
**deleted** (cancelled/gone), keyed by *(sender-domain, category)*. It changes
**nothing** users see — it only builds the tally that Step 2 acts on.

- Triggered by the browser, fire-and-forget, on app open (`showApp()` →
  `POST /api/learn/check`).
- Read the numbers any time with `GET /api/learn/stats` (delete-rate per sender).

### Step 2 — Act: pause / un-pause (shipped)
When a *(sender, category)* has been **deleted 3+ times with 0 kept**, Criba
stops auto-adding new ones. Crucially it **holds them into Review** — it never
silently drops them. Keeping one automatically un-pauses that sender.

- Decision: `shouldLearnMute()` + `reconcileLearnedMutes()`, run whenever new
  outcomes land.
- Gate: in both auto-add paths (the Gmail **webhook** and the **backfill/scan**),
  a paused sender+category produces a `hold` instead of a calendar write — the
  same "held, not dropped" mechanism used for prior refusals.
- Reversible: `POST /api/learn/unmute {domain, category}` ("start adding again")
  drops the mute and resets that tally so a couple of old deletes don't
  immediately re-pause it.

### Step 3 — Newsletters + delivery type + the "paused" list (planned)
- Detect bulk/newsletter senders from email headers (`List-Unsubscribe`,
  `Precedence: bulk`) and give them a low default trust so they must *earn*
  auto-add rather than getting it on sight. (Bonus: skipping extraction on junk
  newsletters also lowers the AI bill.)
- Make sure delivery-type emails are tagged so "no deliveries" can be true for
  one person without affecting real Amazon events.
- Surface a **"Criba stopped adding … · [Start adding again]"** list in
  Circles/settings, plus the same control on held cards in Review.

## 5. What Criba stores (per user, in `settings:`)

Two small objects. Nothing new in the database; both live in the existing
per-user settings hash. **No new Google permissions** — it uses the calendar
access Criba already has.

```jsonc
// settings.senderStats — the raw tally (Step 1)
{ "stats": {
    "amazon.com":  { "delivery":   { "kept": 0, "deleted": 5, "lastDeletedAt": "…" } },
    "school.org":  { "newsletter": { "kept": 6, "deleted": 0 } }
} }

// settings.learnedMutes — who is currently paused (Step 2)
{ "mutes": {
    "amazon.com|delivery": { "since": "…", "deleted": 5, "kept": 0 }
} }
```

Each Criba-added event also gets `learn_checked: true` and
`learn_outcome: "kept" | "deleted"` once evaluated, so it is only counted once.

## 6. The endpoints

| Endpoint | Does |
|---|---|
| `POST /api/learn/check` | Re-check a bounded batch; update tally + mutes. Called on app open. |
| `GET  /api/learn/stats` | Read the tally (delete-rate per sender) and the current paused list. |
| `POST /api/learn/unmute` | "Start adding again" for one `{domain, category}`. |

## 7. The default rule, and how to tune it

The pause rule is intentionally **conservative and easy to explain**, and lives
in one place:

```js
function shouldLearnMute(stat) {
  return (stat?.deleted || 0) >= 3 && (stat?.kept || 0) === 0;
}
```

> Pause after **3+ deletes with 0 keeps**; un-pause the moment the user keeps one.

Once Step 1 has gathered real numbers (via `/api/learn/stats`), revisit this. If
deliveries are deleted ~80% of the time you might relax it; if it ever pauses
something people wanted, tighten it. Because everything is **held, not dropped**,
a wrong threshold is visible and one click to reverse — not a lost event.

## 8. Safety rails (why this can't quietly lose your events)

- **Held, never dropped.** A paused event still lands in Review with the reason;
  one click adds it.
- **Always reversible.** "Start adding again" turns a sender back on; keeping one
  event un-pauses it automatically.
- **Trusted beats muted.** A sender you mark trusted (e.g. the school) is *never*
  paused, no matter how the tally looks.
- **Per-user.** One person's deletions never change what another person sees.
- **Bounded + fail-soft.** The calendar re-check is capped per call and any error
  just yields zeros — it can never break the review queue.

## 9. Decision log

- **2026-09-16 — Learn from calendar, not in-app training.** Chose passive
  calendar signals over an in-app "train Criba" flow, directly per beta feedback
  #3. Kept the existing per-user trusted/muted-domain machinery and added an
  automatic learning layer on top rather than replacing it.
- **2026-09-16 — Key on (sender-domain, category), not domain alone.** So "Amazon
  deliveries" can be paused without muting real Amazon events (feedback #1).
  Category = Claude's `source_type` tag on the extracted event.
- **2026-09-16 — Held, not dropped; conservative default (3 deletes / 0 keeps).**
  Favoured false-negatives (occasionally add something unwanted) over
  false-positives (hide something wanted), since a hold is visible and
  reversible. Thresholds to be tuned from `/api/learn/stats` data before relaxing.
- **2026-09-16 — Ship in 3 steps (measure → act → newsletters/UI).** Step 1 is
  behaviour-neutral on purpose: gather real delete-rates before any auto-pause.
