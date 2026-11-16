// Google Calendar through a service account. The owner shares each calendar with the
// service account's email ("Make changes to events"), so no browser sign-in is needed
// and nothing expires after 7 days the way test-mode OAuth tokens do.
import { createSign } from 'node:crypto';
import { ServiceError } from './notion.js';
import { TZ, addDays, toInstant, parts } from './dates.js';

const b64url = (s) => Buffer.from(s).toString('base64url');

export function calendarClient(serviceAccountJson, fetchImpl = fetch, now = () => Date.now()) {
  let sa = null;
  try { sa = serviceAccountJson ? JSON.parse(serviceAccountJson) : null; } catch { sa = null; }
  let token = null; let tokenExp = 0;

  async function auth() {
    if (!sa) throw new ServiceError('calendar', 401, 'GOOGLE_SERVICE_ACCOUNT_JSON is missing or not valid JSON');
    if (token && now() < tokenExp - 60000) return token;
    const iat = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
    const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key, 'base64url');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${head}.${claim}.${sig}`,
    }).catch((e) => { throw new ServiceError('calendar', 0, e.message); });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ServiceError('calendar', res.status, data.error_description || data.error || 'token request failed');
    token = data.access_token; tokenExp = now() + data.expires_in * 1000;
    return token;
  }
  async function call(method, path, body) {
    const t = await auth();
    const res = await fetchImpl(`https://www.googleapis.com/calendar/v3${path}`, {
      method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    }).catch((e) => { throw new ServiceError('calendar', 0, e.message); });
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ServiceError('calendar', res.status, data.error?.message || res.statusText);
    return data;
  }
  const enc = encodeURIComponent;
  return {
    email: sa?.client_email || null,
    // Events between two Dublin dates (end exclusive), all-day first then by start.
    async events(calendarId, fromDate, toDate) {
      const q = `timeMin=${enc(toInstant(fromDate).toISOString())}&timeMax=${enc(toInstant(toDate).toISOString())}&singleEvents=true&orderBy=startTime&timeZone=${enc(TZ)}&maxResults=250`;
      const r = await call('GET', `/calendars/${enc(calendarId)}/events?${q}`);
      return (r.items || []).filter((e) => e.status !== 'cancelled').map((e) => normalise(e, calendarId));
    },
    async create(calendarId, ev) { return normalise(await call('POST', `/calendars/${enc(calendarId)}/events`, toGoogle(ev)), calendarId); },
    async patch(calendarId, id, ev) { return normalise(await call('PATCH', `/calendars/${enc(calendarId)}/events/${enc(id)}`, toGoogle(ev)), calendarId); },
    async remove(calendarId, id) { await call('DELETE', `/calendars/${enc(calendarId)}/events/${enc(id)}`); },
  };
}

function normalise(e, calendarId) {
  const allDay = !!e.start?.date;
  const s = allDay ? { date: e.start.date, time: null } : parts(new Date(e.start.dateTime));
  const en = allDay ? { date: e.end?.date, time: null } : parts(new Date(e.end.dateTime));
  return { id: e.id, calendarId, title: e.summary || '(no title)', allDay, date: s.date, start: s.time, endDate: en.date, end: en.time };
}
function toGoogle(ev) {
  const body = {};
  if (ev.title) body.summary = ev.title;
  if (ev.description) body.description = ev.description;
  if (ev.date) {
    if (ev.start) {
      body.start = { dateTime: `${ev.date}T${ev.start}:00`, timeZone: TZ };
      body.end = { dateTime: `${ev.date}T${ev.end || ev.start}:00`, timeZone: TZ };
    } else {
      body.start = { date: ev.date };
      body.end = { date: addDays(ev.date, 1) };
    }
  }
  return body;
}

// Reads every chosen calendar. A calendar that fails is reported, not fatal.
export async function readCalendars(cal, ids, from, to) {
  const events = []; const failures = [];
  for (const id of ids) {
    try { events.push(...(await cal.events(id, from, to))); }
    catch (e) {
      // One retry for errors that may be temporary.
      if (e.status === 0 || e.status >= 500) {
        try { events.push(...(await cal.events(id, from, to))); continue; } catch (e2) { failures.push({ id, error: e2 }); continue; }
      }
      failures.push({ id, error: e });
    }
  }
  const seen = new Set();
  const unique = events.filter((e) => { const k = `${e.title}|${e.date}|${e.start}|${e.end}`; if (seen.has(k)) return false; seen.add(k); return true; });
  events.length = 0; events.push(...unique);
  events.sort((a, b) => (a.date + (a.allDay ? '0' : '1') + (a.start || '')).localeCompare(b.date + (b.allDay ? '0' : '1') + (b.start || '')));
  return { events, failures };
}
