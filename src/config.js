// All settings come from environment variables. Nothing secret lives in the repo.
const env = process.env;
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const hhmm = (s, d) => (/^\d{2}:\d{2}$/.test(s || '') ? s : d);

export function loadConfig(e = env) {
  return {
    telegramToken: e.TELEGRAM_TOKEN || '',
    ownerId: Number(e.OWNER_TELEGRAM_ID || 0),
    notionToken: e.NOTION_TOKEN || '',
    notion: {
      tasks: e.NOTION_TASKS_DS || '',
      applications: e.NOTION_APPLICATIONS_DS || '',
      shifts: e.NOTION_SHIFTS_DS || '',
      state: e.NOTION_STATE_DS || '',
      roadmap: e.NOTION_ROADMAP_DS || '',
    },
    gemini: {
      key: e.GEMINI_API_KEY || '',
      model: e.GEMINI_MODEL || '', // empty: pick the newest Flash model the key can use
      dailyLimit: Number(e.GEMINI_DAILY_LIMIT || 0), // 0: unknown, warn only after a quota error
    },
    google: {
      // Service account JSON, pasted whole into one config var.
      serviceAccount: e.GOOGLE_SERVICE_ACCOUNT_JSON || '',
      readCalendars: list(e.CALENDAR_IDS),
      writeCalendar: e.CALENDAR_WRITE_ID || list(e.CALENDAR_IDS)[0] || '',
    },
    times: {
      digest: hhmm(e.DIGEST_TIME, '07:00'),
      reminder: hhmm(e.REMINDER_TIME, '09:00'),
      midweek: hhmm(e.MIDWEEK_TIME, '13:00'),
      weekly: hhmm(e.WEEKLY_TIME, '18:00'),
      quietFrom: '22:00',
      quietTo: '07:00',
    },
    leadDays: [3, 1, 0],
    followUpIdleDays: 14,
  };
}

export function missing(cfg) {
  const out = [];
  if (!cfg.telegramToken) out.push('TELEGRAM_TOKEN');
  if (!cfg.ownerId) out.push('OWNER_TELEGRAM_ID');
  if (!cfg.notionToken) out.push('NOTION_TOKEN');
  for (const [k, v] of Object.entries({ tasks: 'NOTION_TASKS_DS', applications: 'NOTION_APPLICATIONS_DS', shifts: 'NOTION_SHIFTS_DS', state: 'NOTION_STATE_DS' })) if (!cfg.notion[k]) out.push(v);
  return out;
}
