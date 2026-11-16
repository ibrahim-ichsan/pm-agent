// What deserves attention, worked out by rule from Tasks, Applications, Networking and the calendar.
// No language model here: dates, tiers, stages and follow-up age are facts, so the ranking is repeatable
// and every line carries the reason it is there.
import { diffDays, pretty } from './dates.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// An offer has to be stated as one: "she offered a referral", "happy to introduce me". The bare words
// "referral" or "introduction" in notes about how networking works are not a signal.
const OFFER = String.raw`(?:offer\w*|happy|willing|glad|can|could|will|would|nawarin|mau|bisa|bersedia)\b[^.\n]{0,40}`;
export const SIGNALS = [
  ['referral offered', new RegExp(String.raw`${OFFER}\brefer|\brefer (?:me|you)\b|\breferral offered`, 'i')],
  ['introduction offered', new RegExp(String.raw`${OFFER}\bintro|\bintroduce (?:me|you)\b|\bkenalin (?:gw|gue|aku|saya)`, 'i')],
  ['hiring mentioned', /\bhiring\b|open roles?|vacanc|\bopenings?\b|lowongan|recruiting now/i],
];
// "Nobody met", "none", "-" in the People field is not a person.
export const personOf = (row) => { const first = String(row.people || '').split('\n')[0].trim(); return /^(nobody|no one|none|n\/a|tidak ada|nggak ada|-|—)?$/i.test(first) || /^(nobody|no one|none)\b/i.test(first) ? '' : first; };
export const signalsOf = (row) => { if (!personOf(row)) return []; const t = `${row.people} ${row.topics} ${row.nextSteps}`; return SIGNALS.filter(([, re]) => re.test(t)).map(([name]) => name); };
// The owner has done their part and is waiting for the other side. Kept in the existing "Next action" field.
export const WAITING = /\b(wait(ing)?|await(ing)?|nunggu|menunggu|pending result)\b/i;
export const isWaiting = (a) => WAITING.test(a.nextAction || '');
const TIER = { 'Tier 1': 30, 'Tier 2': 15, 'Tier 3': 0 };
// Calendar entries that are career work in themselves: a test, an assessment, an interview, an application deadline.
const CAREER_EVENT = /\b(assessment|online test|aptitude|interview|hirevue|case study|video interview|application deadline|deadline)\b/i;
const NOT_CAREER_EVENT = /\b(lecture|tutorial|lab|seminar|class)\b/i;
const hours = (e) => (e.allDay || !e.start || !e.end ? 0 : Math.max(0, (Number(e.end.slice(0, 2)) * 60 + Number(e.end.slice(3)) - Number(e.start.slice(0, 2)) * 60 - Number(e.start.slice(3))) / 60));

// Networking rows that mention a company, for "you know someone there".
export function contactsAt(company, net) {
  const c = norm(company);
  if (c.length < 3) return [];
  return (net || []).filter((r) => norm(`${r.org} ${r.people} ${r.title}`).includes(c) && (r.people || r.status !== 'Upcoming'));
}

// Checks on one application against everything else. Each is a suggestion, never an action.
export function appChecks(a, { tasks = [], net = [], events = [], today, idleDays = 14 }) {
  const out = [];
  const c = norm(a.company || a.title.split('—')[0]);
  const mentions = (s) => c.length >= 3 && norm(s).includes(c);
  const prepTask = tasks.find((t) => mentions(t.title) && /prep|interview|test|assessment|siap/i.test(t.title));
  const left = a.due ? diffDays(a.due, today) : null;
  const waiting = isWaiting(a);
  if (waiting) out.push('Marked as waiting for a result.');
  if (a.stage === 'Interview' && !prepTask && !waiting) out.push('Interview stage but no prep task exists.');
  if (a.stage === 'Online test' && left !== null && left >= 0 && left <= 1) out.push(`Online test deadline is ${left === 0 ? 'today' : 'tomorrow'}.`);
  if (a.stage === 'Online test' && !prepTask && !waiting && (left === null || left > 1)) out.push('Online test stage but no task for it.');
  if (a.stage === 'Wishlist' && left !== null && left >= 0) out.push(`Deadline ${pretty(a.due)} and still on the wishlist: apply or drop it.`);
  const since = a.lastUpdate || a.appliedOn;
  if (a.tier === 'Tier 1' && a.stage === 'Applied' && since && diffDays(today, since) >= idleDays) out.push(`Tier 1 with no change for ${diffDays(today, since)} days.`);
  if (a.referral && !a.followUp) out.push(`Referral contact (${a.referral}) but no follow-up date.`);
  const known = contactsAt(a.company, net);
  if (known.length) out.push(`You know someone there: ${known.slice(0, 2).map((r) => (r.people.split('\n')[0] || r.title).slice(0, 60)).join('; ')}.`);
  const ev = events.find((e) => mentions(e.title) && diffDays(e.date, today) >= 0 && diffDays(e.date, today) <= 3);
  if (ev) out.push(`On the calendar: ${ev.title} (${pretty(ev.date, ev.start)}).`);
  return out;
}

// Every candidate with a score and a one-line reason. scope 'career' leaves out coursework and personal tasks.
export function rank(d, { scope = 'all', horizon = 0 } = {}) {
  const { today } = d; const items = []; const usedEvents = new Set();
  const push = (kind, title, score, why, extra = {}) => { if (score > 0) items.push({ kind, title, score, why: why.filter(Boolean).join(', '), ...extra }); };
  for (const t of d.tasks || []) {
    if (scope === 'career' && t.area !== 'Job search') continue;
    let s = 0; const why = [];
    if (t.due) {
      const left = diffDays(t.due, today);
      if (left < 0) { s += 90 + Math.min(10, -left); why.push(`${-left} day${left < -1 ? 's' : ''} late`); }
      else if (left === 0) { s += 100; why.push('due today'); }
      else if (left === 1) { s += 60; why.push('due tomorrow'); }
      else if (left <= Math.max(3, horizon)) { s += 35; why.push(`due ${pretty(t.due)}`); }
    }
    if (t.priority === 'Must') { s += 25; why.push('Must'); } else if (t.priority === 'Should') s += 10;
    if (t.area === 'Coursework' && s) { s += 15; why.push('Coursework'); }
    if (t.area === 'Job search' && s) s += 10;
    if (!t.due && t.priority !== 'Must') s = 0;
    push('task', t.title, s, why, { id: t.id });
  }
  for (const a of d.apps || []) {
    let s = 0; const why = [];
    const left = a.due ? diffDays(a.due, today) : null;
    const tier = TIER[a.tier] || 0;
    const since = a.lastUpdate || a.appliedOn;
    if (isWaiting(a)) {
      // Nothing to do until they answer. Surfaces again only when it has been quiet for a long time.
      const quiet = since ? diffDays(today, since) : 0;
      if (quiet >= (d.idleDays || 14)) push('app', a.title, 30 + tier, [a.tier, `waiting ${quiet} days for a result`, 'a polite nudge is reasonable'], { id: a.id, waiting: true });
      continue;
    }
    const active = ['Interview', 'Online test'].includes(a.stage);
    const dated = left !== null && left >= 0;
    // A stage with a date is urgent. A stage with no date on record may already be done, so it ranks lower and says so.
    if (active) { s += dated ? 70 : 40; why.push(a.stage.toLowerCase()); if (!dated) why.push(since ? `no date on record, last update ${pretty(since)}` : 'no date on record'); }
    if (left !== null && left >= 0) {
      if (left <= 1) { s += left === 0 ? 60 : 50; why.push(`deadline ${left === 0 ? 'today' : 'tomorrow'}`); }
      else if (left <= Math.max(3, horizon)) { s += 30; why.push(`deadline ${pretty(a.due)}`); }
      if (a.stage === 'Wishlist' && left <= 7) { s += 25; why.push('not applied yet'); }
    }
    if (a.followUp && diffDays(a.followUp, today) <= 0 && diffDays(a.followUp, today) >= -7) { s += 25; why.push('follow-up due'); }
    const checks = s || tier ? appChecks(a, d) : [];
    const cal0 = checks.find((c) => c.startsWith('On the calendar'));
    if ((dated || cal0) && checks.some((c) => /no prep task|no task for it/.test(c))) { s += 10; why.push('no prep task yet'); }
    const cal = checks.find((c) => c.startsWith('On the calendar'));
    if (cal) { s += 40; why.push(cal.replace('On the calendar: ', '').replace(/\.$/, '')); usedEvents.add(cal); }
    if (checks.some((c) => c.startsWith('You know someone'))) why.push('you know someone there');
    if (s) { s += tier; if (a.tier) why.unshift(a.tier); }
    push('app', a.title, s, why, { id: a.id });
  }
  for (const r of d.net || []) {
    if (r.status === 'Attended' && r.followUp) {
      const late = diffDays(today, r.followUp);
      if (late < -Math.max(0, horizon)) continue;
      const sig = signalsOf(r);
      const who = personOf(r).slice(0, 50);
      push('net', `Follow up: ${who || r.title}`, 55 + (late > 0 ? Math.min(15, late * 3) : 0) + sig.length * 20 + (who ? 0 : -25),
        [who ? `met at ${r.title}` : 'learning entry', ...sig, late > 0 ? `follow-up ${late} day${late > 1 ? 's' : ''} overdue` : late === 0 ? 'follow-up due today' : `follow-up by ${pretty(r.followUp)}`], { id: r.id });
    } else if (r.status === 'Upcoming' && r.date && diffDays(r.date, today) >= 0 && diffDays(r.date, today) <= horizon) {
      const left = diffDays(r.date, today);
      push('event', `${r.title}`, (r.type === 'Employer event' ? 50 : 35) - left * 3, [r.type || 'event', left === 0 ? `today${r.time ? ' ' + r.time : ''}` : pretty(r.date, r.time), r.prep ? '/prep has the questions' : 'no prep yet'], { id: r.id });
    }
  }
  // Tests, assessments and interviews that sit on the calendar are work to do even when the application row has no date.
  for (const e of d.events || []) {
    const left = diffDays(e.date, today);
    if (left < 0 || left > Math.max(1, horizon) || !CAREER_EVENT.test(e.title) || NOT_CAREER_EVENT.test(e.title)) continue;
    if ([...usedEvents].some((u) => u.includes(e.title))) continue; // already the reason an application is ranked
    if (items.some((x) => x.kind === 'cal' && x.title === e.title)) continue;
    push('cal', e.title, left === 0 ? 100 : left === 1 ? 90 : left <= 3 ? 75 : 50, ['on your calendar', left === 0 ? `today${e.start ? ' ' + e.start : ''}` : left === 1 ? `tomorrow${e.start ? ' ' + e.start : ''}` : pretty(e.date, e.allDay ? null : e.start)]);
  }
  return items.sort((a, b) => b.score - a.score);
}

// Hours already booked today, so the list can say when it will not fit.
export function bookedHours(events, today) { return (events || []).filter((e) => e.date === today).reduce((t, e) => t + hours(e), 0); }

// The short ranked block for /today and the digest.
export function topPriorities(d, L) {
  const all = rank(d);
  const worthy = all.filter((x) => x.score >= 40);
  const top = worthy.slice(0, 3);
  if (!top.length) return null;
  const open = (d.tasks || []).length;
  const lines = [`<b>${L('Top priorities today', 'Prioritas utama hari ini')}</b>`, ...top.map((x, i) => `${i + 1}. ${escape(x.title)} — ${escape(x.why)}`)];
  if (worthy.length > top.length) lines.push(L(`${worthy.length} things are pressing today, which is more than fits: start with these three and move the rest on purpose.`, `Ada ${worthy.length} hal yang mendesak hari ini, lebih dari yang muat: mulai dari tiga ini, sisanya geser dengan sengaja.`));
  else if (open > top.length + 2) lines.push(L(`${open} open tasks, but only ${top.length} thing${top.length > 1 ? 's deserve' : ' deserves'} attention today.`, `${open} task masih buka, tapi cuma ${top.length} hal yang perlu dikerjain hari ini.`));
  const booked = bookedHours(d.events, d.today);
  if (booked >= 6 && top.length > 1) lines.push(L(`About ${Math.round(booked)}h is already booked today. Realistically: do number 1${top.length > 2 ? ', maybe 2' : ''}, move the rest.`, `Sekitar ${Math.round(booked)} jam hari ini udah keisi. Realistisnya: kerjain nomor 1${top.length > 2 ? ', mungkin 2' : ''}, sisanya geser.`));
  return lines.join('\n');
}
const escape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Relationship state from the rows that mention a person. Computed each time, not stored.
export function relationship(rows, today) {
  const dated = rows.filter((r) => r.date && r.status !== 'Upcoming').sort((a, b) => b.date.localeCompare(a.date));
  const last = dated[0]?.date || null;
  const age = last ? diffDays(today, last) : null;
  const sig = [...new Set(rows.flatMap(signalsOf))];
  let state = 'New';
  if (age !== null && age > 45) state = 'Dormant';
  else if (dated.length >= 3 && sig.length) state = 'Strong';
  else if (dated.length >= 2 || sig.length) state = 'Warm';
  return { state, last, age, interactions: dated.length, signals: sig };
}
