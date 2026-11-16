// Table C: reminder timing. Item due Fri 20 Nov 2026, lead times 3, 1, 0 days at 09:00.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, keyFor } from '../src/reminders.js';
import { createScheduler } from '../src/scheduler.js';
import { addDays } from '../src/dates.js';
import { cfg, fakeStore } from './fakes.js';

const times = cfg.times; const lead = cfg.leadDays;
const item = (extra = {}) => ({ kind: 'task', id: 't', title: 'Report', due: '2026-11-20', created: '2026-11-16T08:00:00Z', remindersSent: [], ...extra });

// Simulates every day from Mon 16 to Mon 23 at 09:00; applies changes on given days.
function simulate(it, changes = {}) {
  const sentOn = [];
  for (let d = '2026-11-16'; d <= '2026-11-23'; d = addDays(d, 1)) {
    if (changes[d]?.before) changes[d].before(it);
    if (it.status === 'Done') continue;
    for (const r of dueReminders([it], { date: d, time: '09:00' }, times, lead)) {
      sentOn.push(`${d.slice(8)}:${r.item.due.slice(8)}`);
      it.remindersSent.push(r.key);
      // a second scheduler pass at the same minute must not send again
      assert.equal(dueReminders([it], { date: d, time: '09:15' }, times, lead).length, 0);
    }
    if (changes[d]?.after) changes[d].after(it);
  }
  return sentOn;
}

test('C1 created Mon 16: Tue 17, Thu 19, Fri 20', () => assert.deepEqual(simulate(item()), ['17:20', '19:20', '20:20']));
test('C2 created Wed 18 14:00: Thu 19 and Fri 20', () => assert.deepEqual(simulate(item({ created: '2026-11-18T14:00:00Z' })), ['19:20', '20:20']));
test('C3 created Fri 20 10:00: none', () => assert.deepEqual(simulate(item({ created: '2026-11-20T10:00:00Z' })), []));
test('C4 marked Done Wed 18: Tue 17 only', () => assert.deepEqual(simulate(item(), { '2026-11-18': { before: (i) => { i.status = 'Done'; } } }), ['17:20']));
test('C5 moved on Thu 19 to Mon 23: old date then new date', () => {
  assert.deepEqual(simulate(item(), { '2026-11-19': { after: (i) => { i.due = '2026-11-23'; } } }), ['17:20', '19:20', '20:23', '22:23', '23:23']);
});
test('C6 snoozed on Thu 19: Fri 20 once, not twice', () => {
  assert.deepEqual(simulate(item(), { '2026-11-19': { after: (i) => { i.remindersSent.push('snooze:2026-11-20'); } } }), ['17:20', '19:20', '20:20']);
});
test('C7 slot inside quiet hours is held to 07:00', () => {
  const quiet = { ...times, reminder: '23:30' };
  assert.equal(dueReminders([item()], { date: '2026-11-20', time: '23:45' }, quiet, lead).length, 0);
  assert.equal(dueReminders([item()], { date: '2026-11-20', time: '06:59' }, quiet, lead).length, 0);
  assert.equal(dueReminders([item()], { date: '2026-11-20', time: '07:00' }, quiet, lead).length, 1);
});
test('C8 no date: no reminder', () => assert.equal(dueReminders([item({ due: null })], { date: '2026-11-20', time: '09:00' }, times, lead).length, 0));
test('Before 09:00 nothing goes out', () => assert.equal(dueReminders([item()], { date: '2026-11-20', time: '08:59' }, times, lead).length, 0));
test('Key format is stable', () => assert.equal(keyFor(item(), '2026-11-17'), 'r:2026-11-20:2026-11-17'));

test('Scheduler: digest once per day even when it fires twice; reviews on Wed and Sun only', async () => {
  const store = fakeStore();
  const calls = [];
  const agent = { sendDigest: async () => calls.push('digest'), sendReview: async (k) => calls.push(k), sendReminder: async () => calls.push('rem') };
  let now = new Date('2026-11-16T07:00:00Z');
  const s = createScheduler({ cfg, store: store.api, agent, clock: () => now, log: { error() {} } });
  await s.tick(); now = new Date('2026-11-16T07:05:00Z'); await s.tick();
  assert.deepEqual(calls, ['digest']);
  now = new Date('2026-11-18T13:00:00Z'); await s.tick(); // Wednesday
  assert.ok(calls.includes('midweek'));
  now = new Date('2026-11-22T18:01:00Z'); await s.tick(); // Sunday
  assert.ok(calls.includes('weekly'));
  now = new Date('2026-11-17T13:00:00Z'); await s.tick(); // Tuesday 13:00: digest is past its window, no review
  assert.equal(calls.filter((c) => c === 'midweek').length, 1);
});
