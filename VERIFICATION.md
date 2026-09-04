# Criba — Google OAuth verification pack

Everything needed to publish Criba to production and pass Google OAuth
verification. Work top-to-bottom. Items marked **(Priya/Console)** are done in the
Google Cloud / Vercel / Cloudflare dashboards; the app-side assets they reference
already exist and are live.

---

## 0. TL;DR sequence

1. **Now — unblock users:** complete Branding → Publish app to Production. (No domain needed.)
2. **Async — clean domain:** Cloudflare CNAME → `app.criba.app` (in progress).
3. **Then — verification:** submit OAuth verification with the owned-domain URLs + demo video.
4. **Long pole — CASA:** required because of the restricted `gmail.readonly` scope.

The only thing between you and *some* real users is step 1. Steps 3–4 remove the
"unverified" warning and the 100-user cap.

---

## 1. App identity (use verbatim in Console → Branding)

| Field | Value (now, on Vercel) | Value (after `app.criba.app`) |
|---|---|---|
| App name | `Criba` | `Criba` |
| User support email | `priya.zachariah@gmail.com` | same |
| App logo | `public/logo.png` (120×120) | same |
| Homepage | `https://criba-app-yela.vercel.app` | `https://app.criba.app` |
| Privacy policy | `https://criba-app-yela.vercel.app/privacy` | `https://app.criba.app/privacy` |
| Terms of service | `https://criba-app-yela.vercel.app/terms` | `https://app.criba.app/terms` |
| Authorized domain | `vercel.app` (publish only) | `criba.app` (required for verification — must be verified in Google Search Console, which you can do because you own it) |

> Verification requires the homepage/privacy URLs to be on a domain you can verify
> ownership of. `vercel.app` cannot be verified (it's Vercel's). That's why the
> owned domain (`app.criba.app`) is required before submitting for verification.

---

## 2. Scopes requested, and the justification for each

Google's review asks *why* each sensitive/restricted scope is needed and *how* the
data is used. Answers below map to real features.

| Scope | Tier | Why Criba needs it | Data handling |
|---|---|---|---|
| `userinfo.email`, `userinfo.profile` | non-sensitive | Identify the signed-in user. | Name + email stored to key the account. |
| `gmail.readonly` | **restricted** | Core feature: detect calendar-worthy items (events, deadlines, reminders) in the user's email and turn them into calendar entries. | Read-only. Message content is used **only** to extract event details; the raw mailbox is not stored. Relevant text is sent to our AI processor (Anthropic) solely to extract events and is not used for training. |
| `calendar.events` | sensitive | Add the events the user approves to their Google Calendar and colour-code them. | Writes only user-approved events. |
| `calendar.calendarlist.readonly` | sensitive | Read the user's calendar list to detect and prevent duplicate events across calendars. | Read-only; used for de-duplication. |
| `contacts.readonly` | sensitive | Suggest saved contacts (name + email) when the user assigns or invites people to an event. | Read-only; used for in-app autocomplete. |
| `contacts.other.readonly` | sensitive | Same, for people the user has corresponded with ("other contacts"), so guest autocomplete feels complete. | Read-only; autocomplete only. |
| `directory.readonly` | sensitive | For Workspace users, suggest co-workers from the org directory when assigning/inviting. | Read-only; autocomplete only. Returns nothing for personal accounts. |

**Limited Use statement (paste into the justification box):**
> Criba's use and transfer of Google user data complies with the Google API Services
> User Data Policy, including the Limited Use requirements. Data is used only to
> provide user-facing calendar features, is not sold, is not used for advertising,
> is not transferred except to provide the service or as required by law, and is not
> read by humans except with consent, for security, or as required by law.

Full policy: served live at `/privacy` (includes the Limited Use disclosure).

---

## 3. Demo video script (required for verification)

Record a 2–4 min screen capture, no cuts, showing the consent screen and each
sensitive/restricted scope actually in use.

1. **OAuth consent** — open the app, click "Continue with Google", show the consent
   screen listing the scopes, and grant them. (Proves the requested scopes.)
2. **Gmail (read-only)** — show an email arriving that contains an event
   (e.g. "Dentist Friday 3pm"), then show it appearing in Criba's review queue —
   demonstrating read-only extraction, not sending.
3. **Calendar (events)** — approve that event in Criba and show it now on Google
   Calendar, colour-coded.
4. **Calendar list (dedup)** — show an event that's already on the calendar being
   flagged "already on your calendar" and *not* duplicated.
5. **Contacts / other contacts / directory** — on an event card, type a name in
   "+ New person" and show contact suggestions appearing (name + email).
6. **Data control** — show sign-out and mention that access can be revoked in Google
   Account permissions (link is in the privacy policy).

Narrate what each step demonstrates and which scope it uses.

---

## 4. Console checklist

**(Priya/Console) — Branding & publish (do now, unblocks users):**
- [ ] Google Cloud → **Branding**: fill every field in §1 (Vercel URLs are fine for publishing) + upload `public/logo.png`.
- [ ] Google Cloud → **Audience → Publish app** (Testing → Production).

**(Priya/Console) — Domain (async):**
- [ ] Cloudflare (criba.app) → add CNAME `app` → `ecbe89c63fa3c3ba.vercel-dns-017.com`, **DNS only (grey cloud)**.
- [ ] Vercel `criba-app-yela` → Domains → confirm `app.criba.app` shows **Valid**.
- [ ] Google Search Console → verify ownership of `criba.app`.
- [ ] Google Cloud → **Branding** → switch homepage/privacy/terms to the `app.criba.app` URLs; add `criba.app` as an Authorized domain.
- [ ] Google Cloud → **Clients** → add `https://app.criba.app/api/auth/google/callback` to the Criba OAuth client's redirect URIs.

**(Priya/Console) — Verification:**
- [ ] Google Cloud → **Verification Center** → submit for verification with scopes (§2), demo video (§3), and the owned-domain URLs.
- [ ] Complete the **CASA** security assessment for `gmail.readonly` (the restricted scope). This is the long pole — engage an authorized assessor early.

**Ops readiness:**
- [ ] Anthropic billing/budget set for production usage.
- [ ] Point the marketing site's "Sign in" button at `https://app.criba.app`.

---

## 5. What already exists in the app (nothing more to build here)

- Privacy policy + Limited Use disclosure: `/privacy`
- Terms of service: `/terms`
- Logo: `/logo.png` (120×120) and `/logo.svg`
- Host-derived OAuth redirect (works on any domain once its callback is registered)
- Guided onboarding, auto-add with duplicate guard, review calendar/agenda, circles
