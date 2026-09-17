# Decision record

A running, plain-English log of *why* notable changes were made — the context
that a diff alone doesn't capture. Newest first. For live bugs see `BUGS.md`;
for the OAuth launch path see `VERIFICATION.md`; for the calendar-learning
feature in depth see `docs/LEARNING.md`.

---

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
