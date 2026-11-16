// In-memory stand-ins for Notion, Calendar, Gemini and Telegram.
export const OWNER = 111;
export const cfg = {
  ownerId: OWNER,
  google: { readCalendars: ['personal', 'ucd'], writeCalendar: 'personal' },
  times: { digest: '07:00', reminder: '09:00', midweek: '13:00', weekly: '18:00', quietFrom: '22:00', quietTo: '07:00' },
  leadDays: [3, 1, 0], followUpIdleDays: 14,
};

export function fakeStore(seed = {}) {
  let n = 0;
  const id = () => `id${++n}`;
  const s = { tasks: seed.tasks || [], apps: seed.apps || [], roadmap: seed.roadmap || [], shifts: [], state: {}, trashed: [], calls: [] };
  const created = (clockIso) => clockIso || '2026-11-01T00:00:00.000Z';
  s.api = {
    openTasks: async () => s.tasks.filter((t) => t.status !== 'Done' && !s.trashed.includes(t.id)).map((t) => ({ ...t })),
    tasksDoneSince: async () => s.tasks.filter((t) => t.status === 'Done'),
    openApps: async () => s.apps.filter((a) => !['Offer', 'Rejected', 'Withdrawn'].includes(a.stage) && !s.trashed.includes(a.id)).map((a) => ({ ...a })),
    roadmap: async () => s.roadmap.map((r) => ({ ...r })),
    createTask: async (t) => { const x = { kind: 'task', id: id(), status: 'Not started', remindersSent: [], created: created(s.now), area: null, priority: null, due: null, time: null, plan: '', brief: '', details: '', calendarEvents: '', ...t }; s.tasks.push(x); s.calls.push(['createTask', x]); return { ...x }; },
    createApp: async (a) => { const x = { kind: 'app', id: id(), stage: 'Applied', remindersSent: [], created: created(s.now), due: null, time: null, role: '', ...a }; s.apps.push(x); s.calls.push(['createApp', x]); return { ...x }; },
    updateTask: async (i, p) => { const x = s.tasks.find((t) => t.id === i); Object.assign(x, p); s.calls.push(['updateTask', i, p]); return { ...x }; },
    updateApp: async (i, p) => { const x = s.apps.find((t) => t.id === i); Object.assign(x, p); s.calls.push(['updateApp', i, p]); return { ...x }; },
    setRoadmapDone: async (r) => { s.roadmap.find((x) => x.id === r.id).status = 'Done'; s.calls.push(['roadDone', r.id]); },
    createShift: async (x) => { s.shifts.push(x); },
    trash: async (i) => { s.trashed.push(i); s.calls.push(['trash', i]); },
    getState: async (k) => s.state[k] ?? null,
    setState: async (k, v) => { s.state[k] = v; },
  };
  return s;
}

export function fakeCal({ events = [], fail = {} } = {}) {
  const c = { events, created: [], patched: [], removed: [], email: 'komplot@test.iam.gserviceaccount.com' };
  c.api = {
    email: c.email,
    events: async (calId, from, to) => { if (fail[calId]) throw fail[calId]; return c.events.filter((e) => e.calendarId === calId && e.date >= from && e.date < to); },
    create: async (calId, ev) => { const x = { id: `ev${c.created.length + 1}`, calendarId: calId, ...ev }; c.created.push(x); return x; },
    patch: async (calId, i, p) => { c.patched.push([calId, i, p]); return { id: i, calendarId: calId, ...p }; },
    remove: async (calId, i) => { c.removed.push([calId, i]); },
  };
  return c;
}

// replies: function(text) -> JSON for parsing calls, or string for free-form.
export function fakeLlm(replies, { down = false } = {}) {
  const usage = { day: '2026-11-16', calls: 0, quotaErrors: 0, limit: null };
  return {
    enabled: true,
    model: () => 'gemini-test-flash',
    usage: () => ({ ...usage }),
    async generate(partsIn, { json } = {}) {
      if (down) { const e = new Error('connect ECONNREFUSED'); e.service = 'llm'; e.status = 0; throw e; }
      usage.calls += 1;
      const text = partsIn.map((p) => p.text || '').join('\n');
      const msg = (text.match(/Message: ([\s\S]*)$/) || [])[1] || text;
      const r = replies(msg.trim(), text);
      return json ? r : (typeof r === 'string' ? r : 'prep: read the brief');
    },
  };
}

export function fakeTg() {
  const t = { sent: [], answered: [] };
  let mid = 100;
  t.api = {
    send: async (chat, text, opts = {}) => { const m = { message_id: ++mid, chat, text, buttons: (opts.buttons || []).flat(), forceReply: !!opts.forceReply }; t.sent.push(m); return m; },
    answer: async (id) => { t.answered.push(id); },
    download: async () => Buffer.from('brief'),
  };
  t.last = () => t.sent[t.sent.length - 1];
  t.find = (re) => t.sent.find((m) => re.test(m.text));
  return t;
}

export const msg = (text, extra = {}) => ({ message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER }, text, ...extra } });
export const tap = (data) => ({ callback_query: { id: 'cb', from: { id: OWNER }, data } });
export const replyTo = (m, text) => msg(text, { reply_to_message: { message_id: m.message_id } });
export const fixedClock = (iso) => () => new Date(iso);
