// Offline eval for the "kinds" prompt variant.
//
// Has no path to autoWriteToCalendar, no path to the events store, and never
// writes anything anywhere. It reads mail, calls the model through the shadow
// harness under the harness's own spend cap, and prints a table. Fable stays
// live and untouched throughout.
//
// The expectations below are the ones stated when this work was commissioned,
// written down before any run so the result cannot be fitted to them
// afterwards. messageId is filled in per account; the labels are stable.

export const EXPECTATIONS = [
  { label: 'rsm-makeup-test', messageId: null,
    note: 'RSM "Missed the school test today"',
    expect: { items: 1, kinds: ['choice'], allDay: 0, person: 'Arin',
              dueDate: '2026-10-26', optionsAtLeast: 2 } },

  { label: 'coach-week-of-1019', messageId: null,
    note: "Coach's WEEK OF 10/19",
    expect: { items: 5, kinds: ['event'], allDay: 0,
              times: ['15:10','15:10','15:10','15:10','17:00'],
              supersedesAtLeast: 1,
              mustKeep: [
                { title: 'Practice', date: '2026-10-19' },
                { title: 'Practice', date: '2026-10-20' },
                { title: 'Practice', date: '2026-10-21' },
                { title: 'Practice', date: '2026-10-22' },
                { title: 'Game', date: '2026-10-23' },
              ] } },

  { label: 'si-newsletter', messageId: null,
    note: 'SI newsletter, grade-specific items',
    expect: { oneEntryPerRealEvent: true, skipOtherGrades: true } },

  { label: 'hcsd-newsletter', messageId: null,
    note: 'HCSD newsletter, grade-specific items',
    expect: { oneEntryPerRealEvent: true, skipOtherGrades: true } },

  { label: 'clear-payment-failed', messageId: null,
    expect: { items: 1, kinds: ['reminder'], allDay: 0 } },
  { label: 'nytimes-expiry', messageId: null,
    expect: { items: 1, kinds: ['notice','reminder'], allDay: 0 } },
  { label: 'audible-credit', messageId: null,
    expect: { items: 1, kinds: ['notice','reminder'], allDay: 0 } },
  { label: 'olukai-return-window', messageId: null,
    expect: { items: 1, kinds: ['reminder'], allDay: 0 } },

  { label: 'zoom-webinar', messageId: null,
    expect: { items: 1, kinds: ['event'], allDay: 0, hasTime: true } },
  { label: 'restaurant-reservation', messageId: null,
    expect: { items: 1, kinds: ['event'], allDay: 0, hasTime: true } },
];

// All-day means the source said so, NOT "has no clock time". Counting an
// untimed reminder as all-day would have reported the new prompt as producing
// just as many banners as the old one, which is the opposite of what it does
// and the exact number this eval exists to move.
const ALL_DAY = e => e?.is_all_day === true;

// Everything the baseline produced. NOT "real events" -- the baseline turns
// three drop-in windows into three events, and collapsing those is the point
// rather than a regression.
export function baselineItems(items) {
  return (items || []).filter(e => e && e.title && e.date);
}

function titleHead(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(); }

// Prefix either way, because the two sides are the same event described at
// different lengths: "Game" against "Game Day", "Practice" against "Practice
// (Murray Field)". Exact comparison scored a kept event as lost.
function appearsIn(list, needle) {
  const want = titleHead(needle.title);
  return (list || []).some(c => {
    if (needle.date && c.date !== needle.date) return false;
    const got = titleHead(c.title);
    return got === want || got.startsWith(want) || want.startsWith(got);
  });
}

export function scoreOne(label, baseline, candidate, expect = {}) {
  const cand = candidate || [];
  const base = baseline || [];
  const kinds = cand.map(e => e.kind || 'unlabelled');
  const out = {
    label,
    baselineItems: base.length,
    candidateItems: cand.length,
    baselineAllDay: base.filter(ALL_DAY).length,
    candidateAllDay: cand.filter(ALL_DAY).length,
    kinds,
    checks: [],
  };
  const check = (name, pass, detail = '') => out.checks.push({ name, pass, detail });

  if (expect.items != null) check('item count', cand.length === expect.items, `${cand.length} vs ${expect.items}`);
  if (expect.allDay != null) check('all-day count', out.candidateAllDay === expect.allDay,
    `${out.candidateAllDay} vs ${expect.allDay}`);
  if (Array.isArray(expect.kinds) && expect.kinds.length) {
    const ok = expect.kinds.length === 1 || expect.kinds.length !== cand.length
      ? cand.every(e => expect.kinds.includes(e.kind))
      : cand.every((e, i) => expect.kinds.includes(e.kind));
    check('kind', ok, kinds.join(','));
  }
  if (expect.hasTime) check('has a time', cand.every(e => !!(e.start_time || e.time)), kinds.join(','));
  if (expect.person) check('person', cand.some(e =>
    (e.attendees || []).some(a => String(a).toLowerCase() === expect.person.toLowerCase())), expect.person);
  if (expect.dueDate) check('due date', cand.some(e => e.date === expect.dueDate), expect.dueDate);
  if (expect.optionsAtLeast != null) check('options kept in notes',
    cand.some(e => (e.options || []).length >= expect.optionsAtLeast
      || String(e.notes || '').split('\n').length >= expect.optionsAtLeast), '');
  if (expect.supersedesAtLeast != null) check('supersedes',
    cand.reduce((n, e) => n + (e.supersedes || []).length, 0) >= expect.supersedesAtLeast, '');
  if (Array.isArray(expect.times) && expect.times.length) {
    const got = cand.map(e => e.start_time || e.time || null).filter(Boolean).sort();
    check('times', expect.times.slice().sort().every((t, i) => got[i] === t), got.join(','));
  }

  // Recall, and it has to be asked the right way.
  //
  // Against the regression corpus -- emails with no stated expectation -- any
  // item the baseline found and this one did not is a loss, and that is the
  // number that must not move.
  //
  // Against the test set, the expectation already states the right shape, and
  // the whole point of several of them is that the baseline produced too much.
  // Comparing to the baseline there would score the intended fix as a
  // regression. Those emails name what must survive instead, with mustKeep.
  if (Array.isArray(expect.mustKeep) && expect.mustKeep.length) {
    const missing = expect.mustKeep.filter(m => !appearsIn(cand, m));
    out.lostFromBaseline = missing.map(e => `${e.date || ''} ${e.title}`.trim());
    check('kept every named event', missing.length === 0, out.lostFromBaseline.join(' | '));
  } else if (expect.items == null) {
    const lost = baselineItems(base).filter(b => !appearsIn(cand, b));
    out.lostFromBaseline = lost.map(e => `${e.date} ${e.title}`);
    check('no item lost against the baseline', lost.length === 0,
      lost.length ? lost.join(' | ') : '');
  } else {
    // Shape is asserted directly; the baseline is reported, not judged.
    out.lostFromBaseline = [];
  }

  out.passed = out.checks.every(c => c.pass);
  return out;
}

export function scoreAll(rows) {
  const n = rows.length || 1;
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  return {
    emails: rows.length,
    passed: rows.filter(r => r.passed).length,
    baselineItemsPerEmail: +(sum(r => r.baselineItems) / n).toFixed(2),
    candidateItemsPerEmail: +(sum(r => r.candidateItems) / n).toFixed(2),
    baselineAllDay: sum(r => r.baselineAllDay),
    candidateAllDay: sum(r => r.candidateAllDay),
    itemsLost: sum(r => r.lostFromBaseline.length),
    kindCounts: rows.flatMap(r => r.kinds).reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {}),
    rows,
  };
}

// Cost, before anything is spent. Token figures are measured from the live
// prompt and a median email, not guessed.
export function estimateCostUsd({ emails, arms = 2, model = 'claude-sonnet-5',
  promptTokens = 3100, emailTokens = 1400, outputTokens = 900 } = {}) {
  const PRICING = {
    'claude-sonnet-5': { in: 2, out: 10 },
    'claude-opus-5':   { in: 5, out: 25 },
    'claude-fable-5':  { in: 10, out: 50 },
    'claude-haiku-4-5':{ in: 1, out: 5 },
  }[model];
  if (!PRICING) throw new Error(`unpriced model "${model}"`);
  const calls = emails * arms;
  const inTok = calls * (promptTokens + emailTokens);
  const outTok = calls * outputTokens;
  const usd = (inTok * PRICING.in + outTok * PRICING.out) / 1e6;
  return { model, calls, inputTokens: inTok, outputTokens: outTok, usd: +usd.toFixed(3) };
}
