// Gemini client: structured parsing and short free-form help.
// Tracks calls per day so the bot can report usage and warn near a limit.
import { ServiceError } from './notion.js';
import { PERSONA } from './persona.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function geminiClient({ key, model, dailyLimit }, fetchImpl = fetch, today = () => new Date().toISOString().slice(0, 10)) {
  let chosen = model || null;
  const usage = { day: null, calls: 0, quotaErrors: 0, lastError: null };
  const bump = (field) => { const d = today(); if (usage.day !== d) Object.assign(usage, { day: d, calls: 0, quotaErrors: 0, lastError: null }); if (field) usage[field] += 1; };

  async function pickModel() {
    if (chosen) return chosen;
    const res = await fetchImpl(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } }).catch((e) => { throw new ServiceError('llm', 0, e.message); });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ServiceError('llm', res.status, data.error?.message || 'model list failed');
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''))
      .filter((n) => /flash/.test(n) && !/(image|tts|audio|live|preview|exp|lite|thinking)/.test(n));
    // Highest version number first, e.g. gemini-3.0-flash before gemini-2.5-flash.
    names.sort((a, b) => (parseFloat((b.match(/(\d+(\.\d+)?)/) || [])[1]) || 0) - (parseFloat((a.match(/(\d+(\.\d+)?)/) || [])[1]) || 0));
    if (!names.length) throw new ServiceError('llm', 404, 'no Flash model available to this key; set GEMINI_MODEL');
    chosen = names[0];
    return chosen;
  }

  async function generate(parts, { json = false, system = PERSONA } = {}) {
    if (!key) throw new ServiceError('llm', 401, 'GEMINI_API_KEY is not set');
    const m = await pickModel();
    bump('calls');
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: json ? { responseMimeType: 'application/json', temperature: 0.1 } : { temperature: 0.6 },
    };
    let res;
    try {
      res = await fetchImpl(`${BASE}/models/${m}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { usage.lastError = e.message; throw new ServiceError('llm', 0, e.message); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) bump('quotaErrors');
      usage.lastError = data.error?.message || res.statusText;
      throw new ServiceError('llm', res.status, usage.lastError);
    }
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!json) return text.trim();
    try { return JSON.parse(text); } catch { throw new ServiceError('llm', 422, 'model returned text that is not JSON'); }
  }

  return {
    enabled: !!key,
    generate,
    model: () => chosen,
    usage() { bump(); return { ...usage, limit: dailyLimit || null }; },
  };
}

// Usage line: a warning only when close to the limit or after a quota error, otherwise a plain note.
export function usageNote(u, lang = 'en') {
  const id = lang === 'id';
  if (u.quotaErrors > 0) return id ? `⚠️ Kuota model kena limit hari ini (${u.calls} panggilan). Reset besok, atau pakai key lain.` : `⚠️ The model hit its quota today (${u.calls} calls). It resets tomorrow, or use another key.`;
  if (u.limit && u.calls >= 0.8 * u.limit) return id ? `⚠️ Pemakaian model ${u.calls}/${u.limit} hari ini, udah mepet limit.` : `⚠️ Model usage ${u.calls}/${u.limit} today, close to the limit.`;
  if (u.limit) return id ? `Pemakaian model: ${u.calls}/${u.limit} hari ini. Aman.` : `Model usage: ${u.calls}/${u.limit} today. Fine.`;
  return id ? `Pemakaian model: ${u.calls} panggilan hari ini. Limit gratisnya nggak dipublish Google, jadi gue baru warning kalau kena error kuota.` : `Model usage: ${u.calls} calls today. Google does not publish the free limit, so I warn only after a quota error.`;
}
