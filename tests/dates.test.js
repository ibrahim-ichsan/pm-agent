import test from 'node:test';
import assert from 'node:assert/strict';
import { readDate, toInstant, parts, mondayOf, pretty } from '../src/dates.js';
const MON = '2026-11-16'; // a Monday
const d = (s) => readDate(s, MON);
test('weekday means the next one, today included', () => {
  assert.equal(d('submit report friday').date, '2026-11-20');
  assert.equal(d('gym monday').date, '2026-11-16');
  assert.equal(d('gym next monday').date, '2026-11-23');
  assert.equal(d('kumpul jumat').date, '2026-11-20');
});
test('relative words', () => {
  assert.equal(d('call landlord tomorrow 3pm').date, '2026-11-17');
  assert.equal(d('call landlord tomorrow 3pm').time, '15:00');
  assert.equal(d('besok jam 9').time, '09:00');
  assert.equal(d('next week review').date, '2026-11-23');
});
test('day and month', () => {
  assert.equal(d('deadline 30 nov').date, '2026-11-30');
  assert.equal(d('due Dec 5').date, '2026-12-05');
  assert.equal(d('meeting 5/12').date, '2026-12-05');
  assert.equal(d('exam 14 jan').date, '2027-01-14');
  assert.equal(d('2026-12-01 thing').date, '2026-12-01');
});
test('a date that does not exist is flagged, not guessed', () => {
  const r = d('report due 31 feb'); assert.equal(r.invalid, true); assert.equal(r.date, null);
});
test('no date', () => { const r = d('buy printer paper'); assert.equal(r.date, null); assert.equal(r.time, null); });
test('times', () => { assert.equal(d('at 15:30').time, '15:30'); assert.equal(d('9.15am standup').time, '09:15'); });
test('Dublin wall clock to instant, winter and summer', () => {
  assert.equal(toInstant('2026-11-16', '07:00').toISOString(), '2026-11-16T07:00:00.000Z');
  assert.equal(toInstant('2026-07-01', '07:00').toISOString(), '2026-07-01T06:00:00.000Z');
  assert.equal(parts(new Date('2026-07-01T06:00:00Z')).time, '07:00');
});
test('helpers', () => { assert.equal(mondayOf('2026-11-19'), '2026-11-16'); assert.equal(pretty('2026-11-20'), 'Fri 20 Nov 2026'); });
import { splitDate } from '../src/notion.js';
test('Notion date-times become Dublin wall-clock time', () => {
  assert.deepEqual(splitDate({ start: '2026-07-01T14:00:00.000Z' }), { date: '2026-07-01', time: '15:00' });
  assert.deepEqual(splitDate({ start: '2026-11-17T15:00:00.000+00:00' }), { date: '2026-11-17', time: '15:00' });
  assert.deepEqual(splitDate({ start: '2026-11-17' }), { date: '2026-11-17', time: null });
});
