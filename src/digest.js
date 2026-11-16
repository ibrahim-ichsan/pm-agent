// Morning digest and the midweek and weekly reviews. Pure: data in, text and buttons out.
import { topPriorities, rank } from './priority.js';
import { addDays, diffDays, mondayOf, pretty } from './dates.js';
import { flavour } from './persona.js';
import { explain } from './explain.js';

const MAX = 10;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const L = (lang, en, id) => (lang === 'id' ? id : en);

function block(title, lines, lang) {
  if (!lines.length) return null;
  const shown = lines.slice(0, MAX);
  if (lines.length > MAX) shown.push(L(lang, `…and ${lines.length - MAX} more`, `…dan ${lines.length - MAX} lagi`));
  return `<b>${title}</b>\n${shown.join('\n')}`;
}

export function parsePlan(plan) { try { const p = JSON.parse(plan || ''); return Array.isArray(p.milestones) ? p : null; } catch { return null; } }
export const agreedPlan = (plan) => { const p = parsePlan(plan); return p && p.status === 'agreed' ? p : null; };

// Applications split in two: "dated" has a deadline or a follow-up date inside the next week and is worth a line each;
// "stale" is everything in Applied that has gone quiet, which the digest only counts.
export function appsNeedingAttention(apps, today, idleDays = 14) {
  const dated = []; const stale = [];
  for (const a of apps) {
    const reasons = [];
    if (a.due && diffDays(a.due, today) >= 0 && diffDays(a.due, today) <= 7) reasons.push({ sort: a.due, text: `deadline ${pretty(a.due)}` });
    if (a.followUp && diffDays(a.followUp, today) <= 7 && diffDays(a.followUp, today) >= -7) reasons.push({ sort: a.followUp, text: `follow up ${pretty(a.followUp)}` });
    if (reasons.length) { dated.push({ a, sort: reasons.map((r) => r.sort).sort()[0], text: reasons.map((r) => r.text).join('; ') }); continue; }
    const since = a.lastUpdate || a.appliedOn;
    if (a.stage === 'Applied' && since && diffDays(today, since) >= idleDays) stale.push({ a, days: diffDays(today, since) });
  }
  dated.sort((x, y) => x.sort.localeCompare(y.sort));
  stale.sort((x, y) => y.days - x.days);
  return { dated, stale };
}

export function buildDigest(d) {
  const { today, lang = 'en', seed = 0 } = d;
  const blocks = []; const buttons = [];
  // Today
  const todays = d.events.filter((e) => e.date === today || (e.allDay && e.date <= today && e.endDate > today))
    .sort((a, b) => (a.allDay ? '0' : '1' + a.start).localeCompare(b.allDay ? '0' : '1' + b.start)); // all-day first
  const evLines = todays.map((e) => `• ${e.allDay ? L(lang, 'All day', 'Seharian') : `${e.start}–${e.end}`} ${esc(e.title)}`);
  blocks.push(block(L(lang, 'Today', 'Hari ini'), evLines, lang));
  // Due: overdue first (oldest first), then today
  const due = d.tasks.filter((t) => t.due && t.due <= today).sort((a, b) => (a.due + (a.time || '')).localeCompare(b.due + (b.time || '')));
  const overdue = due.filter((t) => t.due < today);
  const dueLines = due.map((t) => {
    const late = diffDays(today, t.due);
    return `• ${esc(t.title)} — ${late > 0 ? L(lang, `${late} day${late > 1 ? 's' : ''} late`, `telat ${late} hari`) : L(lang, `today${t.time ? ' ' + t.time : ''}`, `hari ini${t.time ? ' ' + t.time : ''}`)}`;
  });
  let dueBlock = block(L(lang, 'Due', 'Deadline'), dueLines, lang);
  if (dueBlock && overdue.length) dueBlock = `${flavour(lang, 'overdue', seed, { n: overdue.length })}\n${dueBlock}`;
  blocks.push(dueBlock);
  // Roadmap this week
  const mon = mondayOf(today); const sun = addDays(mon, 6);
  const road = d.roadmap.filter((r) => r.week && r.week >= mon && r.week <= sun && r.status !== 'Done');
  blocks.push(block(L(lang, "This week's roadmap", 'Roadmap minggu ini'), road.map((r) => `• ${esc(r.title)}${r.priority ? ` (${r.priority})` : ''}`), lang));
  // Applications
  if (d.followUps?.length) blocks.push(block(L(lang, 'Networking follow-ups', 'Follow-up networking'), d.followUps.map((f) => `• ${esc(f.title)}${f.late ? L(lang, ' (late)', ' (telat)') : ''}`).concat(L(lang, '/followups to tick them off', '/followups buat nyentang')), lang));
  const att = appsNeedingAttention(d.apps, today, d.idleDays);
  const appLines = att.dated.slice(0, 5).map((x) => `• ${esc(x.a.title)}: ${x.text}`);
  if (att.dated.length > 5) appLines.push(L(lang, `…and ${att.dated.length - 5} more with a date this week`, `…dan ${att.dated.length - 5} lagi yang ada tanggalnya minggu ini`));
  if (att.stale.length) appLines.push(L(lang, `• ${att.stale.length} with no news for ${d.idleDays || 14}+ days (oldest: ${esc(att.stale[0].a.company || att.stale[0].a.title)}, ${att.stale[0].days} days). /apps stale`, `• ${att.stale.length} tanpa kabar ${d.idleDays || 14}+ hari (paling lama: ${esc(att.stale[0].a.company || att.stale[0].a.title)}, ${att.stale[0].days} hari). /apps stale`));
  blocks.push(block(L(lang, 'Applications', 'Lamaran kerja'), appLines, lang));

  const present = blocks.filter(Boolean);
  const lines = [];
  const load = due.length + todays.length + road.length;
  if (!present.length) {
    lines.push(L(lang, `${pretty(today)}: nothing scheduled and nothing due.`, `${pretty(today)}: nggak ada jadwal dan nggak ada deadline.`));
    const heads = headsUp(d, today);
    if (heads.length) lines.push(L(lang, 'Heads-up for the next month, worth starting early:', 'Buat sebulan ke depan, mending dicicil dari sekarang:'), ...heads);
  } else {
    lines.push(`<b>${pretty(today)}</b>`);
    const ranked = topPriorities(d, (en, id) => L(lang, en, id));
    if (ranked) lines.push('', ranked, '');
    if (load >= 8) {
      lines.push(flavour(lang, 'busy', seed));
      const top = [...overdue, ...due.filter((t) => t.due === today)].sort(byPriority).slice(0, 3);
      if (top.length && !ranked) lines.push(L(lang, 'Top three: ', 'Tiga teratas: ') + top.map((t) => esc(t.title)).join(', '));
    } else if (load <= 2) lines.push(flavour(lang, 'light', seed));
    lines.push('', present.join('\n\n'));
  }
  // Calendar could not be read: say so with the fix (Table B row 6).
  for (const f of d.calFailures || []) lines.push('', '📅 ' + explain(f.error, lang, { calendarId: f.id, saEmail: d.saEmail }));
  // Plans agreed but not on the calendar yet (Table B row 1).
  for (const t of d.tasks) {
    const p = agreedPlan(t.plan);
    if (p && p.milestones.length && !t.calendarEvents) {
      lines.push('', L(lang, `🗓 The plan for "${esc(t.title)}" is not on your calendar yet.`, `🗓 Plan "${esc(t.title)}" belum masuk kalender.`));
      buttons.push({ text: L(lang, `Add plan to calendar: ${t.title.slice(0, 20)}`, `Masukin kalender: ${t.title.slice(0, 20)}`), action: { type: 'plan_to_cal', taskId: t.id } });
    }
  }
  if (d.usageWarning) lines.push('', d.usageWarning);
  return { text: lines.join('\n').trim(), buttons };
}

const PRI = { Must: 0, Should: 1, Stretch: 2 };
const byPriority = (a, b) => (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1) || (a.due || '').localeCompare(b.due || '');

function headsUp(d, today) {
  const end = addDays(today, 30);
  const heavy = d.tasks.filter((t) => t.due && t.due > today && t.due <= end && (t.priority === 'Must' || t.area === 'Coursework' || parsePlan(t.plan)))
    .map((t) => ({ date: t.due, text: `• ${pretty(t.due)}: ${esc(t.title)}` }));
  const apps = d.apps.filter((a) => a.due && a.due > today && a.due <= end).map((a) => ({ date: a.due, text: `• ${pretty(a.due)}: ${esc(a.title)} (deadline)` }));
  return [...heavy, ...apps].sort((a, b) => a.date.localeCompare(b.date)).slice(0, MAX).map((x) => x.text);
}

// Midweek (Wednesday) and weekly (Sunday) reviews.
export function buildReview(kind, d) {
  const { today, lang = 'en' } = d;
  const mon = mondayOf(today);
  const nextEnd = addDays(today, 7);
  const lines = [`<b>${kind === 'weekly' ? L(lang, 'Weekly review', 'Review mingguan') : L(lang, 'Midweek check', 'Cek tengah minggu')} · ${pretty(today)}</b>`];
  const done = d.doneThisWeek || [];
  lines.push(L(lang, `Done since Monday: ${done.length}`, `Kelar sejak Senin: ${done.length}`) + (done.length ? `\n${done.slice(0, MAX).map((t) => `• ${esc(t.title)}`).join('\n')}` : ''));
  const slipped = d.tasks.filter((t) => t.due && t.due < today);
  if (slipped.length) lines.push(`${flavour(lang, 'overdue', d.seed || 0, { n: slipped.length })}\n${slipped.slice(0, MAX).map((t) => `• ${esc(t.title)} (${pretty(t.due)})`).join('\n')}`);
  const rest = kind === 'weekly' ? addDays(today, 7) : addDays(mon, 6);
  const ahead = d.tasks.filter((t) => t.due && t.due >= today && t.due <= rest).sort((a, b) => a.due.localeCompare(b.due));
  lines.push(`<b>${kind === 'weekly' ? L(lang, 'Next 7 days', '7 hari ke depan') : L(lang, 'Rest of this week', 'Sisa minggu ini')}</b>\n${ahead.length ? ahead.slice(0, MAX).map((t) => `• ${pretty(t.due)}: ${esc(t.title)}`).join('\n') : L(lang, 'Nothing dated.', 'Belum ada yang bertanggal.')}`);
  const road = d.roadmap.filter((r) => r.week && r.week >= mon && r.week <= addDays(mon, 6) && r.status !== 'Done');
  if (road.length) lines.push(`<b>${L(lang, 'Roadmap still open this week', 'Roadmap minggu ini yang belum kelar')}</b>\n${road.map((r) => `• ${esc(r.title)}`).join('\n')}`);
  const counts = {};
  for (const a of d.apps) counts[a.stage] = (counts[a.stage] || 0) + 1;
  const pipeline = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (pipeline) lines.push(`<b>${L(lang, 'Applications open', 'Lamaran aktif')}</b>\n${pipeline}`);
  const soon = d.apps.filter((a) => a.due && a.due >= today && a.due <= nextEnd);
  if (soon.length) lines.push(soon.map((a) => `• ${pretty(a.due)}: ${esc(a.title)}`).join('\n'));
  const active = d.apps.filter((a) => ['Interview', 'Online test'].includes(a.stage) || (a.lastUpdate && a.lastUpdate >= mon && a.tier !== 'Tier 3'));
  if (active.length) lines.push(`<b>${L(lang, 'Applications that moved or are live', 'Lamaran yang gerak atau lagi jalan')}</b>\n${active.slice(0, MAX).map((a) => `• ${esc(a.title)} · ${a.stage}${a.tier ? ` · ${a.tier}` : ''}`).join('\n')}`);
  const net = d.net || [];
  const owed = net.filter((r) => r.status === 'Attended');
  if (owed.length) lines.push(`<b>${L(lang, 'Networking follow-ups open', 'Follow-up networking yang masih buka')}</b>\n${owed.slice(0, MAX).map((r) => `• ${esc((r.people.split('\n')[0] || r.title).slice(0, 70))}${r.followUp ? ` (${pretty(r.followUp)})` : ''}`).join('\n')}`);
  const next = rank({ ...d, today }, { horizon: 7 }).slice(0, 3);
  if (next.length) lines.push(`<b>${L(lang, 'What matters next', 'Yang penting berikutnya')}</b>\n${next.map((x, i) => `${i + 1}. ${esc(x.title)} — ${esc(x.why)}`).join('\n')}`);
  return lines.join('\n\n');
}
