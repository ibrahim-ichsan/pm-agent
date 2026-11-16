// Table B: digest content. Today is Mon 16 Nov 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, buildReview } from '../src/digest.js';

const today = '2026-11-16';
const ev = (i, extra = {}) => ({ id: `e${i}`, calendarId: 'personal', title: `Event ${i}`, allDay: false, date: today, start: `${String(8 + (i % 10)).padStart(2, '0')}:00`, end: '23:00', ...extra });
const task = (title, due, extra = {}) => ({ kind: 'task', id: title, title, due, status: 'Not started', plan: '', calendarEvents: '', ...extra });
const base = { today, events: [], tasks: [], apps: [], roadmap: [], calFailures: [], lang: 'en', seed: 0 };

test('B1 all four blocks, in order', () => {
  const { text } = buildDigest({ ...base,
    events: [ev(1), ev(2, { allDay: true, start: null, end: null, endDate: '2026-11-17', title: 'Reading week' })],
    tasks: [task('Problem set', today)],
    roadmap: [{ title: 'M1 notebook', week: '2026-11-17', status: 'In progress', priority: 'Must' }],
    apps: [{ title: 'AIB — Risk', stage: 'Applied', due: '2026-11-20', appliedOn: today }] });
  const order = ['Today', 'Due', "This week's roadmap", 'Applications'].map((h) => text.indexOf(`<b>${h}</b>`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), text);
  assert.ok(text.indexOf('Reading week') < text.indexOf('Event 1'), 'all-day first');
});

test('B1 adapts to load: busy day names the top three', () => {
  const tasks = Array.from({ length: 9 }, (_, i) => task(`T${i}`, today, { priority: i === 5 ? 'Must' : 'Should' }));
  const { text } = buildDigest({ ...base, tasks });
  assert.match(text, /Packed day|Big day energy/);
  assert.match(text, /Top three: T5, /);
});

test('B1 agreed plan not on the calendar gets an Add button', () => {
  const plan = JSON.stringify({ status: 'agreed', milestones: [{ title: 'Lit review', date: '2026-11-18' }] });
  const { text, buttons } = buildDigest({ ...base, tasks: [task('Group report', '2026-11-28', { plan })] });
  assert.match(text, /not on your calendar yet/);
  assert.equal(buttons[0].action.type, 'plan_to_cal');
  const suggested = JSON.stringify({ status: 'suggested', milestones: [{ title: 'x', date: '2026-11-18' }] });
  assert.equal(buildDigest({ ...base, tasks: [task('G', '2026-11-28', { plan: suggested })] }).buttons.length, 0);
});

test('B2 only something due: one block', () => {
  const { text } = buildDigest({ ...base, tasks: [task('Problem set', today)] });
  assert.match(text, /<b>Due<\/b>/);
  assert.doesNotMatch(text, /<b>Today<\/b>|roadmap|Applications/);
});

test('B3 nothing at all: one line, plus heavy items in the next month', () => {
  const empty = buildDigest(base).text;
  assert.equal(empty, 'Mon 16 Nov 2026: nothing scheduled and nothing due.');
  const { text } = buildDigest({ ...base, tasks: [task('Dissertation proposal', '2026-12-04', { priority: 'Must' }), task('Buy socks', '2026-12-01')], apps: [{ title: 'Citi — Analyst', stage: 'Wishlist', due: '2026-12-10' }] });
  assert.match(text, /Heads-up for the next month/);
  assert.match(text, /Fri 4 Dec 2026: Dissertation proposal/);
  assert.match(text, /Thu 10 Dec 2026: Citi — Analyst \(deadline\)/);
  assert.doesNotMatch(text, /Buy socks/);
});

test('B4 fourteen events: first ten and "4 more"', () => {
  const { text } = buildDigest({ ...base, events: Array.from({ length: 14 }, (_, i) => ev(i)) });
  assert.equal((text.match(/Event \d+/g) || []).length, 10);
  assert.match(text, /…and 4 more/);
});

test('B5 overdue: listed first with "5 days late" and an angry Gen Z line', () => {
  const { text } = buildDigest({ ...base, events: [ev(1)], tasks: [task('Today thing', today), task('Old essay', '2026-11-11')] });
  assert.ok(text.indexOf('Old essay — 5 days late') < text.indexOf('Today thing'));
  assert.match(text, /💀|😤/);
});

test('B6 calendar unreadable: other blocks stay, plus what to do', () => {
  const err = Object.assign(new Error('Not Found'), { service: 'calendar', status: 404 });
  const { text } = buildDigest({ ...base, calFailures: [{ id: 'ucd', error: err }], saEmail: 'bot@x.iam.gserviceaccount.com',
    tasks: [task('Problem set', today)], roadmap: [{ title: 'M1', week: today, status: '' }], apps: [{ title: 'AIB', stage: 'Applied', due: '2026-11-18' }] });
  assert.match(text, /Due[\s\S]*roadmap[\s\S]*Applications/);
  assert.match(text, /Google Calendar failed \(404\)/);
  assert.match(text, /ucd is not shared with bot@x\.iam\.gserviceaccount\.com/);
});

test('Quiet applications collapse into one count line; dated ones keep a line each', () => {
  const quiet = Array.from({ length: 40 }, (_, i) => ({ title: `Co${i} — Grad`, company: `Co${i}`, stage: 'Applied', appliedOn: '2026-09-10' }));
  const apps = [{ title: 'Kerry — Grad', company: 'Kerry', stage: 'Applied', appliedOn: '2026-09-06' }, ...quiet, { title: 'AIB — Risk', stage: 'Applied', appliedOn: '2026-11-10', due: '2026-11-19' }, { title: 'Fresh', stage: 'Applied', appliedOn: '2026-11-10' }];
  const { text } = buildDigest({ ...base, apps });
  assert.match(text, /AIB — Risk: deadline/);
  assert.match(text, /41 with no news for 14\+ days \(oldest: Kerry, \d+ days\)\. \/apps stale/);
  assert.doesNotMatch(text, /Co7 — Grad|Fresh/);
});


test('Weekly and midweek reviews', () => {
  const d = { ...base, today: '2026-11-22', doneThisWeek: [task('Done thing', '2026-11-18')], tasks: [task('Late one', '2026-11-20'), task('Next', '2026-11-25')], apps: [{ title: 'AIB', stage: 'Applied' }, { title: 'PTSB', stage: 'Online test' }] };
  const w = buildReview('weekly', d);
  assert.match(w, /Weekly review · Sun 22 Nov 2026/);
  assert.match(w, /Done since Monday: 1/);
  assert.match(w, /Late one/);
  assert.match(w, /Wed 25 Nov 2026: Next/);
  assert.match(w, /Applied 1 · Online test 1/);
  assert.match(buildReview('midweek', { ...d, today: '2026-11-18' }), /Midweek check/);
});
