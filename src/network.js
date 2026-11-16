// Networking log: events and conversations kept in the Notion "Networking" database.
// /net records who was met and what comes next, /prep shows what to ask at the next event,
// /followups lists the conversations still waiting for a follow-up.
import { addDays, pretty, readDate } from './dates.js';
import { similarity } from './parse.js';
import { ownerContext } from './persona.js';
import { rank, signalsOf } from './priority.js';

const PLAYS = ['Thank-you note', 'Ask for intro', 'Reach out', 'Learn', 'Apply'];
const join = (old, add) => [old, add].filter((s) => s && String(s).trim()).join('\n').slice(0, 1900);

// The row a few words point at. Recent and upcoming rows only, best match above a floor.
export function matchEvent(text, rows, today) {
  const near = rows.filter((r) => !r.date || (r.date >= addDays(today, -3) && r.date <= addDays(today, 1)));
  const scored = near.map((r) => ({ r, s: Math.max(similarity(r.title, text), r.org ? similarity(r.org, text) : 0) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s);
  return scored[0]?.r || null;
}
// What to do after a conversation, from what was logged. Rules, so it works with no model.
export function nextMoves(row, T) {
  const out = [];
  if (row.people) out.push(T('Within 24h: thank-you message naming one specific thing you talked about.', 'Dalam 24 jam: kirim thank-you yang nyebut satu hal spesifik dari obrolan kalian.'));
  if (row.people) out.push(T('In that message ask: "Is there anyone else on the team I should speak to?" and "May I keep you posted?"', 'Di pesan itu tanya: "Is there anyone else on the team I should speak to?" dan "May I keep you posted?"'));
  if (!row.people) out.push(T('No names logged. Next time leave with one name and permission to follow up, or this stays a learning entry.', 'Belum ada nama yang dicatat. Lain kali pulang bawa minimal satu nama dan izin buat follow-up, kalau nggak ini cuma jadi catatan belajar.'));
  if (row.takeaways || !row.people) out.push(T('Pick one takeaway and turn it into a task with a date.', 'Pilih satu takeaway, jadiin task yang ada tanggalnya.'));
  out.push(T('If they introduce you to someone, tell them afterwards how it went.', 'Kalau dikenalin ke orang lain, kabarin lagi hasilnya ke yang ngenalin.'));
  return out;
}

export function createNetworking({ cfg, store, llm, say, btn, T, esc, now, fail }) {
  const ready = () => typeof store.networking === 'function' && store.networkingReady !== false;
  const off = () => say(T('Networking is not set up: add NOTION_NETWORKING_DS in the config vars and share the Networking database with the bot integration.', 'Networking belum diset: tambahin NOTION_NETWORKING_DS di config vars dan share database Networking ke integration bot.'));
  const when = (r) => (r.date ? pretty(r.date, r.time) : T('no date', 'tanpa tanggal'));

  async function log(text) {
    if (!ready()) return off();
    if (!text) return say(T('What happened? One message: the event, who you met (name, role), what you talked about, what comes next.', 'Ceritain dalam satu pesan: acaranya apa, ketemu siapa (nama, role), ngobrolin apa, next-nya apa.'), { forceReply: true, then: { type: 'net' } });
    const n = now();
    let rows;
    try { rows = await store.networking(); } catch (e) { return fail(e); }
    let f = { event: '', organisation: '', people: '', topics: text, takeaways: '', next_steps: '', follow_up_text: '', plays: [] };
    let modelDown = false;
    if (llm.enabled) {
      const open = rows.filter((r) => !r.date || (r.date >= addDays(n.date, -3) && r.date <= addDays(n.date, 1))).map((r) => r.title);
      try {
        const out = await llm.generate([{ text: `Today: ${n.date}. The owner logs a networking event or conversation. Extract JSON only:
{"event": the event or occasion name; if it is one of ${JSON.stringify(open)} copy that title exactly, "organisation": "", "people": "Name (role, organisation) — how they connected; one per line", "topics": what was discussed, "takeaways": lessons or frameworks worth keeping, "next_steps": what the owner said comes next, "follow_up_text": the exact date words for a follow-up or "", "plays": zero or more of ${JSON.stringify(PLAYS)}}
Use only what the message says. Leave a field "" when it is not there. Never invent a name, a role or a promise.
Message: ${text}` }], { json: true, system: 'You extract structured data. Output JSON only.' });
        if (out && typeof out === 'object' && !Array.isArray(out)) f = { ...f, ...Object.fromEntries(Object.entries(out).filter(([, v]) => v != null)) };
      } catch (e) { modelDown = true; }
    }
    const str = (v) => (Array.isArray(v) ? v.join('\n') : String(v || '')).trim();
    const hit = rows.find((r) => r.title === str(f.event)) || matchEvent(str(f.event) || text, rows, n.date);
    const follow = readDate(str(f.follow_up_text), n.date).date || addDays(n.date, 1);
    const plays = (Array.isArray(f.plays) ? f.plays : []).filter((p) => PLAYS.includes(p));
    const patch = { status: 'Attended', people: str(f.people), topics: str(f.topics), takeaways: str(f.takeaways), nextSteps: str(f.next_steps), followUp: follow };
    if (!plays.length && patch.people) plays.push('Thank-you note');
    let row;
    try {
      if (hit) row = await store.updateNet(hit.id, { ...patch, people: join(hit.people, patch.people), topics: join(hit.topics, patch.topics), takeaways: join(hit.takeaways, patch.takeaways), nextSteps: join(hit.nextSteps, patch.nextSteps), plays: [...new Set([...(hit.plays || []), ...plays])] });
      else row = await store.createNet({ title: (str(f.event) || text.split(/[.\n:]/)[0]).slice(0, 100), org: str(f.organisation), date: n.date, track: patch.people ? 'Networking' : 'Upskilling', plays, ...patch });
    } catch (e) { return fail(e); }
    const lines = [hit ? T(`Added to "${esc(row.title)}" in Notion:`, `Udah gue tambahin ke "${esc(row.title)}" di Notion:`) : T(`New networking entry "${esc(row.title)}" in Notion:`, `Entry networking baru "${esc(row.title)}" di Notion:`)];
    if (patch.people) lines.push(`• ${T('Met', 'Ketemu')}: ${esc(patch.people)}`);
    if (patch.topics) lines.push(`• ${T('Talked about', 'Bahasan')}: ${esc(patch.topics.slice(0, 300))}`);
    if (patch.takeaways) lines.push(`• Takeaways: ${esc(patch.takeaways.slice(0, 300))}`);
    if (patch.nextSteps) lines.push(`• ${T('Next', 'Next')}: ${esc(patch.nextSteps.slice(0, 300))}`);
    lines.push(`• ${T('Follow up by', 'Follow-up paling lambat')}: ${pretty(follow)}`);
    if (row.url) lines.push(`<a href="${row.url}">${T('Open in Notion', 'Buka di Notion')}</a>`);
    if (modelDown) lines.push('', T('The language model is not reachable, so the whole message went into "Topics": split it in Notion if you want.', 'Language model lagi nggak bisa diakses, jadi seluruh pesan masuk ke "Topics": pisahin di Notion kalau mau.'));
    lines.push('', `<b>${T('What to do next', 'Yang perlu lo lakuin')}</b>`, ...nextMoves({ ...row, ...patch }, T).map((x) => `• ${x}`));
    const buttons = [btn(T('Followed up ✓', 'Udah follow-up ✓'), { type: 'net_done', id: row.id, title: row.title })];
    if (llm.enabled && patch.people) buttons.unshift(btn(T('Draft the thank-you', 'Bikinin draft thank-you'), { type: 'net_thanks', id: row.id }));
    return say(lines.join('\n'), { buttons });
  }

  async function prep(query) {
    if (!ready()) return off();
    const n = now();
    let rows;
    try { rows = await store.networking(); } catch (e) { return fail(e); }
    const upcoming = rows.filter((r) => r.status === 'Upcoming' && r.date && r.date >= n.date).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    let picks;
    if (query) {
      picks = upcoming.map((r) => ({ r, s: Math.max(similarity(r.title, query), r.org ? similarity(r.org, query) : 0) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 1).map((x) => x.r);
      if (!picks.length) return say(T(`No upcoming event matches "${esc(query)}". /prep alone shows the next ones.`, `Nggak ada acara mendatang yang cocok sama "${esc(query)}". /prep aja buat liat yang terdekat.`));
    } else {
      const day = upcoming[0]?.date;
      picks = upcoming.filter((r) => r.date === day).slice(0, 4); // every event on the next event day
      if (!picks.length) return say(T('No upcoming events in the Networking database.', 'Nggak ada acara mendatang di database Networking.'));
    }
    for (const r of picks) {
      const body = r.prep ? esc(r.prep) : T('No prep written yet.', 'Belum ada prep.');
      const buttons = llm.enabled ? [btn(T('More questions to ask', 'Tambah pertanyaan'), { type: 'net_ask', id: r.id })] : [];
      await say(`<b>${esc(r.title)}</b>\n${when(r)}${r.org ? ` · ${esc(r.org)}` : ''}\n\n${body}`, { buttons });
    }
  }

  // The few conversations that need attention now, most valuable first, each with the reason.
  async function followups() {
    if (!ready()) return off();
    const n = now();
    let rows;
    try { rows = await store.networking(); } catch (e) { return fail(e); }
    const waiting = rows.filter((r) => r.status === 'Attended');
    if (!waiting.length) return say(T('Nothing waiting for a follow-up.', 'Nggak ada yang nunggu follow-up.'));
    const ranked = rank({ net: waiting, today: n.date }, { horizon: 365 }).filter((x) => x.kind === 'net');
    const byId = new Map(waiting.map((r) => [r.id, r]));
    const top = ranked.slice(0, 5);
    const lines = [`<b>${T('Waiting for a follow-up', 'Nunggu follow-up')} (${waiting.length})</b>`];
    for (const x of top) {
      const r = byId.get(x.id);
      lines.push('', `<b>${esc((r.people.split('\n')[0] || r.title).slice(0, 80))}</b>`, `${T('Why now', 'Kenapa sekarang')}: ${esc(x.why)}`);
      if (r.topics) lines.push(`${T('You discussed', 'Bahasan')}: ${esc(r.topics.split('\n')[0].slice(0, 160))}`);
      lines.push(`${T('Do', 'Lakuin')}: ${esc(r.nextSteps ? r.nextSteps.split('\n')[0].slice(0, 160) : r.people ? (r.plays[0] || 'Thank-you note') : T('turn one takeaway into a task', 'jadiin satu takeaway task'))}`);
    }
    if (waiting.length > top.length) lines.push('', T(`${waiting.length - top.length} more are lower priority.`, `${waiting.length - top.length} lagi prioritasnya lebih rendah.`));
    const buttons = top.slice(0, 4).map((x) => btn(`✓ ${byId.get(x.id).title.slice(0, 36)}`, { type: 'net_done', id: x.id, title: byId.get(x.id).title }));
    if (llm.enabled && top[0] && byId.get(top[0].id).people) buttons.unshift(btn(T('Draft the first message', 'Bikinin draft pesan pertama'), { type: 'net_thanks', id: top[0].id }));
    return say(lines.join('\n'), { buttons });
  }

  // Button actions. Returns undefined for actions that are not ours.
  async function onAction(a) {
    if (a.type === 'net_done') { await store.updateNet(a.id, { status: 'Followed up' }); return say(T(`"${esc(a.title)}" marked as followed up.`, `"${esc(a.title)}" ditandain udah follow-up.`)); }
    if (a.type !== 'net_thanks' && a.type !== 'net_ask') return undefined;
    const row = (await store.networking()).find((r) => r.id === a.id);
    if (!row) return say(T('That entry is no longer open.', 'Entry itu udah nggak ada.'));
    const me = ownerContext(cfg);
    try {
      if (a.type === 'net_thanks') {
        const out = await llm.generate([{ text: `${me}Write a short thank-you message (LinkedIn or email, under 90 words, plain English, no flattery) from the owner to the person below. Mention one or two specific things from the conversation, ask whether there is anyone else worth speaking to, and ask whether the owner may keep them posted. Use only these notes; if a detail is missing, leave a [bracket] for the owner to fill.
Event: ${row.title}
People: ${row.people}
Talked about: ${row.topics}
Next: ${row.nextSteps}` }], { system: 'You draft short professional messages. Output the message only.' });
        return say(`<b>${T('Draft, edit before sending', 'Draft, edit dulu sebelum kirim')}</b>\n\n${esc(out)}`);
      }
      const out = await llm.generate([{ text: `${me}The owner goes to this event and wants five good questions to ask people there. Natural conversation openers that follow from the person's own story work better than scripted questions; include two of those and three about the organisation or field. One line each, no preamble. Use only the details given; do not state facts about the organisation.
Event: ${row.title}
Organisation: ${row.org}
Existing prep: ${row.prep}` }], { system: 'You help prepare for professional networking. Output a plain list.' });
      return say(`<b>${T('Questions for', 'Pertanyaan buat')} ${esc(row.title)}</b>\n${esc(out)}`);
    } catch (e) { return fail(e); }
  }

  return { log, prep, followups, onAction };
}

// One digest line per conversation whose follow-up date has arrived.
export function followUpLines(rows, today) {
  return (rows || []).filter((r) => r.status === 'Attended' && r.followUp && r.followUp <= today)
    .sort((a, b) => a.followUp.localeCompare(b.followUp)).map((r) => ({ title: r.title, late: r.followUp < today }));
}
