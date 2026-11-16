// Tables A and D, plus access control. Messages are sent on Mon 16 Nov 2026, 10:00 Dublin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../src/agent.js';
import { cfg, fakeStore, fakeCal, fakeLlm, fakeTg, msg, tap, replyTo, fixedClock } from './fakes.js';

const PARSES = {
  'submit derivatives group report friday': { intent: 'task', title: 'Submit derivatives group report', date_text: 'friday', area: 'Coursework', is_project: true },
  'buy printer paper': { intent: 'task', title: 'Buy printer paper', area: 'Personal' },
  'applied AIB grad risk, deadline 30 nov': { intent: 'application', title: 'AIB grad risk', company: 'AIB', role: 'Grad risk', date_text: '30 nov', stage: 'Applied' },
  AIB: { intent: 'unclear', title: 'AIB' },
  'call landlord tomorrow 3pm': { intent: 'task', title: 'Call landlord', date_text: 'tomorrow', time_text: '3pm', area: 'Personal' },
  'report due 31 feb': { intent: 'task', title: 'Report', date_text: '31 feb' },
  'finish M1 notebook': { intent: 'task', title: 'Finish M1 notebook' },
  'done with landlord call': { intent: 'done', title: 'landlord call', target: 'landlord call' },
  'AIB grad risk: online test done': { intent: 'app_update', target: 'AIB grad risk', company: 'AIB', stage: 'Online test' },
  'delete printer paper': { intent: 'delete', target: 'printer paper' },
  'book gym session thursday 6pm': { intent: 'event', title: 'Gym session', date_text: 'thursday', time_text: '6pm' },
  'move dentist to friday 4pm': { intent: 'event_edit', target: 'dentist', date_text: 'friday', time_text: '4pm', event_start: '16:00' },
  'cancel dentist': { intent: 'event_delete', target: 'dentist' },
  'beli kertas printer besok dong': { intent: 'task', title: 'Beli kertas printer', date_text: 'besok' },
};
const BREAKDOWN = { summary: 'Group report on hedging.', tasks: [{ title: 'Literature review', start: '2026-11-16', end: '2026-11-17', hours: 4 }, { title: 'Bogus after due', start: '2026-11-21', end: '2026-11-25' }], risks: ['Tight'], questions: ['Word limit?'] };
const PLAN = { milestones: [{ title: 'Lit review', date_text: '17 nov', mine: true }, { title: 'Model', date_text: '18 nov', mine: false }, { title: 'Slides', date_text: '19 nov', mine: true }] };

function setup({ store: seed, cal: calOpts, llmDown = false, now = '2026-11-16T10:00:00Z' } = {}) {
  const store = fakeStore(seed);
  store.now = now;
  const cal = fakeCal(calOpts);
  const tg = fakeTg();
  const llm = fakeLlm((m, full) => (/task breakdown/.test(full) ? BREAKDOWN : /agreed timeline/.test(full) ? PLAN : PARSES[m] || 'Bring your notes.'), { down: llmDown });
  const agent = createAgent({ cfg, store: store.api, cal: cal.api, llm, tg: tg.api, clock: fixedClock(now), log: { error() {}, warn() {} } });
  return { store, cal, tg, agent };
}
const dataOf = (m, re) => m.buttons.find((b) => re.test(b.text)).data;

test('A1 project task: Coursework, Friday, asks what it is for, asks for the brief', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('submit derivatives group report friday'));
  const t = store.tasks[0];
  assert.equal(t.title, 'Submit derivatives group report');
  assert.equal(t.due, '2026-11-20');
  assert.equal(t.area, 'Coursework');
  assert.match(tg.sent[0].text, /Due: Fri 20 Nov 2026/);
  assert.ok(tg.sent.some((m) => m.forceReply && /what is it for|what should it cover/i.test(m.text)));
  assert.ok(tg.sent.some((m) => m.forceReply && /brief/i.test(m.text)));
});

test('A1 brief reply gives a breakdown inside the due date, saved as a suggestion only', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('submit derivatives group report friday'));
  const ask = tg.sent.find((m) => /brief/i.test(m.text));
  await agent.handleUpdate(replyTo(ask, 'Group report, 3000 words, hedging a corporate FX exposure.'));
  const plan = JSON.parse(store.tasks[0].plan);
  assert.equal(plan.status, 'suggested');
  assert.deepEqual(plan.milestones.map((m) => m.title), ['Literature review']); // the step after the due date is dropped
  assert.ok(tg.sent.some((m) => /Suggested breakdown/.test(m.text) && /Word limit\?/.test(m.text) && /send \/plan/.test(m.text)));
});

test('A1 agreed plan: /plan saves it, calendar only after Yes', async () => {
  const { store, cal, tg, agent } = setup();
  await agent.handleUpdate(msg('submit derivatives group report friday'));
  await agent.handleUpdate(msg('/plan'));
  await agent.handleUpdate(replyTo(tg.last(), 'lit review 17 nov (me), model 18 nov (Aoife), slides 19 nov (me)'));
  const plan = JSON.parse(store.tasks[0].plan);
  assert.equal(plan.status, 'agreed');
  assert.equal(plan.milestones.length, 3);
  assert.deepEqual(plan.milestones.map((m) => m.mine), [true, false, true]);
  assert.equal(cal.created.length, 0);
  await agent.handleUpdate(tap(dataOf(tg.last(), /Yes, all/)));
  assert.equal(cal.created.length, 3);
  assert.match(cal.created[0].title, /^★ /);
});

test('A2 no date: created with no due date, asks for date and purpose', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('buy printer paper'));
  assert.equal(store.tasks[0].due, null);
  assert.match(tg.sent[0].text, /Due: none/);
  const q = tg.sent.find((m) => m.forceReply);
  assert.match(q.text, /When is "Buy printer paper" due, and what is it for/);
});

test('A2 reply to the follow-up sets the date and saves the purpose', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('buy printer paper'));
  const q = tg.sent.find((m) => m.forceReply);
  await agent.handleUpdate(replyTo(q, 'thursday, for printing the CFA pitch deck'));
  assert.equal(store.tasks[0].due, '2026-11-19');
  assert.equal(store.tasks[0].details, 'thursday, for printing the CFA pitch deck');
  assert.ok(tg.sent.some((m) => /Due: Thu 19 Nov 2026/.test(m.text)));
});

test('A3 application: stage Applied, deadline 30 Nov', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('applied AIB grad risk, deadline 30 nov'));
  const a = store.apps[0];
  assert.equal(a.stage, 'Applied');
  assert.equal(a.due, '2026-11-30');
  assert.equal(a.company, 'AIB');
  assert.match(tg.sent[0].text, /Deadline: Mon 30 Nov 2026/);
});

test('A4 unclear: asks Task or Application, files nothing', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('AIB'));
  assert.equal(store.tasks.length + store.apps.length, 0);
  assert.deepEqual(tg.last().buttons.map((b) => b.text), ['Task', 'Application']);
  await agent.handleUpdate(tap(tg.last().buttons[1].data));
  assert.equal(store.apps.length, 1);
});

test('A5 date and time: Tue 17 Nov 15:00, asks what to discuss', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('call landlord tomorrow 3pm'));
  assert.equal(store.tasks[0].due, '2026-11-17');
  assert.equal(store.tasks[0].time, '15:00');
  assert.match(tg.sent[0].text, /Due: Tue 17 Nov 2026, 15:00/);
  assert.match(tg.sent.find((m) => m.forceReply).text, /What is "Call landlord" for/);
});

test('A6 impossible date: still filed without a date, says so, asks for the date', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('report due 31 feb'));
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].due, null);
  assert.match(tg.sent[0].text, /date does not exist/);
  assert.match(tg.sent.find((m) => m.forceReply).text, /When is .* due/);
});

test('A7 roadmap match: offers Done or a new Task, files nothing until tapped', async () => {
  const { store, tg, agent } = setup({ store: { roadmap: [{ kind: 'roadmap', id: 'r1', title: 'M1 notebook: EDA and baseline', status: 'In progress', statusType: 'status', week: '2026-11-16' }] } });
  await agent.handleUpdate(msg('finish M1 notebook'));
  assert.equal(store.tasks.length, 0);
  await agent.handleUpdate(tap(dataOf(tg.last(), /roadmap task Done/)));
  assert.equal(store.roadmap[0].status, 'Done');
});

test('A8 model down: rules still read the date, the reply says the model is down and why', async () => {
  const { store, tg, agent } = setup({ llmDown: true });
  await agent.handleUpdate(msg('grup project derivative 27 november deadline submit'));
  assert.equal(store.tasks[0].due, '2026-11-27');
  assert.doesNotMatch(store.tasks[0].title, /27 november/i);
  assert.match(tg.sent[0].text, /language model is not reachable/);
  assert.ok(tg.sent.some((m) => /language model failed/.test(m.text) && /Model usage/.test(m.text)));
  assert.ok(!tg.sent.some((m) => /When is/.test(m.text)), 'does not ask for a date it already has');
});

test('Several "X -> rejected" lines: no model call, no Task, one confirmation updates them all', async () => {
  const apps = [
    { kind: 'app', id: 'a1', title: 'JPMorgan Chase — Business Process Management Senior Associate', company: 'JPMorgan Chase', role: 'Business Process Management Senior Associate', stage: 'Applied' },
    { kind: 'app', id: 'a2', title: 'Boston Consulting Group — Associate/Senior Associate, Full-Time, London', company: 'Boston Consulting Group', role: 'Associate/Senior Associate, Full-Time, London', stage: 'Applied' },
    { kind: 'app', id: 'a3', title: 'Boston Consulting Group — Digital Strategy Senior Associate/Consultant (Technology & Digital Advantage)', company: 'Boston Consulting Group', role: 'Digital Strategy Senior Associate/Consultant', stage: 'Applied' },
    { kind: 'app', id: 'a4', title: 'Kerry — Kerry Graduate Programme 2027 - Supply Chain', company: 'Kerry', role: 'Kerry Graduate Programme 2027 - Supply Chain', stage: 'Applied' },
  ];
  const { store, tg, agent } = setup({ llmDown: true, store: { apps } });
  await agent.handleUpdate(msg('JPMorgan Chase — Business Process Management Senior Associate —> rejected\nBoston Consulting Group — Associate/Senior Associate, Full-Time —> rejected\nKerry — Kerry Graduate Programme 2027 - Supply Chain —> rejected'));
  assert.equal(store.tasks.length, 0);
  assert.match(tg.last().text, /Change these 3 applications/);
  await agent.handleUpdate(tap(dataOf(tg.last(), /Confirm all 3/)));
  assert.deepEqual(store.apps.map((a) => a.stage), ['Rejected', 'Rejected', 'Applied', 'Rejected']);
  assert.match(tg.last().text, /Updated 3 of 3/);
});

test('D1 create: the reply lists every field written', async () => {
  const { tg, agent } = setup();
  await agent.handleUpdate(msg('call landlord tomorrow 3pm'));
  for (const f of ['Title: Call landlord', 'Area: Personal', 'Priority: —', 'Status: Not started', 'Due: Tue 17 Nov 2026, 15:00']) assert.ok(tg.sent[0].text.includes(f), f);
});

test('D2 done: free text asks first, a tapped Done does not', async () => {
  const { store, tg, agent } = setup({ store: { tasks: [{ kind: 'task', id: 't1', title: 'Landlord call', status: 'Not started', due: '2026-11-17', remindersSent: [] }] } });
  await agent.handleUpdate(msg('done with landlord call'));
  assert.equal(store.tasks[0].status, 'Not started');
  await agent.handleUpdate(tap(dataOf(tg.last(), /Landlord call/)));
  assert.equal(store.tasks[0].status, 'Done');
});

test('D3 stage change needs Confirm and sets a follow-up', async () => {
  const { store, tg, agent } = setup({ store: { apps: [{ kind: 'app', id: 'a1', title: 'AIB — Risk Graduate Analyst', company: 'AIB', role: 'Risk Graduate Analyst grad', stage: 'Applied', remindersSent: [] }] } });
  await agent.handleUpdate(msg('AIB grad risk: online test done'));
  assert.equal(store.apps[0].stage, 'Applied');
  assert.match(tg.last().text, /from Applied to Online test/);
  await agent.handleUpdate(tap(dataOf(tg.last(), /^Confirm$/)));
  assert.equal(store.apps[0].stage, 'Online test');
  assert.equal(store.apps[0].followUp, '2026-11-23');
});

test('D4 change an existing date: shows old and new, changes only after Yes', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('call landlord tomorrow 3pm'));
  await agent.handleUpdate(tap(dataOf(tg.sent[0], /Change date/)));
  await agent.handleUpdate(replyTo(tg.last(), 'friday'));
  assert.match(tg.last().text, /from Tue 17 Nov 2026 to Fri 20 Nov 2026/);
  assert.equal(store.tasks[0].due, '2026-11-17');
  await agent.handleUpdate(tap(dataOf(tg.last(), /Yes, move it/)));
  assert.equal(store.tasks[0].due, '2026-11-20');
});

test('D5 delete: always asks "sure?" first, Undo included', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('buy printer paper'));
  await agent.handleUpdate(tap(dataOf(tg.sent[0], /Undo/)));
  assert.match(tg.last().text, /Sure you want to delete/);
  assert.equal(store.trashed.length, 0);
  await agent.handleUpdate(tap(dataOf(tg.last(), /Yes, delete/)));
  assert.deepEqual(store.trashed, [store.tasks[0].id]);
  // Free-text delete of another item: pick, then "sure?", then trash.
  await agent.handleUpdate(msg('buy printer paper'));
  await agent.handleUpdate(msg('delete printer paper'));
  await agent.handleUpdate(tap(dataOf(tg.last(), /🗑/)));
  assert.match(tg.last().text, /Sure you want to delete/);
  assert.equal(store.trashed.length, 1);
});

test('D6 create a calendar event only after Create', async () => {
  const { cal, tg, agent } = setup();
  await agent.handleUpdate(msg('book gym session thursday 6pm'));
  assert.match(tg.last().text, /Thu 19 Nov 2026, 18:00–19:00/);
  assert.equal(cal.created.length, 0);
  await agent.handleUpdate(tap(dataOf(tg.last(), /^Create$/)));
  assert.equal(cal.created.length, 1);
  assert.equal(cal.created[0].calendarId, 'personal');
});

test('D7 edit and delete events: allowed, each behind a confirmation', async () => {
  const events = [{ id: 'e1', calendarId: 'personal', title: 'Dentist', allDay: false, date: '2026-11-18', start: '10:00', end: '10:30' }];
  const { cal, tg, agent } = setup({ cal: { events } });
  await agent.handleUpdate(msg('move dentist to friday 4pm'));
  assert.match(tg.last().text, /from Wed 18 Nov 2026, 10:00\nto Fri 20 Nov 2026, 16:00/);
  assert.equal(cal.patched.length, 0);
  await agent.handleUpdate(tap(dataOf(tg.last(), /Yes, change it/)));
  assert.equal(cal.patched.length, 1);
  await agent.handleUpdate(msg('cancel dentist'));
  await agent.handleUpdate(tap(dataOf(tg.last(), /Dentist/)));
  assert.equal(cal.removed.length, 0);
  await agent.handleUpdate(tap(dataOf(tg.last(), /Yes, delete event/)));
  assert.deepEqual(cal.removed, [['personal', 'e1']]);
});

test('AG-06 a stranger gets no reply', async () => {
  const { tg, agent } = setup();
  await agent.handleUpdate({ message: { message_id: 1, from: { id: 999 }, chat: { id: 999 }, text: 'hi' } });
  assert.equal(tg.sent.length, 0);
});

test('Language: Indonesian message gets an Indonesian reply, /lang en pins English', async () => {
  const { store, tg, agent } = setup();
  await agent.handleUpdate(msg('/lang auto'));
  await agent.handleUpdate(msg('beli kertas printer besok dong'));
  assert.match(tg.sent.find((m) => /Notion/.test(m.text)).text, /Udah gue tulis Task/);
  await agent.handleUpdate(msg('/lang en'));
  assert.equal(store.state.lang, 'en');
});

test('Expired button is answered, not ignored', async () => {
  const { tg, agent } = setup();
  await agent.handleUpdate(tap('zzz'));
  assert.match(tg.last().text, /expired/);
});

test('Model ranking: light text models first, no audio, image or video models', async () => {
  const { rankModels } = await import('../src/llm.js');
  const ranked = rankModels(['gemini-3.8-flash', 'gemini-3.8-flash-tts', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-omni-1.1-flash', 'gemini-3.1-flash-image', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-4-argon']);
  assert.deepEqual(ranked, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash']);
});

test('Gemini client: a model that times out or is overloaded falls through to the next one', async () => {
  const { geminiClient } = await import('../src/llm.js');
  const calls = [];
  const fetchFake = async (url) => {
    if (url.includes('/models?')) return { ok: true, json: async () => ({ models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }) };
    const m = url.match(/models\/([^:]+):/)[1]; calls.push(m);
    if (m === 'gemini-3.5-flash-lite') { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; }
    if (m === 'gemini-3.1-flash-lite') return { ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ error: { message: 'overloaded' } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"intent":"task"}' }] } }] }) };
  };
  const llm = geminiClient({ key: 'k' }, fetchFake, () => '2026-11-16', {});
  assert.deepEqual(await llm.generate([{ text: 'x' }], { json: true }), { intent: 'task' });
  assert.deepEqual(calls, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash']);
  assert.equal(llm.model(), 'gemini-3.8-flash');
  await llm.generate([{ text: 'x' }], { json: true });
  assert.equal(calls[3], 'gemini-3.8-flash', 'the model that worked is tried first next time');
});

test('A Word file sent on its own: asks what it is and which project, then saves the plan from its text', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const { docxText } = await import('../src/docx.js');
  // A minimal one-entry zip holding word/document.xml, deflated, the way Word writes it.
  const xml = Buffer.from('<w:document><w:body><w:p><w:r><w:t>Lit review 17 nov (me)</w:t></w:r></w:p><w:p><w:r><w:t>Model &amp; data 18 nov Aoife</w:t></w:r></w:p></w:body></w:document>');
  const data = deflateRawSync(xml); const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(xml.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + data.length, 16);
  const docx = Buffer.concat([local, name, data, cd, name, end]);
  assert.equal(docxText(docx), 'Lit review 17 nov (me)\nModel & data 18 nov Aoife');

  const { store, tg, agent } = setup();
  tg.api.download = async () => docx;
  await agent.handleUpdate(msg('', { document: { file_id: 'f1', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', file_name: 'Derivatives_meeting_1.docx' } }));
  assert.match(tg.last().text, /What is it\?/);
  await agent.handleUpdate(tap(dataOf(tg.last(), /Meeting notes/)));
  await agent.handleUpdate(tap(dataOf(tg.last(), /New project: Derivatives meeting 1/)));
  const task = store.tasks.find((t) => t.title === 'Derivatives meeting 1');
  assert.equal(JSON.parse(task.plan).status, 'agreed');
  assert.equal(JSON.parse(task.plan).milestones.length, 3);
  assert.match(tg.last().text, /Add your 2 dated items/);
});

test('A photo or old .doc file is refused with what to send instead', async () => {
  const { tg, agent } = setup();
  await agent.handleUpdate(msg('', { document: { file_id: 'f2', mime_type: 'application/msword', file_name: 'notes.doc' } }));
  assert.match(tg.last().text, /PDF, Word \(\.docx\) and plain text/);
});

test('OpenAI-compatible client: picks a text model, asks for JSON, refuses files', async () => {
  const { openaiClient, rankOpenAIModels } = await import('../src/llm.js');
  assert.deepEqual(rankOpenAIModels(['whisper-large-v3', 'llama-3.3-70b-versatile', 'meta-llama/llama-guard-4-12b', 'openai/gpt-oss-120b', 'some-new-model']), ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'some-new-model']);
  const sent = [];
  const fetchFake = async (url, opt) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-120b' }] }) };
    sent.push({ url, auth: opt.headers.Authorization, body: JSON.parse(opt.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"intent":"task"}' } }] }) };
  };
  const c = openaiClient({ key: 'k', baseUrl: 'https://api.groq.com/openai/v1/', name: 'Groq' }, fetchFake, () => '2026-11-16', {});
  assert.deepEqual(await c.generate([{ text: 'buy paper friday' }], { json: true }), { intent: 'task' });
  assert.equal(sent[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(sent[0].auth, 'Bearer k');
  assert.equal(sent[0].body.model, 'openai/gpt-oss-120b');
  assert.deepEqual(sent[0].body.response_format, { type: 'json_object' });
  await assert.rejects(() => c.generate([{ inline_data: { mime_type: 'application/pdf', data: '' } }]), /cannot read files/);
});

test('Provider chain: first provider answers text, falls back when it fails, PDFs go to the one that reads files', async () => {
  const { llmChain } = await import('../src/llm.js');
  const { ServiceError } = await import('../src/notion.js');
  const calls = [];
  const mk = (name, files, fail) => ({ name, files, enabled: true, model: () => 'm', usage: () => ({ calls: 1, quotaErrors: 0, lastError: null }), generate: async () => { calls.push(name); if (fail()) throw new ServiceError('llm', 503, `${name} down`); return name; } });
  let groqDown = false;
  const chain = llmChain([mk('Groq', false, () => groqDown), mk('Gemini', true, () => false), { enabled: false }]);
  assert.deepEqual(chain.providers(), ['Groq', 'Gemini']);
  assert.equal(await chain.generate([{ text: 'x' }]), 'Groq');
  assert.equal(await chain.generate([{ text: 'x' }, { inline_data: {} }]), 'Gemini');
  groqDown = true;
  assert.equal(await chain.generate([{ text: 'x' }]), 'Gemini');
  assert.deepEqual(calls, ['Groq', 'Gemini', 'Groq', 'Gemini']);
  const none = llmChain([mk('Groq', false, () => false)]);
  await assert.rejects(() => none.generate([{ inline_data: {} }]), /reads PDFs/);
});

const NET = () => [
  { kind: 'net', id: 'n1', title: 'Meet the Firm – BNY Dublin (participation confirmed)', org: 'BNY', status: 'Upcoming', date: '2026-11-17', time: '14:30', prep: 'Bring photo ID. Ask analysts what surprised them.', people: '', topics: '', takeaways: '', nextSteps: '', plays: [] },
  { kind: 'net', id: 'n2', title: 'Route to the Boardroom with EY & WTW', org: 'EY, WTW', status: 'Upcoming', date: '2026-11-17', time: '08:00', prep: 'Leave with two names.', people: '', topics: '', takeaways: '', nextSteps: '', plays: [] },
  { kind: 'net', id: 'n3', title: 'PMI Ireland Student Club Launch', org: 'PMI', status: 'Upcoming', date: '2026-11-18', time: '18:00', prep: 'Find the Deloitte speaker.', people: '', topics: '', takeaways: '', nextSteps: '', plays: [] },
];

test('/prep shows every event on the next event day; a plain question finds one by name', async () => {
  const { tg, agent } = setup({ store: { net: NET() } });
  await agent.handleUpdate(msg('/prep'));
  const shown = tg.sent.map((m) => m.text).join('\n');
  assert.match(shown, /Route to the Boardroom/);
  assert.match(shown, /Bring photo ID/);
  assert.doesNotMatch(shown, /PMI Ireland/);
  tg.sent.length = 0;
  await agent.handleUpdate(msg('what should I ask at BNY tomorrow?'));
  assert.match(tg.last().text, /Meet the Firm/);
  assert.match(tg.last().text, /Ask analysts what surprised them/);
});

test('/net with the model down: matches the event, files the text, sets a follow-up for tomorrow, says what to do next', async () => {
  const { store, tg, agent } = setup({ llmDown: true, store: { net: NET() } });
  await agent.handleUpdate(msg('/net BNY Meet the Firm: met Aoife, analyst in risk. Talked about the grad programme. She said email her next week'));
  const row = store.net.find((r) => r.id === 'n1');
  assert.equal(row.status, 'Attended');
  assert.equal(row.followUp, '2026-11-17');
  assert.match(row.topics, /met Aoife/);
  assert.equal(store.net.length, 3, 'no duplicate row');
  assert.match(tg.last().text, /Added to "Meet the Firm/);
  assert.match(tg.last().text, /language model is not reachable/);
  assert.match(tg.last().text, /What to do next/);
  await agent.handleUpdate(tap(dataOf(tg.last(), /Followed up/)));
  assert.equal(row.status, 'Followed up');
});

test('/net with the model: fields are split, a thank-you play is set, an unknown event becomes a new row', async () => {
  const { store, tg, agent } = setup({ store: { net: NET() } });
  PARSES['Coffee with Niamh from AIB credit risk, she suggested I read the IRB guide'] = { event: 'Coffee with Niamh', organisation: 'AIB', people: 'Niamh (credit risk, AIB)', topics: 'IRB models', takeaways: 'Read the IRB guide', next_steps: '', follow_up_text: 'friday', plays: ['Learn'] };
  await agent.handleUpdate(msg('/net Coffee with Niamh from AIB credit risk, she suggested I read the IRB guide'));
  const row = store.net[3];
  assert.equal(row.title, 'Coffee with Niamh');
  assert.equal(row.people, 'Niamh (credit risk, AIB)');
  assert.equal(row.followUp, '2026-11-20');
  assert.deepEqual(row.plays, ['Learn']);
  assert.match(tg.last().text, /Within 24h/);
  assert.ok(dataOf(tg.last(), /Draft the thank-you/));
});

test('/followups lists conversations waiting, and the digest reminds on the day', async () => {
  const net = NET(); Object.assign(net[0], { status: 'Attended', followUp: '2026-11-16', nextSteps: 'Email Aoife' });
  const { tg, agent } = setup({ store: { net } });
  await agent.handleUpdate(msg('/followups'));
  assert.match(tg.last().text, /Waiting for a follow-up \(1\)/);
  assert.match(tg.last().text, /Email Aoife/);
  await agent.sendDigest({ manual: true });
  assert.match(tg.last().text, /Networking follow-ups/);
});
