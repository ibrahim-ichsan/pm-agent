// Which reminders go out now. Pure functions, so Table C is tested without a clock or a network.
import { addDays, toInstant } from './dates.js';

const inQuiet = (time, from, to) => (from > to ? time >= from || time < to : time >= from && time < to);

// The send time for a reminder slot. A slot inside quiet hours is held to the end of quiet hours.
export function slotTime(times) { return inQuiet(times.reminder, times.quietFrom, times.quietTo) ? times.quietTo : times.reminder; }

// Dates on which an item should get a reminder: lead days before its due date, plus any snooze date.
export function sendDates(item, leadDays) {
  if (!item.due) return [];
  const dates = leadDays.map((n) => addDays(item.due, -n));
  for (const s of item.remindersSent || []) if (s.startsWith('snooze:')) dates.push(s.slice(7));
  return [...new Set(dates)].sort();
}
export const keyFor = (item, date) => `r:${item.due}:${date}`;

// items: open Tasks and Applications. now: { date, time } in Dublin.
export function dueReminders(items, now, times, leadDays) {
  const at = slotTime(times);
  if (now.time < at || inQuiet(now.time, times.quietFrom, times.quietTo)) return [];
  const out = [];
  for (const item of items) {
    if (!item.due) continue;
    for (const date of sendDates(item, leadDays)) {
      if (date !== now.date) continue;
      const key = keyFor(item, date);
      if ((item.remindersSent || []).includes(key)) continue;
      // An item created after this slot's moment does not get that slot (Table C rows 2 and 3).
      if (item.created && new Date(item.created) > toInstant(date, at)) continue;
      const daysLeft = Math.round((new Date(item.due) - new Date(date)) / 86400000);
      out.push({ item, key, daysLeft });
    }
  }
  return out;
}
