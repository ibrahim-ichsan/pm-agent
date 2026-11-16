// Runs every minute. Each job remembers the last date it ran in Notion (Agent State),
// so a restart or a double trigger never sends the same digest twice.
import { parts, weekdayOf } from './dates.js';
import { dueReminders } from './reminders.js';

export function createScheduler({ cfg, store, agent, clock = () => new Date(), log = console }) {
  const running = new Set();
  let checkedOnce = false;
  async function once(key, date, fn) {
    if (running.has(key)) return;
    running.add(key);
    try {
      if ((await store.getState(key)) === date) return;
      await store.setState(key, date); // mark first: a failed send is reported, not repeated every minute
      await fn();
    } catch (e) { log.error?.(`${key} failed`, e); }
    finally { running.delete(key); }
  }
  // Fire when the clock is at or past the slot and within 3 hours of it (catches a late restart, not a next-day one).
  const due = (now, slot) => now.time >= slot && now.time < addHours(slot, 3);

  async function tick() {
    const now = parts(clock());
    const t = cfg.times;
    if (due(now, t.digest)) await once('lastDigest', now.date, () => agent.sendDigest());
    if (weekdayOf(now.date) === 3 && due(now, t.midweek)) await once('lastMidweek', now.date, () => agent.sendReview('midweek'));
    if (weekdayOf(now.date) === 0 && due(now, t.weekly)) await once('lastWeekly', now.date, () => agent.sendReview('weekly'));
    // Reminders: checked every 15 minutes; dueReminders decides slot and quiet hours.
    const m = Number(now.time.slice(3));
    if ((m % 15 === 0 || !checkedOnce) && !running.has('reminders')) {
      checkedOnce = true;
      running.add('reminders');
      try {
        const items = [...(await store.openTasks()), ...(await store.openApps())];
        for (const r of dueReminders(items, now, t, cfg.leadDays)) await agent.sendReminder(r);
      } catch (e) { log.error?.('reminders failed', e); }
      finally { running.delete('reminders'); }
    }
  }
  return { tick };
}
function addHours(hhmm, h) { const [a, b] = hhmm.split(':').map(Number); return `${String(Math.min(a + h, 23)).padStart(2, '0')}:${String(b).padStart(2, '0')}`; }
