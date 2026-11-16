// Date handling in Dublin time, and a rule-based reader for dates and times in a message.
export const TZ = 'Europe/Dublin';
const pad = (n) => String(n).padStart(2, '0');

// Wall-clock parts of an instant in Dublin.
export function parts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const o = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}`, hour: Number(o.hour), minute: Number(o.minute), weekday: o.weekday };
}
export const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const diffDays = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000);
export const weekdayOf = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
export const mondayOf = (iso) => addDays(iso, -((weekdayOf(iso) + 6) % 7));
export function pretty(iso, time) {
  const d = new Date(iso + 'T12:00:00Z');
  const s = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(',', '');
  return time ? `${s}, ${time}` : s;
}
// The UTC instant of a Dublin wall-clock date and time.
export function toInstant(iso, time = '00:00') {
  const guess = new Date(`${iso}T${time}:00Z`);
  const p = parts(guess);
  const shown = new Date(`${p.date}T${p.time}:00Z`);
  return new Date(guess.getTime() - (shown.getTime() - guess.getTime()));
}
export const validDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

const DAYS = { sunday: 0, sun: 0, minggu: 0, monday: 1, mon: 1, senin: 1, tuesday: 2, tue: 2, tues: 2, selasa: 2, wednesday: 3, wed: 3, rabu: 3, thursday: 4, thu: 4, thurs: 4, kamis: 4, friday: 5, fri: 5, jumat: 5, "jum'at": 5, saturday: 6, sat: 6, sabtu: 6 };
const MONTHS = { jan: 1, january: 1, januari: 1, feb: 2, february: 2, februari: 2, mar: 3, march: 3, maret: 3, apr: 4, april: 4, may: 5, mei: 5, jun: 6, june: 6, juni: 6, jul: 7, july: 7, juli: 7, aug: 8, august: 8, agustus: 8, agu: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, okt: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12, des: 12, desember: 12 };
const MON = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const DAY = Object.keys(DAYS).sort((a, b) => b.length - a.length).join('|');

// Reads a date and a time out of free text. Returns { date, time, invalid, matched: [strings found] }.
// "friday" means the next Friday, today included. A date that does not exist sets invalid.
export function readDate(text, today) {
  const t = ' ' + text.toLowerCase() + ' ';
  const out = { date: null, time: null, invalid: false, matched: [] };
  const hit = (m) => out.matched.push(m.trim());
  let m;
  const year = Number(today.slice(0, 4));
  const settle = (mo, d, y, raw) => {
    hit(raw);
    let yy = y || year;
    if (!validDate(yy, mo, d)) { out.invalid = true; return; }
    let iso = `${yy}-${pad(mo)}-${pad(d)}`;
    if (!y && iso < today && diffDays(today, iso) > 60) { yy += 1; if (validDate(yy, mo, d)) iso = `${yy}-${pad(mo)}-${pad(d)}`; }
    out.date = iso;
  };
  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) settle(Number(m[2]), Number(m[3]), Number(m[1]), m[0]);
  else if ((m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})\\.?(?:\\s+(\\d{4}))?\\b`)))) settle(MONTHS[m[2]], Number(m[1]), m[3] ? Number(m[3]) : 0, m[0]);
  else if ((m = t.match(new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`)))) settle(MONTHS[m[1]], Number(m[2]), m[3] ? Number(m[3]) : 0, m[0]);
  else if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/))) settle(Number(m[2]), Number(m[1]), m[3] ? Number(m[3]) : 0, m[0]);
  else if ((m = t.match(/\b(today|hari ini|tonight|malam ini)\b/))) { hit(m[0]); out.date = today; }
  else if ((m = t.match(/\b(tomorrow|tmrw|besok)\b/))) { hit(m[0]); out.date = addDays(today, 1); }
  else if ((m = t.match(/\b(lusa|day after tomorrow)\b/))) { hit(m[0]); out.date = addDays(today, 2); }
  else if ((m = t.match(/\b(next week|minggu depan)\b/))) { hit(m[0]); out.date = addDays(today, 7); }
  else if ((m = t.match(new RegExp(`\\b(?:(next|this|on|hari)\\s+)?(${DAY})\\b(?:\\s+(depan))?`)))) {
    hit(m[0]);
    const delta = (DAYS[m[2]] - weekdayOf(today) + 7) % 7;
    out.date = addDays(today, delta + ((m[1] === 'next' || m[3]) && delta < 7 ? (delta === 0 ? 7 : 0) : 0));
  }
  if ((m = t.match(/\b(?:at\s+|jam\s+|pukul\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/))) {
    let h = Number(m[1]) % 12; if (m[3] === 'pm') h += 12;
    hit(m[0]); out.time = `${pad(h)}:${m[2] || '00'}`;
  } else if ((m = t.match(/\b(?:at\s+|jam\s+|pukul\s+)(\d{1,2})(?:[:.](\d{2}))?\b/)) || (m = t.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/))) {
    const h = Number(m[1]);
    if (h <= 23) { hit(m[0]); out.time = `${pad(h)}:${m[2] || '00'}`; }
  }
  return out;
}
