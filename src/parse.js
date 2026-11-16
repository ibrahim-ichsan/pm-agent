// Turning a chat message into an intent. The language model proposes; this file decides.
// Dates always come from the rule-based reader in dates.js when it finds one,
// so "friday" means the same thing every time and an impossible date is never filed.
import { readDate } from './dates.js';
import { STAGES } from './notion.js';

export const AREAS = ['Coursework', 'Side project', 'Part-time', 'Job search', 'Personal'];
export const PRIORITIES = ['Must', 'Should', 'Stretch'];

const ID_WORDS = /\b(gue|gw|gua|lu|lo|elu|aja|udah|belum|besok|nanti|tolong|bikin|kerjain|ngerjain|yang|nggak|gak|ga|dong|sih|deh|kalo|klo|mau|harus|jam|hari|minggu|bulan|apus|hapus|selesai|beres|kelar)\b/i;
export function detectLang(text) { return ID_WORDS.test(text) ? 'id' : 'en'; }

export function parseCommand(text) {
  const m = text.trim().match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  return m ? { cmd: m[1].toLowerCase(), arg: m[2].trim() } : null;
}

export const PARSE_PROMPT = (today, weekday) => `Today is ${weekday} ${today} in Dublin. Classify the owner's message and extract fields.
Return JSON only:
{"intent": one of "task","application","app_update","done","delete","event","event_edit","event_delete","question","unclear",
 "title": short title without the date words,
 "date_text": the exact date words from the message or "",
 "time_text": the exact time words or "",
 "area": one of ${JSON.stringify(AREAS)} or "",
 "priority": one of ${JSON.stringify(PRIORITIES)} or "",
 "is_project": true when it is coursework or a group project that needs a plan (report, assignment, presentation, case, essay),
 "company": company name for applications or "",
 "role": job title for applications or "",
 "stage": one of ${JSON.stringify(STAGES)} or "",
 "target": for app_update/done/delete/event_edit/event_delete, words that identify the existing item,
 "event_start": "HH:MM" or "", "event_end": "HH:MM" or ""}
Rules: "applied X", "apply X" or a company with a role is an application. A message that is only a company or one word is "unclear".
"X: online test done" or "got interview at X" is app_update. "done with X" or "finished X" is done.
Never invent a date. If the message has no date words, date_text is "".`;

export function normaliseIntent(raw, text, today) {
  const r = raw || {};
  const intent = ['task', 'application', 'app_update', 'done', 'delete', 'event', 'event_edit', 'event_delete', 'question', 'unclear'].includes(r.intent) ? r.intent : 'unclear';
  const d = readDate(text, today);
  let date = d.date; let time = d.time; let invalid = d.invalid;
  // The model may spot a date phrase the rules miss; accept it only if the rules can read that phrase.
  if (!date && !invalid && r.date_text) { const d2 = readDate(r.date_text, today); date = d2.date; invalid = d2.invalid; time = time || d2.time; }
  if (!time && r.time_text) time = readDate(r.time_text, today).time;
  return {
    intent,
    title: cleanTitle(r.title || text, d.matched),
    date, time, invalidDate: invalid,
    area: AREAS.includes(r.area) ? r.area : null,
    priority: PRIORITIES.includes(r.priority) ? r.priority : null,
    isProject: !!r.is_project || PROJECT_WORDS.test(text),
    company: (r.company || '').trim(), role: (r.role || '').trim(),
    stage: STAGES.includes(r.stage) ? r.stage : null,
    target: (r.target || '').trim(),
    eventStart: /^\d{2}:\d{2}$/.test(r.event_start || '') ? r.event_start : time,
    eventEnd: /^\d{2}:\d{2}$/.test(r.event_end || '') ? r.event_end : null,
  };
}
const PROJECT_WORDS = /\b(report|assignment|group|project|presentation|essay|case study|coursework|dissertation|thesis|tugas|laporan|presentasi)\b/i;

function cleanTitle(title, matched) {
  let t = title;
  for (const m of matched || []) t = t.replace(new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  t = t.replace(/\b(deadline|due|by|on|at|jam|pukul)\s*$/i, '').replace(/[,;:\s]+$/g, '').replace(/^\s*[,;:]+/, '').replace(/\s{2,}/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : title.trim();
}

// Word-overlap score between two titles, 0..1, measured on the shorter one.
export function similarity(a, b) {
  const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
}
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'for', 'my', 'on', 'in', 'with', 'yang', 'dan', 'di', 'ke', 'finish', 'done', 'do', 'submit', 'selesai', 'beres']);

export function bestMatches(query, items, key = (i) => i.title, min = 0.5) {
  return items.map((i) => ({ i, s: similarity(query, key(i)) })).filter((x) => x.s >= min).sort((a, b) => b.s - a.s).map((x) => x.i);
}
