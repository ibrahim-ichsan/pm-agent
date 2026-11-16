// Career views that read across Applications, Networking, Tasks and the calendar:
// /career (what to do now), /app <name> (one application with checks), /people <name> (one relationship).
import { pretty, addDays } from './dates.js';
import { rank, appChecks, contactsAt, relationship, signalsOf, isWaiting } from './priority.js';
import { resolveApp, similarity } from './parse.js';

const SECTION = /(urgent|mendesak|important|penting)/gi;
const STATUS = [
  ['Rejected', /\b(rejected|reject|rejection|ditolak|tolak|gagal|unsuccessful|not accepted|(?:ga|gak|nggak|ngga|enggak|tidak|tdk)\s*k?\s*diterima|gaditerima)\b/i],
  ['Withdrawn', /\b(withdrawn|withdrew|withdraw|mundur)\b/i],
  ['waiting', /\b(nunggu|menunggu|tunggu|waiting|wait|pending|done|completed|submitted|selesai|kelar|udah\s+(?:gw\s+|gue\s+|aku\s+|saya\s+)?(?:lakuin|kerjain|dikerjain|submit)|sudah\s+(?:di)?kerjakan)\b/i],
];
// "Urgent 1,2,3 rejected. Urgent 4 and everything in Important done, waiting" -> [{ section, index|all, status }]
export function parseListReply(text) {
  const out = [];
  for (const clause of text.split(/[.;\n]+/)) {
    const status = (STATUS.find(([, re]) => re.test(clause)) || [])[0];
    const marks = [...clause.matchAll(SECTION)];
    if (!status || !marks.length) continue;
    marks.forEach((m, i) => {
      const section = /urgent|mendesak/i.test(m[0]) ? 'urgent' : 'important';
      const after = clause.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : clause.length);
      const nums = [];
      // Numbers count only while they directly follow the section word: "Urgent 1, 2 and 4", "urgent 1-3".
      const lead = (after.match(/^[\s:#]*((?:\d+\s*(?:[-–]\s*\d+)?\s*(?:,|&|\+|dan|and|sama)?\s*)+)/i) || [])[1] || '';
      for (const part of lead.matchAll(/(\d+)\s*(?:[-–]\s*(\d+))?/g)) { const a = Number(part[1]); const b = Number(part[2] || part[1]); for (let k = a; k <= b && k < a + 20; k++) nums.push(k); }
      if (nums.length) for (const k of nums) out.push({ section, index: k - 1, status });
      else out.push({ section, all: true, status });
    });
  }
  return out;
}

export function createCareer({ cfg, store, say, btn, T, esc, now, fail, gather }) {
  let last = null; // the list shown by the latest /career, so a reply can point at "urgent 2"
  async function career() {
    const n = now();
    let d;
    try { d = await gather(n.date, addDays(n.date, 8)); } catch (e) { return fail(e); }
    const all = rank({ ...d, today: n.date, idleDays: cfg.followUpIdleDays }, { scope: 'career', horizon: 7 });
    const urgent = all.filter((x) => x.score >= 90).slice(0, 5);
    const important = all.filter((x) => x.score >= 40 && x.score < 90).slice(0, 5);
    const waiting = d.apps.filter(isWaiting);
    last = { urgent, important, at: Date.now() };
    // Things that look like work but can wait: undated job-search tasks and quiet lower-tier applications.
    const wait = [
      ...d.tasks.filter((t) => t.area === 'Job search' && !t.due && t.priority !== 'Must').slice(0, 2).map((t) => `${esc(t.title)} — ${T('no date, not a Must', 'tanpa tanggal, bukan Must')}`),
      ...d.apps.filter((a) => a.tier === 'Tier 3' && a.stage === 'Applied' && !a.due).slice(0, 2).map((a) => `${esc(a.title)} — ${T('Tier 3, nothing to act on', 'Tier 3, nggak ada yang bisa dikerjain')}`),
    ];
    const lines = [`<b>${T('Career priorities', 'Prioritas karier')}</b>`];
    const sec = (title, items) => { if (items.length) lines.push('', `<b>${title}</b>`, ...items.map((x, i) => `${i + 1}. ${esc(x.title)}\n   ${T('Why', 'Kenapa')}: ${esc(x.why)}`)); };
    sec(T('Urgent', 'Mendesak'), urgent);
    sec(T('Important', 'Penting'), important);
    if (wait.length) lines.push('', `<b>${T('Can wait: skip these this week', 'Bisa nunggu: lewatin minggu ini')}</b>`, ...wait.map((w) => `• ${w}`));
    if (!urgent.length && !important.length) lines.push('', T('Nothing career-related needs action in the next 7 days. Use the time for coursework or one outreach message.', 'Nggak ada urusan karier yang perlu dikerjain 7 hari ke depan. Pake waktunya buat kuliah atau satu pesan outreach.'));
    if (waiting.length) lines.push('', T(`Waiting on a result: ${waiting.length} application${waiting.length > 1 ? 's' : ''}. Nothing to do on those.`, `Lagi nunggu hasil: ${waiting.length} lamaran. Nggak ada yang perlu dikerjain.`));
    if (urgent.length || important.length) lines.push('', T('Already dealt with some? Tell me in plain words, e.g. "urgent 1 and 2 rejected, important all done, waiting".', 'Udah ada yang beres? Bilang aja, misal "urgent 1 sama 2 ditolak, important semua udah, tinggal nunggu".'));
    lines.push('', T('Ranked by rule: deadlines, stage, tier, follow-up dates, people you know. /app company for detail.', 'Diurutin pake aturan: deadline, stage, tier, tanggal follow-up, orang yang lo kenal. /app company buat detail.'));
    return say(lines.join('\n'));
  }

  // A reply that points at the last /career list. Returns false when the message is not one.
  async function refer(text) {
    if (!last || Date.now() - last.at > 6 * 3600 * 1000) return false;
    const refs = parseListReply(text);
    if (!refs.length) return false;
    const items = []; const seen = new Set();
    for (const r of refs) {
      const list = last[r.section] || [];
      for (const x of r.all ? list : [list[r.index]].filter(Boolean)) {
        if (seen.has(x.id)) continue; seen.add(x.id);
        if (x.kind === 'app') items.push({ kind: 'app', id: x.id, title: x.title, op: r.status });
        else if (r.status === 'waiting' && x.kind === 'task') items.push({ kind: 'task', id: x.id, title: x.title, op: 'done' });
        else if (r.status === 'waiting' && x.kind === 'net') items.push({ kind: 'net', id: x.id, title: x.title, op: 'followed' });
      }
    }
    if (!items.length) return say(T('Those numbers are not on the last /career list. Send /career again and point at that one.', 'Nomor itu nggak ada di daftar /career terakhir. Kirim /career lagi, terus tunjuk dari situ.'));
    const label = (x) => (x.op === 'waiting' ? T('done, waiting for the result', 'udah, tinggal nunggu hasil') : x.op === 'done' ? T('mark Done', 'tandain Done') : x.op === 'followed' ? T('mark as followed up', 'tandain udah follow-up') : `→ ${x.op}`);
    return say([T(`Update these ${items.length}?`, `Update ${items.length} ini?`), ...items.map((x) => `• ${esc(x.title)}: ${label(x)}`), '', T('Waiting ones leave the priority lists until they have been quiet for 14 days.', 'Yang nunggu hasil keluar dari daftar prioritas sampai 14 hari nggak ada kabar.')].join('\n'),
      { buttons: [btn(T(`Confirm all ${items.length}`, `Konfirmasi ${items.length}-nya`), { type: 'career_apply', items }), btn(T('Cancel', 'Batal'), { type: 'cancel' })] });
  }
  async function apply(items) {
    const n = now(); const ok = []; const bad = [];
    for (const x of items) {
      try {
        if (x.kind === 'app' && x.op === 'waiting') await store.updateApp(x.id, { nextAction: 'Waiting for result', lastUpdate: n.date });
        else if (x.kind === 'app') await store.updateApp(x.id, { stage: x.op, lastUpdate: n.date, followUp: null });
        else if (x.kind === 'task') await store.updateTask(x.id, { status: 'Done' });
        else await store.updateNet(x.id, { status: 'Followed up' });
        ok.push(x);
      } catch (e) { bad.push(x); }
    }
    last = null;
    const lines = [T(`Updated ${ok.length} of ${items.length} in Notion.`, `${ok.length} dari ${items.length} udah keupdate di Notion.`)];
    if (bad.length) lines.push(T('Failed, tell me again:', 'Gagal, bilang lagi:'), ...bad.map((x) => `• ${esc(x.title)}`));
    lines.push(T('/career shows the list without them.', '/career sekarang nampilin daftar tanpa itu.'));
    return say(lines.join('\n'));
  }

  async function appDetail(q) {
    if (!q) return say(T('Usage: /app bny', 'Cara pakai: /app bny'));
    const n = now();
    let apps; let d;
    try { apps = await store.allApps(); d = await gather(n.date, addDays(n.date, 4)); } catch (e) { return fail(e); }
    const r = resolveApp(q, apps);
    if (r.none) return say(T(`No application matches "${esc(q)}".`, `Nggak ada lamaran yang cocok sama "${esc(q)}".`));
    if (r.choices) return say(T(`Which one is "${esc(q)}"?`, `"${esc(q)}" itu yang mana?`), { buttons: r.choices.map((a) => btn(a.title.slice(0, 50), { type: 'app_show', q: a.title })) });
    const a = r.app;
    const row = (label, v) => (v ? `• ${label}: ${esc(v)}` : null);
    const lines = [`<b>${esc(a.title)}</b>`,
      row('Stage', a.stage), row('Tier', [a.tier, a.socTier ? `SOC ${a.socTier}` : ''].filter(Boolean).join(' · ')), row('Track', a.track), row(T('Location', 'Lokasi'), a.location),
      row(T('Applied', 'Apply'), a.appliedOn && pretty(a.appliedOn)), row('Deadline', a.due && pretty(a.due, a.time)), row(T('Last update', 'Update terakhir'), a.lastUpdate && pretty(a.lastUpdate)),
      row(T('Next follow-up', 'Follow-up berikutnya'), a.followUp && pretty(a.followUp)), row(T('Next action', 'Next action'), a.nextAction), row(T('Referral contact', 'Kontak referral'), a.referral),
      row('CV', a.cvVersion), row(T('Notes', 'Catatan'), a.notes && a.notes.slice(0, 400))].filter(Boolean);
    const known = contactsAt(a.company, d.net);
    if (known.length) lines.push('', `<b>${T('Networking at this company', 'Networking di perusahaan ini')}</b>`, ...known.slice(0, 3).map((k) => `• ${esc((k.people.split('\n')[0] || k.title).slice(0, 80))} — ${esc(k.title)}${k.date ? `, ${pretty(k.date)}` : ''}`));
    const checks = appChecks(a, { ...d, today: n.date, idleDays: cfg.followUpIdleDays }).filter((c) => !c.startsWith('You know someone'));
    if (checks.length) lines.push('', `<b>${T('Worth a look', 'Perlu dicek')}</b>`, ...checks.map((c) => `• ${esc(c)}`));
    if (a.jobUrl) lines.push('', `<a href="${a.jobUrl}">${T('Job posting', 'Link lowongan')}</a>`);
    const buttons = [];
    if (['Interview', 'Online test'].includes(a.stage) && checks.some((c) => /no prep task|no task for it/.test(c))) buttons.push(btn(T('Create a prep task', 'Bikin task prep'), { type: 'make_task', title: `Prepare ${a.company || a.title} ${a.stage.toLowerCase()}`, due: a.due }));
    return say(lines.join('\n'), { buttons });
  }

  async function people(q) {
    if (!q) return say(T('Usage: /people sarah', 'Cara pakai: /people sarah'));
    if (!store.allNetworking) return say(T('Networking is not set up.', 'Networking belum diset.'));
    const n = now();
    let rows;
    try { rows = await store.allNetworking(); } catch (e) { return fail(e); }
    const needle = q.toLowerCase();
    const hits = rows.filter((r) => r.people.toLowerCase().includes(needle) || (r.people && similarity(q, r.people) >= 0.8));
    if (!hits.length) return say(T(`Nobody called "${esc(q)}" in the Networking log. /net records a conversation.`, `Nggak ada "${esc(q)}" di log Networking. /net buat nyatet obrolan.`));
    const line = (r) => r.people.split('\n').find((l) => l.toLowerCase().includes(needle)) || r.people.split('\n')[0];
    const rel = relationship(hits, n.date);
    hits.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const latest = hits[0];
    const lines = [`<b>${esc(line(latest).slice(0, 120))}</b>`,
      `• ${T('Relationship', 'Relasi')}: ${rel.state} (${rel.interactions} ${T('logged', 'tercatat')}${rel.last ? `, ${T('last', 'terakhir')} ${pretty(rel.last)}` : ''})`,
      ...(rel.signals.length ? [`• ${T('Signals', 'Sinyal')}: ${rel.signals.join(', ')}`] : []),
      '', `<b>${T('Where you met and what you discussed', 'Ketemu di mana dan ngobrolin apa')}</b>`,
      ...hits.slice(0, 4).map((r) => `• ${esc(r.title)}${r.date ? ` (${pretty(r.date)})` : ''}${r.topics ? `: ${esc(r.topics.split('\n')[0].slice(0, 180))}` : ''}`)];
    if (latest.nextSteps) lines.push('', `<b>${T('Current next step', 'Next step sekarang')}</b>`, esc(latest.nextSteps.slice(0, 300)));
    const play = latest.status === 'Attended' ? (latest.plays[0] || 'Thank-you note') : rel.state === 'Dormant' ? T('Reach out with a real update (interview, offer, something you built). No "just checking in".', 'Hubungi lagi pake kabar nyata (interview, offer, sesuatu yang lo bikin). Jangan "just checking in".') : rel.signals.includes('referral offered') ? T('Ask for the referral when a role at their company is open.', 'Minta referral-nya pas ada role yang buka di perusahaan mereka.') : T('Nothing owed. Update them when you have real progress.', 'Nggak ada utang. Kabarin kalau ada progres nyata.');
    lines.push('', `<b>${T('Suggested next play', 'Saran langkah berikutnya')}</b>`, esc(play));
    lines.push('', T('State is worked out from the log each time (recency, number of conversations, offers mentioned), not stored.', 'Status relasi dihitung dari log tiap kali (kapan terakhir, berapa kali ngobrol, tawaran yang disebut), nggak disimpen.'));
    return say(lines.join('\n'));
  }

  return { career, appDetail, people, refer, apply, signalsOf };
}
