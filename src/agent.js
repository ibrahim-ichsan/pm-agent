// The conversation logic: commands, capture (Table A), buttons and confirmations (Table D).
// Every outside service is injected, so tests run against fakes.
import { parts, pretty, addDays, readDate, mondayOf, weekdayOf } from './dates.js';
import { PARSE_PROMPT, normaliseIntent, parseCommand, detectLang, bestMatches, localIntent, quickAppUpdates, resolveApp } from './parse.js';
import { STAGES } from './notion.js';
import { explain } from './explain.js';
import { usageNote } from './llm.js';
import { buildDigest, buildReview, parsePlan, agreedPlan, appsNeedingAttention } from './digest.js';
import { readCalendars } from './calendar.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const UNDO_MS = 10 * 60 * 1000;
const FOLLOW_UP_DAYS = { Applied: 14, 'Online test': 7, Interview: 7, Wishlist: null, Offer: 3, Rejected: null, Withdrawn: null };

export function createAgent({ cfg, store, cal, llm, tg, clock = () => new Date(), log = console }) {
  const actions = new Map(); // short id -> { action, at }
  const pending = new Map(); // bot message id -> what a reply to it means
  let seq = 0;
  let lastFailed = null;
  let langMode = null; // 'auto' | 'en' | 'id'
  let lastLang = 'en';

  const now = () => parts(clock());
  const chat = () => cfg.ownerId;

  async function mode() {
    if (langMode) return langMode;
    try { langMode = (await store.getState('lang')) || 'auto'; } catch { langMode = 'auto'; }
    return langMode;
  }
  async function langFor(text) {
    const m = await mode();
    lastLang = m === 'auto' ? (text ? detectLang(text) : lastLang) : m;
    return lastLang;
  }
  const T = (en, id) => (lastLang === 'id' ? id : en);

  function act(action) {
    const id = (++seq).toString(36);
    actions.set(id, { action, at: clock().getTime() });
    if (actions.size > 500) actions.delete(actions.keys().next().value);
    return id;
  }
  const btn = (text, action) => ({ text, data: act(action) });
  async function say(text, { buttons = [], forceReply = false, then } = {}) {
    const rows = buttons.map((b) => [b]);
    const msg = await tg.send(chat(), text, { buttons: rows, forceReply });
    if (then && msg) pending.set(msg.message_id, then);
    return msg;
  }
  async function fail(err, ctx) { log.error?.(err); await say(explain(err, lastLang, ctx)); }

  // ---------- entry points
  async function handleUpdate(u) {
    try { await route(u); }
    catch (e) { log.error?.(e); try { await say(explain(e, lastLang)); } catch { /* Telegram itself is down */ } }
  }
  async function route(u) {
    const from = u.message?.from || u.callback_query?.from;
    if (!from) return;
    if (from.id !== cfg.ownerId) { log.warn?.(`ignored message from user ${from.id}`); return; } // AG-06
    if (u.callback_query) return handleCallback(u.callback_query);
    const m = u.message;
    const text = (m.text || m.caption || '').trim();
    await langFor(text);
    const replyTo = m.reply_to_message?.message_id;
    if (replyTo && pending.has(replyTo)) { const p = pending.get(replyTo); pending.delete(replyTo); return handleReply(p, m, text); }
    if (m.document) return say(T('Reply to my brief request with the file, so I know which task it belongs to.', 'Reply ke pesan gue yang minta brief, biar gue tau file ini buat task yang mana.'));
    if (!text) return;
    tg.typing?.(chat());
    const c = parseCommand(text);
    if (c) return handleCommand(c.cmd, c.arg);
    const lm = text.match(/^(?:please\s+)?(?:reply|answer|talk|speak)\s+in\s+(english|indonesian|bahasa)|^(?:pake|pakai|ganti)\s+bahasa\s+(inggris|indo(?:nesia)?)/i);
    if (lm) return setLang(/english|inggris/i.test(lm[0]) ? 'en' : 'id');
    return capture(text);
  }

  async function handleCommand(cmd, arg) {
    switch (cmd) {
      case 'start': case 'help': return say(HELP[lastLang] || HELP.en);
      case 'add': return arg ? capture(arg, { force: 'task' }) : say(T('Usage: /add buy printer paper friday', 'Cara pakai: /add beli kertas printer jumat'));
      case 'today': return sendDigest({ manual: true });
      case 'week': return sendWeek();
      case 'tasks': return listTasks();
      case 'apps': return /^(stale|basi|lama)/i.test(arg) ? listStale() : listApps();
      case 'done': return pickDone();
      case 'plan': return startPlan(arg);
      case 'brief': return startBrief(arg);
      case 'shift': return logShift(arg);
      case 'usage': return say(llm.enabled ? usageNote(llm.usage(), lastLang) + (llm.model() ? `\nModel: ${llm.model()}` : '') : T('No language model key is set, so only commands and simple capture work.', 'Belum ada key model, jadi cuma command sama capture sederhana yang jalan.'));
      case 'lang': return setLang(['en', 'id', 'auto'].includes(arg) ? arg : null);
      case 'retry': return lastFailed ? capture(lastFailed) : say(T('Nothing to retry.', 'Nggak ada yang perlu diulang.'));
      default: return say(T('Unknown command. /help lists them.', 'Command nggak dikenal. Cek /help.'));
    }
  }

  async function setLang(m) {
    if (!m) return say('Usage: /lang en | id | auto');
    langMode = m; lastLang = m === 'auto' ? lastLang : m;
    try { await store.setState('lang', m); } catch (e) { return fail(e); }
    return say(m === 'id' ? 'Oke, gue pake bahasa Indonesia mulai sekarang.' : m === 'en' ? 'Done, English from now on.' : 'Auto: I reply in the language you write in.');
  }

  // ---------- capture (Table A)
  async function understand(text) {
    const n = now();
    if (!llm.enabled) return { error: { service: 'llm', status: 401, message: 'no key' } };
    try {
      const raw = await llm.generate([{ text: `${PARSE_PROMPT(n.date, n.weekday)}\n\nMessage: ${text}` }], { json: true, system: 'You extract structured data. Output JSON only.' });
      return { intent: normaliseIntent(raw, text, n.date) };
    } catch (e) { return { error: e }; }
  }

  async function capture(text, { force } = {}) {
    // Stage updates written as "X -> rejected" need no language model, and several can come in one message.
    let quick = force ? null : quickAppUpdates(text);
    if (quick && quick.length === 1) {
      // One line that names no known application is probably not an update: let the normal path read it.
      try { if (resolveApp(quick[0].target, await store.openApps()).none) quick = null; } catch (e) { return fail(e); }
    }
    if (quick) return proposeStages(quick);
    const u = await understand(text);
    if (u.error) {
      // Table A row 8: the model is unreachable, so the rules do what they can (date, time, title) and say so.
      log.error?.(`understand failed: ${u.error.status} ${u.error.message}`);
      const it = localIntent(text, now().date);
      const t = await createTask(it, text, { note: T('The language model is not reachable, so I read this by rule: check the title and date.', 'Language model-nya lagi nggak bisa diakses, jadi gue baca pake aturan: cek judul sama tanggalnya.') });
      if (t) {
        const how = explain(u.error, lastLang);
        const use = llm.enabled ? usageNote(llm.usage(), lastLang) : '';
        await say(`${how}${use ? `\n${use}` : ''}`);
      }
      return;
    }
    const it = u.intent;
    if (force === 'task' && ['unclear', 'question'].includes(it.intent)) it.intent = 'task';

    // Table A row 7: a message that matches an open Roadmap task.
    if (['task', 'done'].includes(it.intent)) {
      let road = [];
      try { road = (await store.roadmap()).filter((r) => r.status !== 'Done'); } catch { road = []; }
      const hit = bestMatches(it.title, road, (r) => r.title, 0.6)[0];
      if (hit) {
        return say(T(`That looks like the roadmap task "${esc(hit.title)}".`, `Kayaknya ini roadmap task "${esc(hit.title)}".`), {
          buttons: [btn(T('Mark that roadmap task Done', 'Tandai roadmap task itu Done'), { type: 'road_done', id: hit.id, statusType: hit.statusType, title: hit.title }),
            btn(T('No, create a separate Task', 'Bukan, bikin Task baru'), { type: 'create_task', it })],
        });
      }
    }
    switch (it.intent) {
      case 'unclear':
        return say(T(`"${esc(text)}": a new Task or an Application?`, `"${esc(text)}": Task baru atau lamaran kerja?`), {
          buttons: [btn('Task', { type: 'create_task', it: { ...it, title: it.title || text } }), btn(T('Application', 'Lamaran'), { type: 'create_app', it: { ...it, company: it.company || text } })],
        });
      case 'application': return createApp(it);
      case 'app_update': return proposeStage(it);
      case 'done': return proposeDone(it);
      case 'delete': return proposeDelete(it);
      case 'event': return proposeEvent(it);
      case 'event_edit': case 'event_delete': return proposeEventChange(it);
      case 'question': return sendWeek();
      default: return createTask(it, text);
    }
  }

  async function createTask(it, text = '', { note: extra = '' } = {}) {
    const fields = { title: it.title || text, area: it.area || (it.isProject ? 'Coursework' : null), priority: it.priority };
    if (it.date) { fields.due = it.date; fields.time = it.time; }
    let t;
    try { t = await store.createTask(fields); } catch (e) { lastFailed = text || it.title; return fail(e); }
    const note = it.invalidDate ? T('That date does not exist, so I filed it without one. Tell me the right date below.', 'Tanggal itu nggak ada di kalender, jadi gue simpen tanpa tanggal dulu. Kasih tanggal yang bener di bawah ya.') : '';
    await sayCreated(t, { note: [note, extra].filter(Boolean).join('\n') });
    await askFollowUp(t, { needDate: !t.due });
    if (it.isProject || t.area === 'Coursework') await askBrief(t);
    return t;
  }

  async function createApp(it) {
    const n = now();
    const company = it.company || it.title;
    const title = it.role ? `${company} — ${it.role}` : company;
    const fields = { title, company, role: it.role, stage: it.stage || 'Applied', appliedOn: n.date, lastUpdate: n.date };
    if (it.date) { fields.due = it.date; fields.time = it.time; }
    const days = FOLLOW_UP_DAYS[fields.stage];
    if (days) fields.followUp = addDays(n.date, days);
    let a;
    try { a = await store.createApp(fields); } catch (e) { lastFailed = title; return fail(e); }
    await sayCreated(a);
    if (!a.due) await say(T(`Any deadline or next-step date for ${esc(company)}? Reply with a date, or "none".`, `Ada deadline atau tanggal next step buat ${esc(company)}? Reply pake tanggal, atau "none".`), { forceReply: true, then: { type: 'set_date', kind: 'app', id: a.id, title: a.title } });
    return a;
  }

  // Table D row 1: say exactly what was written.
  async function sayCreated(item, { note = '' } = {}) {
    const lines = [item.kind === 'task' ? T('Filed a Task in Notion:', 'Udah gue tulis Task di Notion:') : T('Filed an Application in Notion:', 'Udah gue tulis lamaran di Notion:')];
    lines.push(`• ${T('Title', 'Judul')}: ${esc(item.title)}`);
    if (item.kind === 'task') {
      lines.push(`• Area: ${item.area || '—'}`, `• ${T('Priority', 'Prioritas')}: ${item.priority || '—'}`, `• Status: ${item.status}`);
      lines.push(`• Due: ${item.due ? pretty(item.due, item.time) : T('none', 'belum ada')}`);
    } else {
      lines.push(`• ${T('Company', 'Perusahaan')}: ${esc(item.company)}`, `• Role: ${esc(item.role) || '—'}`, `• Stage: ${item.stage}`);
      lines.push(`• Deadline: ${item.due ? pretty(item.due, item.time) : T('none', 'belum ada')}`);
      if (item.followUp) lines.push(`• ${T('Next follow-up', 'Follow-up berikutnya')}: ${pretty(item.followUp)}`);
    }
    if (item.url) lines.push(`<a href="${item.url}">${T('Open in Notion', 'Buka di Notion')}</a>`);
    if (note) lines.push('', note);
    const expires = clock().getTime() + UNDO_MS;
    await say(lines.join('\n'), {
      buttons: [btn(T('Change date', 'Ganti tanggal'), { type: 'ask_date', kind: item.kind, id: item.id, title: item.title, due: item.due }),
        btn(T('Change kind', 'Ganti jenis'), { type: 'switch_kind', item, expires }),
        btn('Undo', { type: 'undo', kind: item.kind, id: item.id, title: item.title, expires })],
    });
  }

  // Table A rows 2 and 5: ask the due date if missing, and what the task is for, so prep help is possible.
  async function askFollowUp(t, { needDate }) {
    const q = needDate
      ? T(`When is "${esc(t.title)}" due, and what is it for? Reply here, for example "fri, prep for the AIB interview, cover credit risk basics".`, `"${esc(t.title)}" deadline-nya kapan, dan buat apa? Reply di sini, contoh "jumat, buat interview AIB, bahas basic credit risk".`)
      : T(`What is "${esc(t.title)}" for, or what should it cover? Reply and I will help you prep.`, `"${esc(t.title)}" buat apa, atau mau bahas apa aja? Reply, nanti gue bantu siapin.`);
    await say(q, { forceReply: true, then: { type: 'details', id: t.id, title: t.title, needDate } });
  }
  async function askBrief(t) {
    await say(T(`"${esc(t.title)}" sounds like a project. Reply to this with the brief (PDF, or paste the text) and I will draft a task breakdown and a timeline.`, `"${esc(t.title)}" kayaknya project. Reply pesan ini pake brief-nya (PDF, atau paste teksnya), nanti gue bikinin breakdown task sama timeline.`), { forceReply: true, then: { type: 'brief', id: t.id, title: t.title, due: t.due } });
  }

  // ---------- replies to a question the bot asked
  async function handleReply(p, m, text) {
    const n = now();
    try {
      if (p.type === 'details') {
        const d = readDate(text, n.date);
        const patch = { details: text };
        if (p.needDate && d.date) { patch.due = d.date; patch.time = d.time; }
        const t = await store.updateTask(p.id, patch);
        const lines = [T(`Saved on "${esc(t.title)}":`, `Kesimpen di "${esc(t.title)}":`), `• Details: ${esc(text)}`];
        if (patch.due) lines.push(`• Due: ${pretty(t.due, t.time)}`);
        else if (p.needDate) lines.push(d.invalid ? T('• That date does not exist. Still no due date: tap Change date.', '• Tanggal itu nggak ada. Masih tanpa deadline: tap Ganti tanggal.') : T('• No date found, still no due date. Tap Change date when you know it.', '• Nggak ketemu tanggal, jadi masih tanpa deadline. Tap Ganti tanggal kalau udah tau.'));
        await say(lines.join('\n'), { buttons: [btn(T('Change date', 'Ganti tanggal'), { type: 'ask_date', kind: 'task', id: t.id, title: t.title, due: t.due })] });
        if (llm.enabled) {
          try {
            const help = await llm.generate([{ text: `Task: ${t.title}\nDue: ${t.due ? pretty(t.due, t.time) : 'unknown'}\nWhat it is for: ${text}\nToday: ${pretty(n.date)}\nReply in ${lastLang === 'id' ? 'casual Indonesian' : 'English'}. Give a short prep plan: 3 to 5 bullets with concrete next actions and what to bring or read. Do not invent facts about people or companies.` }]);
            await say(esc(help));
          } catch (e) { await say(T('Could not draft prep help: ', 'Gagal bikin bantuan prep: ') + explain(e, lastLang)); }
        }
        return;
      }
      if (p.type === 'set_date') {
        if (/^(none|no|nggak ada|gak ada|ga ada|-)$/i.test(text)) return say(T('Okay, no date.', 'Oke, tanpa tanggal.'));
        const d = readDate(text, n.date);
        if (!d.date) return say(d.invalid ? T('That date does not exist. Tap Change date and try again.', 'Tanggal itu nggak ada. Tap Ganti tanggal terus coba lagi.') : T('I could not read a date there. Tap Change date and try again.', 'Gue nggak nemu tanggal di situ. Tap Ganti tanggal terus coba lagi.'));
        // Table D row 4: changing an existing date needs a confirmation showing old and new.
        if (p.due) {
          return say(T(`Move "${esc(p.title)}" from ${pretty(p.due)} to ${pretty(d.date, d.time)}?`, `Pindahin "${esc(p.title)}" dari ${pretty(p.due)} ke ${pretty(d.date, d.time)}?`), {
            buttons: [btn(T('Yes, move it', 'Ya, pindahin'), { type: 'apply_date', kind: p.kind, id: p.id, date: d.date, time: d.time }), btn(T('No', 'Nggak'), { type: 'cancel' })],
          });
        }
        return applyDate({ kind: p.kind, id: p.id, date: d.date, time: d.time });
      }
      if (p.type === 'brief') return handleBrief(p, m, text);
      if (p.type === 'plan') return handlePlanText(p, text);
      if (p.type === 'event_date') {
        const d = readDate(text, n.date);
        if (!d.date) return say(T('No valid date found. Send the event again with a date.', 'Nggak ada tanggal yang valid. Kirim ulang event-nya pake tanggal.'));
        return proposeEvent({ ...p.it, date: d.date, eventStart: d.time || p.it.eventStart });
      }
    } catch (e) { return fail(e); }
  }

  async function applyDate({ kind, id, date, time }) {
    const item = kind === 'task' ? await store.updateTask(id, { due: date, time }) : await store.updateApp(id, { due: date, time });
    return say(T(`Done. "${esc(item.title)}" is now due ${pretty(item.due, item.time)}.`, `Beres. "${esc(item.title)}" sekarang deadline ${pretty(item.due, item.time)}.`));
  }

  // ---------- project brief, breakdown, agreed plan (Table A row 1)
  async function handleBrief(p, m, text) {
    if (!llm.enabled) return say(T('I need the language model for a breakdown. Set GEMINI_API_KEY first.', 'Buat breakdown gue butuh language model. Isi GEMINI_API_KEY dulu.'));
    const n = now();
    const partsIn = [];
    let briefNote = text;
    if (m.document) {
      const mime = m.document.mime_type || '';
      if (!/pdf|text\//.test(mime)) return say(T('Send the brief as a PDF or paste the text. Word files are not supported, export to PDF first.', 'Kirim brief-nya dalam PDF atau paste teksnya. File Word belum bisa, export ke PDF dulu.'), { forceReply: true, then: p });
      const buf = await tg.download(m.document.file_id);
      partsIn.push({ inline_data: { mime_type: mime.includes('pdf') ? 'application/pdf' : 'text/plain', data: buf.toString('base64') } });
      briefNote = `File: ${m.document.file_name || 'brief'}${text ? ` · ${text}` : ''}`;
    }
    if (!partsIn.length && !text) return say(T('Reply with the PDF or the brief text.', 'Reply pake PDF atau teks brief-nya.'), { forceReply: true, then: p });
    const due = p.due ? pretty(p.due) : 'unknown';
    partsIn.push({ text: `Project: ${p.title}\nToday: ${n.date}\nFinal due date: ${p.due || 'unknown'} (${due})\n${text ? `Brief text or notes:\n${text}\n` : ''}
Make a task breakdown and a timeline suggestion that ends on or before the due date. Return JSON only:
{"summary": two sentences on what the brief asks, "tasks":[{"title":..., "start":"YYYY-MM-DD", "end":"YYYY-MM-DD", "hours": number}], "risks":[short strings], "questions":[things to clarify with the group or lecturer]}
Use only dates from today to the due date. If the due date is unknown, plan in relative weeks starting today. Do not invent requirements the brief does not state.` });
    let out;
    try { out = await llm.generate(partsIn, { json: true, timeoutMs: 90000 }); } catch (e) { return fail(e); }
    const tasks = (out.tasks || []).filter((x) => x.title && readDate(x.start || '', n.date).date && readDate(x.end || '', n.date).date && (!p.due || x.end <= p.due));
    await store.updateTask(p.id, { brief: briefNote.slice(0, 1900), plan: JSON.stringify({ status: 'suggested', milestones: tasks.map((x) => ({ title: x.title, date: x.end, start: x.start })) }) });
    const lines = [`<b>${T('Suggested breakdown', 'Saran breakdown')} · ${esc(p.title)}</b>`, esc(out.summary || '')];
    for (const x of tasks) lines.push(`• ${pretty(x.start)} → ${pretty(x.end)}: ${esc(x.title)}${x.hours ? ` (~${x.hours}h)` : ''}`);
    if ((out.risks || []).length) lines.push('', `<b>${T('Risks', 'Risiko')}</b>`, ...out.risks.slice(0, 5).map((r) => `• ${esc(r)}`));
    if ((out.questions || []).length) lines.push('', `<b>${T('Ask the group', 'Tanyain ke grup')}</b>`, ...out.questions.slice(0, 5).map((r) => `• ${esc(r)}`));
    lines.push('', T('This is a suggestion only. When the group agrees, send /plan and paste the fixed timeline and your part.', 'Ini baru saran. Kalau grup udah sepakat, kirim /plan terus paste timeline final sama bagian lo.'));
    return say(lines.join('\n'));
  }

  async function projectTasks() { return (await store.openTasks()).filter((t) => t.area === 'Coursework' || parsePlan(t.plan) || t.brief); }
  async function startBrief(arg) {
    const tasks = await projectTasks().catch((e) => { fail(e); return null; });
    if (!tasks) return;
    const pick = arg ? bestMatches(arg, tasks)[0] : tasks.length === 1 ? tasks[0] : null;
    if (pick) return askBrief(pick);
    if (!tasks.length) return say(T('No project tasks yet. Capture one first, e.g. "derivatives group report fri 28 nov".', 'Belum ada task project. Tulis dulu, contoh "derivatives group report jumat 28 nov".'));
    return say(T('Which task is the brief for?', 'Brief-nya buat task yang mana?'), { buttons: tasks.slice(0, 8).map((t) => btn(t.title.slice(0, 40), { type: 'brief_for', id: t.id, title: t.title, due: t.due })) });
  }
  async function startPlan(arg) {
    const tasks = await projectTasks().catch((e) => { fail(e); return null; });
    if (!tasks) return;
    const pick = arg ? bestMatches(arg, tasks)[0] : tasks.length === 1 ? tasks[0] : null;
    if (pick) return askPlan(pick);
    if (!tasks.length) return say(T('No project tasks yet.', 'Belum ada task project.'));
    return say(T('Which project is the agreed plan for?', 'Plan final ini buat project yang mana?'), { buttons: tasks.slice(0, 8).map((t) => btn(t.title.slice(0, 40), { type: 'plan_for', id: t.id, title: t.title, due: t.due })) });
  }
  async function askPlan(t) {
    await say(T(`Paste the agreed timeline for "${esc(t.title)}" and your part, e.g. "lit review by 20 nov (me), model 24 nov (Aoife), slides 27 nov (me), submit 28 nov".`, `Paste timeline final "${esc(t.title)}" sama bagian lo, contoh "lit review 20 nov (gue), model 24 nov (Aoife), slides 27 nov (gue), submit 28 nov".`), { forceReply: true, then: { type: 'plan', id: t.id, title: t.title, due: t.due } });
  }
  async function handlePlanText(p, text) {
    const n = now();
    let ms = [];
    if (llm.enabled) {
      try {
        const out = await llm.generate([{ text: `Today: ${n.date}. Turn this agreed project timeline into JSON only: {"milestones":[{"title":..., "date_text": the exact date words, "time_text": "", "mine": true if the owner (me/gue/I) owns it}]}\nTimeline:\n${text}` }], { json: true, system: 'You extract structured data. Output JSON only.' });
        ms = (out.milestones || []).map((x) => { const d = readDate(x.date_text || '', n.date); return { title: x.title, date: d.date, start: readDate(x.time_text || '', n.date).time, mine: !!x.mine }; }).filter((x) => x.title && x.date);
      } catch (e) { return fail(e); }
    } else {
      // Without the model: one milestone per line or comma part that carries a date.
      ms = text.split(/[\n,;]+/).map((s) => { const d = readDate(s, n.date); return d.date ? { title: s.replace(/\(.*?\)/g, '').trim(), date: d.date, start: d.time, mine: /\b(me|gue|gw|saya|i)\b/i.test(s) } : null; }).filter(Boolean);
    }
    if (!ms.length) return say(T('I could not find any dated steps in that. Try one step per line with a date.', 'Gue nggak nemu langkah yang ada tanggalnya. Coba satu langkah per baris pake tanggal.'), { forceReply: true, then: p });
    await store.updateTask(p.id, { plan: JSON.stringify({ status: 'agreed', milestones: ms, text: text.slice(0, 1500) }), calendarEvents: '' });
    const lines = [T(`Saved the agreed plan for "${esc(p.title)}":`, `Plan final "${esc(p.title)}" udah kesimpen:`), ...ms.map((x) => `• ${pretty(x.date, x.start)}: ${esc(x.title)}${x.mine ? T(' (yours)', ' (bagian lo)') : ''}`)];
    lines.push('', T(`Add these ${ms.length} steps to ${cfg.google.writeCalendar || 'your calendar'}?`, `Masukin ${ms.length} langkah ini ke ${cfg.google.writeCalendar || 'kalender lo'}?`));
    return say(lines.join('\n'), { buttons: [btn(T('Yes, add to calendar', 'Ya, masukin kalender'), { type: 'plan_to_cal', taskId: p.id }), btn(T('Not now', 'Nanti aja'), { type: 'cancel' })] });
  }
  async function planToCalendar(taskId) {
    const t = (await store.openTasks()).find((x) => x.id === taskId);
    const plan = t && agreedPlan(t.plan);
    if (!plan) return say(T('That plan is gone or not agreed yet.', 'Plan-nya udah nggak ada atau belum final.'));
    const ids = [];
    for (const x of plan.milestones) {
      try {
        const ev = await cal.create(cfg.google.writeCalendar, { title: `${x.mine ? '★ ' : ''}${x.title} · ${t.title}`, date: x.date, start: x.start, end: x.start ? addMinutes(x.start, 60) : null, description: 'Added by Komplot from the agreed plan.' });
        ids.push(ev.id);
      } catch (e) { await say(explain(e, lastLang, { calendarId: cfg.google.writeCalendar, saEmail: cal.email })); break; }
    }
    if (ids.length) await store.updateTask(t.id, { calendarEvents: ids.join(' ') });
    return say(T(`Added ${ids.length} of ${plan.milestones.length} steps to the calendar.`, `${ids.length} dari ${plan.milestones.length} langkah udah masuk kalender.`));
  }

  // ---------- applications (AG-04, Table D row 3)
  async function proposeStage(it) {
    let apps;
    try { apps = await store.openApps(); } catch (e) { return fail(e); }
    const q = it.target || it.company || it.title;
    const r = resolveApp(q, apps);
    if (r.none) return say(T(`No open application matches "${esc(q)}". /apps lists them.`, `Nggak ada lamaran aktif yang cocok sama "${esc(q)}". Cek /apps.`));
    if (r.choices) return say(T(`Which one is "${esc(q)}"?`, `"${esc(q)}" itu yang mana?`), { buttons: r.choices.map((a) => btn(a.title.slice(0, 50), { type: 'stage_confirm', id: a.id, title: a.title, from: a.stage, to: it.stage || nextStage(a.stage) })) });
    return confirmStage(r.app, it.stage || nextStage(r.app.stage));
  }
  // Several "X -> stage" lines at once: one summary, one confirmation for everything that matched cleanly.
  async function proposeStages(updates) {
    if (updates.length === 1) return proposeStage(updates[0]);
    let apps;
    try { apps = await store.openApps(); } catch (e) { return fail(e); }
    const ready = []; const unclear = []; const missing = [];
    for (const u of updates) {
      const r = resolveApp(u.target, apps);
      if (r.app && !ready.some((x) => x.id === r.app.id)) ready.push({ id: r.app.id, title: r.app.title, from: r.app.stage, to: u.stage });
      else if (r.choices) unclear.push({ ...u, choices: r.choices });
      else if (r.none) missing.push(u.target);
    }
    if (ready.length) {
      const lines = [T(`Change these ${ready.length} applications?`, `Ubah ${ready.length} lamaran ini?`), ...ready.map((x) => `• ${esc(x.title)}: ${x.from} → ${x.to}`)];
      await say(lines.join('\n'), { buttons: [btn(T(`Confirm all ${ready.length}`, `Konfirmasi ${ready.length}-nya`), { type: 'apply_stages', items: ready }), btn(T('Cancel', 'Batal'), { type: 'cancel' })] });
    }
    for (const u of unclear) await say(T(`Which one is "${esc(u.target)}"? (→ ${u.stage})`, `"${esc(u.target)}" itu yang mana? (→ ${u.stage})`), { buttons: u.choices.map((a) => btn(a.title.slice(0, 50), { type: 'apply_stage', id: a.id, to: u.stage })) });
    if (missing.length) await say(T('No open application matches:', 'Nggak ada lamaran aktif yang cocok:') + `\n${missing.map((m) => `• ${esc(m)}`).join('\n')}\n${T('They may already be closed. /apps lists the open ones.', 'Mungkin udah ditutup. Cek /apps buat yang masih aktif.')}`);
  }
  const nextStage = (s) => STAGES[Math.min(STAGES.indexOf(s) + 1, 3)] || 'Online test';
  async function confirmStage(a, to) {
    return say(T(`Change "${esc(a.title)}" from ${a.stage} to ${to}?`, `Ubah "${esc(a.title)}" dari ${a.stage} ke ${to}?`), {
      buttons: [btn(T('Confirm', 'Konfirmasi'), { type: 'apply_stage', id: a.id, to }), ...STAGES.filter((s) => s !== to && s !== a.stage).map((s) => btn(`→ ${s}`, { type: 'apply_stage', id: a.id, to: s })), btn(T('Cancel', 'Batal'), { type: 'cancel' })],
    });
  }

  // ---------- done, delete (Table D rows 2 and 5)
  async function openEverything() {
    const [tasks, road] = await Promise.all([store.openTasks(), store.roadmap().then((r) => r.filter((x) => x.status !== 'Done')).catch(() => [])]);
    return [...tasks, ...road];
  }
  async function proposeDone(it) {
    let items; try { items = await openEverything(); } catch (e) { return fail(e); }
    const hits = bestMatches(it.target || it.title, items, (i) => i.title, 0.5);
    if (!hits.length) return say(T(`Nothing open matches "${esc(it.target || it.title)}". /done shows a list.`, `Nggak ada yang cocok sama "${esc(it.target || it.title)}". Cek /done.`));
    return say(T('Mark this Done?', 'Tandai Done?'), { buttons: [...hits.slice(0, 5).map((i) => btn(`✓ ${i.title.slice(0, 50)}`, { type: 'mark_done', kind: i.kind, id: i.id, title: i.title, statusType: i.statusType })), btn(T('Cancel', 'Batal'), { type: 'cancel' })] });
  }
  async function proposeDelete(it) {
    let items; try { items = [...(await store.openTasks()), ...(await store.openApps())]; } catch (e) { return fail(e); }
    const hits = bestMatches(it.target || it.title, items, (i) => i.title, 0.5);
    if (!hits.length) return say(T(`Nothing matches "${esc(it.target || it.title)}".`, `Nggak ada yang cocok sama "${esc(it.target || it.title)}".`));
    return say(T('Which one should I delete?', 'Mau hapus yang mana?'), { buttons: [...hits.slice(0, 5).map((i) => btn(`🗑 ${i.title.slice(0, 50)}`, { type: 'confirm_delete', kind: i.kind, id: i.id, title: i.title })), btn(T('Cancel', 'Batal'), { type: 'cancel' })] });
  }
  async function pickDone() {
    let items; try { items = await openEverything(); } catch (e) { return fail(e); }
    const n = now();
    const sorted = items.filter((i) => i.kind === 'task' || (i.week && i.week <= addDays(mondayOf(n.date), 6))).sort((a, b) => (a.due || a.week || '9').localeCompare(b.due || b.week || '9')).slice(0, 10);
    if (!sorted.length) return say(T('Nothing open. Suspiciously productive.', 'Semua udah kelar. Produktif banget, curiga.'));
    return say(T('Tap what you finished:', 'Tap yang udah kelar:'), { buttons: sorted.map((i) => btn(`✓ ${i.title.slice(0, 50)}`, { type: 'mark_done', kind: i.kind, id: i.id, title: i.title, statusType: i.statusType, tapped: true })) });
  }

  // ---------- calendar events (Table D rows 6 and 7)
  async function proposeEvent(it) {
    if (!it.date) return say(T(`What date is "${esc(it.title)}"?`, `"${esc(it.title)}" tanggal berapa?`), { forceReply: true, then: { type: 'event_date', it } });
    const ev = { title: it.title, date: it.date, start: it.eventStart, end: it.eventEnd || (it.eventStart ? addMinutes(it.eventStart, 60) : null) };
    const when = ev.start ? `${pretty(ev.date)}, ${ev.start}–${ev.end}` : `${pretty(ev.date)}, ${T('all day', 'seharian')}`;
    return say(T(`Create this event in ${cfg.google.writeCalendar}?\n• ${esc(ev.title)}\n• ${when}`, `Bikin event ini di ${cfg.google.writeCalendar}?\n• ${esc(ev.title)}\n• ${when}`), { buttons: [btn(T('Create', 'Bikin'), { type: 'create_event', ev }), btn(T('Cancel', 'Batal'), { type: 'cancel' })] });
  }
  async function proposeEventChange(it) {
    const n = now();
    const { events, failures } = await readCalendars(cal, cfg.google.readCalendars, n.date, addDays(n.date, 30));
    for (const f of failures) await say(explain(f.error, lastLang, { calendarId: f.id, saEmail: cal.email }));
    const hits = bestMatches(it.target || it.title, events, (e) => e.title, 0.5).slice(0, 5);
    if (!hits.length) return say(T('No event in the next 30 days matches that.', 'Nggak ada event 30 hari ke depan yang cocok.'));
    if (it.intent === 'event_delete') return say(T('Delete which event? This cannot be undone from here.', 'Hapus event yang mana? Ini nggak bisa di-undo dari sini.'), { buttons: [...hits.map((e) => btn(`🗑 ${pretty(e.date, e.start)} ${e.title.slice(0, 30)}`, { type: 'delete_event', ev: e })), btn(T('Cancel', 'Batal'), { type: 'cancel' })] });
    const e = hits[0];
    const patch = { date: it.date || e.date, start: it.eventStart || e.start, end: it.eventEnd || (it.eventStart ? addMinutes(it.eventStart, 60) : e.end), title: e.title };
    return say(T(`Change "${esc(e.title)}"\nfrom ${pretty(e.date, e.start)}\nto ${pretty(patch.date, patch.start)}?`, `Ubah "${esc(e.title)}"\ndari ${pretty(e.date, e.start)}\nke ${pretty(patch.date, patch.start)}?`), { buttons: [btn(T('Yes, change it', 'Ya, ubah'), { type: 'edit_event', ev: e, patch }), btn(T('Cancel', 'Batal'), { type: 'cancel' })] });
  }

  // ---------- buttons
  async function handleCallback(q) {
    await tg.answer(q.id).catch(() => {});
    const entry = actions.get(q.data);
    if (!entry) return say(T('That button expired. Ask me again.', 'Tombol itu udah kadaluarsa. Minta ulang ya.'));
    actions.delete(q.data);
    const a = entry.action;
    const t = clock().getTime();
    try {
      switch (a.type) {
        case 'cancel': return say(T('Cancelled. Nothing changed.', 'Batal. Nggak ada yang berubah.'));
        case 'create_task': return createTask(a.it);
        case 'create_app': return createApp(a.it);
        case 'road_done': await store.setRoadmapDone(a); return say(T(`Marked the roadmap task "${esc(a.title)}" Done in Notion.`, `Roadmap task "${esc(a.title)}" udah gue tandai Done di Notion.`));
        case 'mark_done':
          if (a.kind === 'roadmap') await store.setRoadmapDone(a);
          else await store.updateTask(a.id, { status: 'Done' });
          return say(T(`"${esc(a.title)}" is Done in Notion. ✓`, `"${esc(a.title)}" udah Done di Notion. ✓`));
        case 'ask_date': return say(T(`New date for "${esc(a.title)}"?`, `Tanggal baru buat "${esc(a.title)}"?`), { forceReply: true, then: { type: 'set_date', kind: a.kind, id: a.id, title: a.title, due: a.due } });
        case 'apply_date': return applyDate(a);
        case 'undo':
          if (t > a.expires) return say(T('Undo ran out after 10 minutes. Ask me to delete it instead.', 'Undo cuma 10 menit. Minta gue hapus aja.'));
          return say(T(`Sure you want to delete "${esc(a.title)}"?`, `Yakin mau hapus "${esc(a.title)}"?`), { buttons: [btn(T('Yes, delete', 'Ya, hapus'), { type: 'delete', kind: a.kind, id: a.id, title: a.title }), btn(T('No, keep it', 'Nggak, simpen'), { type: 'cancel' })] });
        case 'confirm_delete':
          return say(T(`Sure you want to delete "${esc(a.title)}"?`, `Yakin mau hapus "${esc(a.title)}"?`), { buttons: [btn(T('Yes, delete', 'Ya, hapus'), { type: 'delete', kind: a.kind, id: a.id, title: a.title }), btn(T('No, keep it', 'Nggak, simpen'), { type: 'cancel' })] });
        case 'delete': await store.trash(a.id); return say(T(`Deleted "${esc(a.title)}". It sits in Notion's trash for 30 days if you change your mind.`, `"${esc(a.title)}" udah dihapus. Masih ada di trash Notion 30 hari kalau berubah pikiran.`));
        case 'switch_kind': {
          if (t > a.expires) return say(T('Too late to switch, the 10 minutes are over.', 'Udah lewat 10 menit, nggak bisa ganti jenis.'));
          const it = { title: a.item.title, date: a.item.due, time: a.item.time, company: a.item.company || a.item.title, role: a.item.role, area: null };
          await store.trash(a.item.id);
          return a.item.kind === 'task' ? createApp(it) : createTask(it);
        }
        case 'stage_confirm': return confirmStage({ id: a.id, title: a.title, stage: a.from }, a.to);
        case 'apply_stage': {
          const n = now();
          const days = FOLLOW_UP_DAYS[a.to];
          const app = await store.updateApp(a.id, { stage: a.to, lastUpdate: n.date, followUp: days ? addDays(n.date, days) : null });
          return say(T(`"${esc(app.title)}" is now ${app.stage}.${app.followUp ? ` Next follow-up ${pretty(app.followUp)}.` : ''}`, `"${esc(app.title)}" sekarang ${app.stage}.${app.followUp ? ` Follow-up berikutnya ${pretty(app.followUp)}.` : ''}`));
        }
        case 'apply_stages': {
          const n = now(); const ok = []; const bad = [];
          for (const x of a.items) {
            const days = FOLLOW_UP_DAYS[x.to];
            try { await store.updateApp(x.id, { stage: x.to, lastUpdate: n.date, followUp: days ? addDays(n.date, days) : null }); ok.push(x); }
            catch (e) { log.error?.(e); bad.push(x); }
          }
          const lines = [T(`Updated ${ok.length} of ${a.items.length} in Notion:`, `${ok.length} dari ${a.items.length} udah keupdate di Notion:`), ...ok.map((x) => `• ${esc(x.title)} → ${x.to}`)];
          if (bad.length) lines.push('', T('Failed, send these again:', 'Gagal, kirim ulang yang ini:'), ...bad.map((x) => `• ${esc(x.title)}`));
          return say(lines.join('\n'));
        }
        case 'brief_for': return askBrief(a);
        case 'plan_for': return askPlan(a);
        case 'plan_to_cal': return planToCalendar(a.taskId);
        case 'create_event': { const ev = await cal.create(cfg.google.writeCalendar, a.ev); return say(T(`Created "${esc(ev.title)}" on ${pretty(ev.date, ev.start)} in ${cfg.google.writeCalendar}.`, `Event "${esc(ev.title)}" udah dibikin ${pretty(ev.date, ev.start)} di ${cfg.google.writeCalendar}.`)); }
        case 'edit_event': { const ev = await cal.patch(a.ev.calendarId, a.ev.id, a.patch); return say(T(`Moved "${esc(ev.title)}" to ${pretty(ev.date, ev.start)}.`, `"${esc(ev.title)}" udah dipindah ke ${pretty(ev.date, ev.start)}.`)); }
        case 'delete_event': return say(T(`Really delete "${esc(a.ev.title)}" on ${pretty(a.ev.date, a.ev.start)}?`, `Beneran hapus "${esc(a.ev.title)}" ${pretty(a.ev.date, a.ev.start)}?`), { buttons: [btn(T('Yes, delete event', 'Ya, hapus event'), { type: 'delete_event_yes', ev: a.ev }), btn(T('No', 'Nggak'), { type: 'cancel' })] });
        case 'delete_event_yes': await cal.remove(a.ev.calendarId, a.ev.id); return say(T(`Deleted the event "${esc(a.ev.title)}".`, `Event "${esc(a.ev.title)}" udah dihapus.`));
        case 'snooze': {
          const item = a.kind === 'task' ? await store.updateTask(a.id, { remindersSent: [...a.sent, `snooze:${addDays(now().date, 1)}`] }) : await store.updateApp(a.id, { remindersSent: [...a.sent, `snooze:${addDays(now().date, 1)}`] });
          return say(T(`Snoozed "${esc(item.title)}" until tomorrow ${cfg.times.reminder}.`, `"${esc(item.title)}" di-snooze sampai besok ${cfg.times.reminder}.`));
        }
        default: return say(T('That button does nothing any more.', 'Tombol itu udah nggak kepake.'));
      }
    } catch (e) { return fail(e, { calendarId: a.ev?.calendarId || cfg.google.writeCalendar, saEmail: cal?.email }); }
  }

  // ---------- lists
  async function listTasks() {
    let tasks; try { tasks = await store.openTasks(); } catch (e) { return fail(e); }
    if (!tasks.length) return say(T('No open tasks.', 'Nggak ada task yang terbuka.'));
    tasks.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    return say(tasks.slice(0, 30).map((t) => `• ${t.due ? pretty(t.due, t.time) : T('no date', 'tanpa tanggal')}: ${esc(t.title)}${t.area ? ` [${t.area}]` : ''}`).join('\n') + (tasks.length > 30 ? `\n…${tasks.length - 30} more` : ''));
  }
  async function listApps() {
    let apps; try { apps = await store.openApps(); } catch (e) { return fail(e); }
    if (!apps.length) return say(T('No open applications.', 'Nggak ada lamaran aktif.'));
    apps.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.appliedOn || '').localeCompare(b.appliedOn || ''));
    const lines = apps.slice(0, 25).map((a) => `• ${esc(a.title)} · ${a.stage}${a.due ? ` · ${T('deadline', 'deadline')} ${pretty(a.due)}` : ''}`);
    return say(`<b>${T('Open applications', 'Lamaran aktif')} (${apps.length})</b>\n${lines.join('\n')}${apps.length > 25 ? `\n…${apps.length - 25} more` : ''}\n\n${T('Update by writing e.g. "AIB grad risk -> interview", several lines at once is fine. /apps stale lists the ones gone quiet.', 'Update dengan nulis misalnya "AIB grad risk -> interview", boleh beberapa baris sekaligus. /apps stale buat yang udah lama nggak ada kabar.')}`);
  }
  async function listStale() {
    let apps; try { apps = await store.openApps(); } catch (e) { return fail(e); }
    const { stale } = appsNeedingAttention(apps, now().date, cfg.followUpIdleDays);
    if (!stale.length) return say(T('No stale applications.', 'Nggak ada lamaran yang basi.'));
    const lines = stale.slice(0, 40).map((x) => `• ${esc(x.a.title)} · ${x.days}d`);
    return say(`<b>${T(`No news for ${cfg.followUpIdleDays}+ days`, `Tanpa kabar ${cfg.followUpIdleDays}+ hari`)} (${stale.length})</b>\n${lines.join('\n')}${stale.length > 40 ? `\n…${stale.length - 40} more` : ''}\n\n${T('Close several at once, one per line:\nApplegreen -> rejected\nBDO Ireland -> withdrawn', 'Tutup beberapa sekaligus, satu per baris:\nApplegreen -> rejected\nBDO Ireland -> withdrawn')}`);
  }
  async function sendWeek() {
    const n = now(); const end = addDays(n.date, 7);
    const { events, failures } = await readCalendars(cal, cfg.google.readCalendars, n.date, end);
    let tasks = []; let apps = [];
    try { [tasks, apps] = await Promise.all([store.openTasks(), store.openApps()]); } catch (e) { return fail(e); }
    const byDay = new Map();
    const add = (date, line) => { if (!byDay.has(date)) byDay.set(date, []); byDay.get(date).push(line); };
    for (const e of events) add(e.date, `📅 ${e.allDay ? T('all day', 'seharian') : e.start} ${esc(e.title)}`);
    for (const t of tasks) if (t.due && t.due <= end) add(t.due < n.date ? n.date : t.due, `${t.due < n.date ? '🔥' : '•'} ${esc(t.title)}${t.due < n.date ? T(` (late since ${pretty(t.due)})`, ` (telat sejak ${pretty(t.due)})`) : ''}`);
    for (const a of apps) if (a.due && a.due >= n.date && a.due <= end) add(a.due, `💼 ${esc(a.title)} deadline`);
    const days = [...byDay.keys()].sort();
    const lines = [`<b>${T('Next 7 days', '7 hari ke depan')}</b>`];
    for (const d of days) lines.push('', `<b>${pretty(d)}</b>`, ...byDay.get(d).slice(0, 12));
    if (!days.length) lines.push(T('Nothing in the next 7 days.', 'Kosong 7 hari ke depan.'));
    for (const f of failures) lines.push('', '📅 ' + explain(f.error, lastLang, { calendarId: f.id, saEmail: cal.email }));
    return say(lines.join('\n'));
  }

  // ---------- part-time shifts (Q-07)
  async function logShift(arg) {
    if (!arg) return say(T('Usage: /shift IKEA 5h tomorrow 14.50/h', 'Cara pakai: /shift IKEA 5 jam besok 14.50/jam'));
    const n = now();
    const d = readDate(arg, n.date);
    const hours = Number((arg.match(/(\d+(?:[.,]\d+)?)\s*(?:h|hrs?|hours?|jam)\b/i) || [])[1]?.replace(',', '.')) || null;
    const rate = Number((arg.match(/(\d+(?:[.,]\d+)?)\s*\/\s*(?:h|hr|hour|jam)/i) || [])[1]?.replace(',', '.')) || null;
    const employer = arg.split(/\s+/)[0];
    try {
      await store.createShift({ title: `${employer} ${d.date || n.date}`, employer, date: d.date || n.date, hours, rate });
      return say(T(`Logged a shift: ${esc(employer)}, ${pretty(d.date || n.date)}, ${hours ?? '?'} h${rate ? ` at €${rate}/h` : ''}.`, `Shift kecatat: ${esc(employer)}, ${pretty(d.date || n.date)}, ${hours ?? '?'} jam${rate ? ` @ €${rate}/jam` : ''}.`));
    } catch (e) { return fail(e); }
  }

  // ---------- scheduled messages
  async function gather(from, to) {
    const { events, failures } = await readCalendars(cal, cfg.google.readCalendars, from, to);
    const [tasks, apps, roadmap] = await Promise.all([store.openTasks(), store.openApps(), store.roadmap().catch(() => [])]);
    return { events, calFailures: failures, tasks, apps, roadmap };
  }
  async function sendDigest({ manual = false } = {}) {
    const n = now();
    if (!manual) lastLang = (await mode()) === 'auto' ? lastLang : await mode();
    let data;
    try { data = await gather(n.date, addDays(n.date, 1)); } catch (e) { return fail(e); }
    let usageWarning = '';
    if (llm.enabled) { const u = llm.usage(); if (u.quotaErrors || (u.limit && u.calls >= 0.8 * u.limit)) usageWarning = usageNote(u, lastLang); }
    const { text, buttons } = buildDigest({ ...data, today: n.date, lang: lastLang, seed: Number(n.date.slice(-2)), idleDays: cfg.followUpIdleDays, saEmail: cal.email, usageWarning });
    await say(text, { buttons: buttons.map((b) => btn(b.text, b.action)) });
  }
  async function sendReview(kind) {
    const n = now();
    let data;
    try { data = await gather(n.date, addDays(n.date, 8)); data.doneThisWeek = await store.tasksDoneSince(mondayOf(n.date)); } catch (e) { return fail(e); }
    await say(buildReview(kind, { ...data, today: n.date, lang: lastLang, seed: weekdayOf(n.date) }));
  }
  async function sendReminder({ item, key, daysLeft }) {
    const when = daysLeft === 0 ? T('today', 'hari ini') : daysLeft === 1 ? T('tomorrow', 'besok') : T(`in ${daysLeft} days`, `${daysLeft} hari lagi`);
    const label = item.kind === 'app' ? T('Application deadline', 'Deadline lamaran') : T('Due', 'Deadline');
    const sent = [...(item.remindersSent || []), key];
    // Record first, then send: a crash between the two loses one reminder instead of sending it twice.
    if (item.kind === 'task') await store.updateTask(item.id, { remindersSent: sent }); else await store.updateApp(item.id, { remindersSent: sent });
    const buttons = [btn(T('Snooze 1 day', 'Snooze 1 hari'), { type: 'snooze', kind: item.kind, id: item.id, sent }), btn(T('Move date', 'Pindah tanggal'), { type: 'ask_date', kind: item.kind, id: item.id, title: item.title, due: item.due })];
    if (item.kind === 'task') buttons.unshift(btn('Done ✓', { type: 'mark_done', kind: 'task', id: item.id, title: item.title, tapped: true }));
    await say(`⏰ ${label} ${when} (${pretty(item.due, item.time)}): <b>${esc(item.title)}</b>`, { buttons });
  }

  return { handleUpdate, sendDigest, sendReview, sendReminder, capture, _pending: pending, _actions: actions, lang: () => lastLang };
}

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const HELP = {
  en: `<b>Komplot</b>, your PM partner. Just write what you need, e.g.
• "submit derivatives group report friday"
• "applied AIB grad risk, deadline 30 nov"
• "AIB grad risk: online test done"
• "done with M1 notebook"

Commands
/today digest now · /week next 7 days
/tasks open tasks · /apps open applications
/done tick things off · /add force a task
/brief send a project brief · /plan save the agreed timeline
/shift log a part-time shift · /usage model usage
/lang en | id | auto · /retry last failed capture`,
  id: `<b>Komplot</b>, partner PM lo. Tulis aja, contoh:
• "submit derivatives group report jumat"
• "applied AIB grad risk, deadline 30 nov"
• "AIB grad risk: online test done"
• "M1 notebook udah kelar"

Command
/today digest sekarang · /week 7 hari ke depan
/tasks task terbuka · /apps lamaran aktif
/done centang yang kelar · /add paksa jadi task
/brief kirim brief project · /plan simpen timeline final
/shift catat shift part-time · /usage pemakaian model
/lang en | id | auto · /retry ulang capture yang gagal`,
};
