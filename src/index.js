// Entry point: long-polls Telegram and ticks the scheduler once a minute.
import { createServer } from 'node:http';
import { loadConfig, missing } from './config.js';
import { notionClient, notionStore } from './notion.js';
import { calendarClient } from './calendar.js';
import { geminiClient } from './llm.js';
import { telegramClient } from './telegram.js';
import { createAgent } from './agent.js';
import { createScheduler } from './scheduler.js';
import { parts } from './dates.js';

// Heroku's Node buildpack adds a default "web" process that also runs npm start.
// Two pollers fight over getUpdates, so only the worker polls; a web dyno just answers health checks.
const isWeb = (process.env.DYNO || '').startsWith('web');
if (isWeb) {
  const port = process.env.PORT || 3000;
  createServer((_, res) => res.end('ok')).listen(port);
  console.log('This is a web dyno: health endpoint only. The bot runs on the worker dyno.');
} else {
  await main();
}

async function main() {

const cfg = loadConfig();
const gaps = missing(cfg);
if (gaps.length) { console.error(`Missing config vars: ${gaps.join(', ')}`); process.exit(1); }

// Every outside call has a deadline, so one hung request cannot freeze the bot.
const within = (ms) => (url, opt = {}) => fetch(url, { ...opt, signal: opt.signal || AbortSignal.timeout(ms) });
const store = notionStore(notionClient(cfg.notionToken, within(20000)), cfg.notion);
const cal = calendarClient(cfg.google.serviceAccount, within(20000));
const llm = geminiClient(cfg.gemini, within(20000), () => parts(new Date()).date);
const tg = telegramClient(cfg.telegramToken, within(45000));
const agent = createAgent({ cfg, store, cal, llm, tg });
const scheduler = createScheduler({ cfg, store, agent });

await tg.deleteWebhook().catch(() => {});
await tg.setCommands([
  ['today', 'Digest now'], ['week', 'Next 7 days'], ['tasks', 'Open tasks'], ['apps', 'Open applications'],
  ['done', 'Tick things off'], ['add', 'Add a task'], ['brief', 'Send a project brief'], ['plan', 'Save an agreed plan'],
  ['shift', 'Log a part-time shift'], ['usage', 'Model usage'], ['lang', 'en | id | auto'], ['help', 'How to use me'],
].map(([command, description]) => ({ command, description }))).catch((e) => console.warn('setMyCommands failed', e.message));

console.log(`Komplot running. Calendars: ${cfg.google.readCalendars.join(', ') || 'none'}. Model: ${cfg.gemini.key ? cfg.gemini.model || 'auto' : 'off'}.`);
setInterval(() => scheduler.tick().catch((e) => console.error('tick', e)), 60 * 1000);
scheduler.tick().catch((e) => console.error('tick', e));

if (process.env.PORT) createServer((_, res) => res.end('ok')).listen(process.env.PORT);

let offset = 0;
for (;;) {
  try {
    const updates = await tg.getUpdates(offset, 30);
    for (const u of updates) {
      offset = u.update_id + 1;
      await agent.handleUpdate(u).catch((e) => console.error('update', e));
    }
  } catch (e) {
    console.error('poll', e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
}
