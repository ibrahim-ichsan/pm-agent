// Notion REST client and the mapping between Notion pages and the bot's items.
// Uses the data source endpoints (Notion-Version 2025-09-03).

import { parts } from './dates.js';

const API = 'https://api.notion.com/v1';
const VERSION = '2025-09-03';

export class ServiceError extends Error {
  constructor(service, status, message) { super(message); this.service = service; this.status = status; }
}

export function notionClient(token, fetchImpl = fetch) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(API + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw new ServiceError('notion', 0, e.message); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ServiceError('notion', res.status, data.message || res.statusText);
    return data;
  }
  async function queryAll(dataSource, body = {}) {
    const out = [];
    let cursor;
    do {
      const r = await call('POST', `/data_sources/${dataSource}/query`, { ...body, page_size: 100, start_cursor: cursor });
      out.push(...r.results);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    return out;
  }
  return {
    queryAll,
    create: (dataSource, properties) => call('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: dataSource }, properties }),
    update: (pageId, properties) => call('PATCH', `/pages/${pageId}`, { properties }),
    trash: (pageId) => call('PATCH', `/pages/${pageId}`, { in_trash: true }),
    restore: (pageId) => call('PATCH', `/pages/${pageId}`, { in_trash: false }),
  };
}

// ---- reading property values
const plain = (arr) => (arr || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('');
export function read(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title': return plain(prop.title);
    case 'rich_text': return plain(prop.rich_text);
    case 'select': return prop.select?.name ?? null;
    case 'status': return prop.status?.name ?? null;
    case 'multi_select': return (prop.multi_select || []).map((o) => o.name);
    case 'url': return prop.url ?? null;
    case 'number': return prop.number ?? null;
    case 'created_time': return prop.created_time;
    case 'date': return prop.date ? { start: prop.date.start, end: prop.date.end } : null;
    default: return null;
  }
}
// "2026-11-17T15:00:00.000+00:00" -> { date: '2026-11-17', time: '15:00' } in the wall clock Notion stored.
export function splitDate(d) {
  if (!d?.start) return { date: null, time: null };
  if (!d.start.includes('T')) return { date: d.start, time: null };
  // A date-time with an offset or Z is converted to Dublin wall-clock time.
  if (/(Z|[+-]\d{2}:\d{2})$/.test(d.start)) { const p = parts(new Date(d.start)); return { date: p.date, time: p.time }; }
  const [date, rest] = d.start.split('T');
  return { date, time: rest.slice(0, 5) };
}

// ---- writing property values
export const w = {
  title: (s) => ({ title: [{ text: { content: String(s).slice(0, 2000) } }] }),
  text: (s) => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 2000) } }] : [] }),
  select: (s) => ({ select: s ? { name: s } : null }),
  status: (s) => ({ status: { name: s } }),
  multi: (list) => ({ multi_select: (list || []).map((name) => ({ name })) }),
  url: (s) => ({ url: s || null }),
  number: (n) => ({ number: n ?? null }),
  date: (date, time) => ({ date: date ? (time ? { start: `${date}T${time}:00`, time_zone: 'Europe/Dublin' } : { start: date }) : null }),
};

// ---- items
const sent = (s) => (s ? s.split(/\s+/).filter(Boolean) : []);

export function toTask(page) {
  const p = page.properties;
  const due = splitDate(read(p.Due));
  return {
    kind: 'task', id: page.id, url: page.url, created: page.created_time,
    title: read(p.Task) || '(untitled)', status: read(p.Status) || 'Not started',
    area: read(p.Area), priority: read(p.Priority), due: due.date, time: due.time,
    details: read(p.Details) || '', brief: read(p.Brief) || '', plan: read(p.Plan) || '',
    calendarEvents: read(p['Calendar events']) || '', remindersSent: sent(read(p['Reminders sent'])),
  };
}
export function taskProps(t) {
  const out = {};
  if ('title' in t) out.Task = w.title(t.title);
  if ('status' in t) out.Status = w.status(t.status);
  if ('area' in t) out.Area = w.select(t.area);
  if ('priority' in t) out.Priority = w.select(t.priority);
  if ('due' in t) out.Due = w.date(t.due, t.time);
  for (const [k, n] of [['details', 'Details'], ['brief', 'Brief'], ['plan', 'Plan'], ['calendarEvents', 'Calendar events']]) if (k in t) out[n] = w.text(t[k]);
  if ('remindersSent' in t) out['Reminders sent'] = w.text(t.remindersSent.slice(-20).join(' '));
  return out;
}

export function toApp(page) {
  const p = page.properties;
  const deadline = splitDate(read(p.Deadline));
  return {
    kind: 'app', id: page.id, url: page.url, created: page.created_time,
    title: read(p.Application) || '(untitled)', company: read(p.Company) || '', role: read(p.Role) || '',
    stage: read(p.Stage) || 'Applied', track: read(p.Track),
    due: deadline.date, time: deadline.time,
    appliedOn: splitDate(read(p['Applied on'])).date, lastUpdate: splitDate(read(p['Last update'])).date,
    followUp: splitDate(read(p['Next follow-up'])).date, nextAction: read(p['Next action']) || '',
    jobUrl: read(p['Job URL']), notes: read(p.Notes) || '', remindersSent: sent(read(p['Reminders sent'])),
  };
}
export function appProps(a) {
  const out = {};
  if ('title' in a) out.Application = w.title(a.title);
  if ('company' in a) out.Company = w.text(a.company);
  if ('role' in a) out.Role = w.text(a.role);
  if ('stage' in a) out.Stage = w.status(a.stage);
  if ('track' in a) out.Track = w.select(a.track);
  if ('due' in a) out.Deadline = w.date(a.due, a.time);
  if ('appliedOn' in a) out['Applied on'] = w.date(a.appliedOn);
  if ('lastUpdate' in a) out['Last update'] = w.date(a.lastUpdate);
  if ('followUp' in a) out['Next follow-up'] = w.date(a.followUp);
  if ('nextAction' in a) out['Next action'] = w.text(a.nextAction);
  if ('jobUrl' in a) out['Job URL'] = w.url(a.jobUrl);
  if ('notes' in a) out.Notes = w.text(a.notes);
  if ('remindersSent' in a) out['Reminders sent'] = w.text(a.remindersSent.slice(-20).join(' '));
  return out;
}

// Networking log: one row per event or conversation.
export function toNet(page) {
  const p = page.properties;
  const d = splitDate(read(p.Date));
  return {
    kind: 'net', id: page.id, url: page.url, title: read(p.Event) || '(untitled)', status: read(p.Status) || 'Upcoming',
    date: d.date, time: d.time, type: read(p.Type), track: read(p.Track), org: read(p.Organisation) || '',
    people: read(p['People met']) || '', topics: read(p.Topics) || '', takeaways: read(p.Takeaways) || '',
    nextSteps: read(p['Next steps']) || '', plays: read(p['Next play']) || [], followUp: splitDate(read(p['Follow-up by'])).date,
    prep: read(p.Prep) || '', link: read(p.Link),
  };
}
export function netProps(x) {
  const out = {};
  if ('title' in x) out.Event = w.title(x.title);
  if ('status' in x) out.Status = w.status(x.status);
  if ('date' in x) out.Date = w.date(x.date, x.time);
  if ('type' in x) out.Type = w.select(x.type);
  if ('track' in x) out.Track = w.select(x.track);
  if ('plays' in x) out['Next play'] = w.multi(x.plays);
  if ('followUp' in x) out['Follow-up by'] = w.date(x.followUp);
  for (const [k, n] of [['org', 'Organisation'], ['people', 'People met'], ['topics', 'Topics'], ['takeaways', 'Takeaways'], ['nextSteps', 'Next steps'], ['prep', 'Prep']]) if (k in x) out[n] = w.text(x[k]);
  return out;
}

// The CreditFlow Tracker: read generously, write only Status.
export function toRoadmap(page) {
  const p = page.properties;
  const titleKey = Object.keys(p).find((k) => p[k].type === 'title');
  return {
    kind: 'roadmap', id: page.id, url: page.url,
    title: read(p[titleKey]) || '(untitled)', status: read(p.Status) || '', statusType: p.Status?.type || 'status',
    priority: read(p.Prioritas), week: splitDate(read(p.Minggu)).date, track: read(p.Track),
  };
}

export const STAGES = ['Wishlist', 'Applied', 'Online test', 'Interview', 'Offer', 'Rejected', 'Withdrawn'];
export const CLOSED_STAGES = ['Offer', 'Rejected', 'Withdrawn'];

// The store the agent talks to. Every method maps to one or two Notion calls.
export function notionStore(client, ds) {
  const state = new Map(); // key -> { id, value }
  let stateLoaded = false;
  async function loadState() {
    if (stateLoaded) return;
    for (const page of await client.queryAll(ds.state)) state.set(read(page.properties.Key), { id: page.id, value: read(page.properties.Value) });
    stateLoaded = true;
  }
  return {
    async openTasks() {
      const pages = await client.queryAll(ds.tasks, { filter: { property: 'Status', status: { does_not_equal: 'Done' } } });
      return pages.map(toTask);
    },
    async tasksDoneSince(date) {
      const pages = await client.queryAll(ds.tasks, { filter: { and: [{ property: 'Status', status: { equals: 'Done' } }, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: date } }] } });
      return pages.map(toTask);
    },
    async openApps() {
      const pages = await client.queryAll(ds.applications, { filter: { and: CLOSED_STAGES.map((s) => ({ property: 'Stage', status: { does_not_equal: s } })) } });
      return pages.map(toApp);
    },
    async allApps() { return (await client.queryAll(ds.applications)).map(toApp); },
    async roadmap() { return ds.roadmap ? (await client.queryAll(ds.roadmap)).map(toRoadmap) : []; },
    async createTask(t) { return toTask(await client.create(ds.tasks, taskProps({ status: 'Not started', ...t }))); },
    async createApp(a) { return toApp(await client.create(ds.applications, appProps({ stage: 'Applied', ...a }))); },
    async updateTask(id, patch) { return toTask(await client.update(id, taskProps(patch))); },
    async updateApp(id, patch) { return toApp(await client.update(id, appProps(patch))); },
    async setRoadmapDone(item) {
      const prop = item.statusType === 'select' ? { select: { name: 'Done' } } : { status: { name: 'Done' } };
      await client.update(item.id, { Status: prop });
    },
    async createShift(x) {
      await client.create(ds.shifts, { Shift: w.title(x.title), Employer: w.text(x.employer), Date: w.date(x.date), Hours: w.number(x.hours), 'Rate EUR': w.number(x.rate) });
    },
    networkingReady: !!ds.networking,
    // Rows still in play: upcoming events and conversations waiting for a follow-up.
    async networking() {
      if (!ds.networking) return [];
      const pages = await client.queryAll(ds.networking, { filter: { or: [{ property: 'Status', status: { equals: 'Upcoming' } }, { property: 'Status', status: { equals: 'Attended' } }] } });
      return pages.map(toNet);
    },
    async createNet(x) { return toNet(await client.create(ds.networking, netProps({ status: 'Attended', ...x }))); },
    async updateNet(id, patch) { return toNet(await client.update(id, netProps(patch))); },
    async trash(id) { await client.trash(id); },
    async getState(key) { await loadState(); return state.get(key)?.value ?? null; },
    async setState(key, value) {
      await loadState();
      const cur = state.get(key);
      if (cur) await client.update(cur.id, { Value: w.text(value) });
      else {
        const page = await client.create(ds.state, { Key: w.title(key), Value: w.text(value) });
        state.set(key, { id: page.id, value });
        return;
      }
      cur.value = value;
    },
  };
}
