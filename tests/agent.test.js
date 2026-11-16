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
  const llm = fakeLlm((m, full) => (/task breakdown/.test(full) ? BREAKDOWN : /agreed project timeline/.test(full) ? PLAN : PARSES[m] || 'Bring your notes.'), { down: llmDown });
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
  await agent.handleUpdate(tap(dataOf(tg.last(), /Yes, add to calendar/)));
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

test('A8 model down: whole text as a Task, no date, tells him how to turn it back on', async () => {
  const { store, tg, agent } = setup({ llmDown: true });
  await agent.handleUpdate(msg('submit derivatives group report friday'));
  assert.equal(store.tasks[0].title, 'submit derivatives group report friday');
  assert.equal(store.tasks[0].due, null);
  assert.match(tg.sent[0].text, /language model is not reachable/);
  assert.ok(tg.sent.some((m) => /Turn the model back on/.test(m.text) && /Model usage/.test(m.text) && !/⚠️/.test(m.text)));
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
