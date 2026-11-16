// Gemini client: structured parsing and short free-form help.
// Tracks calls per day so the bot can report usage and warn near a limit.
import { ServiceError } from './notion.js';
import { PERSONA } from './persona.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Node's fetch has no timeout of its own, so every Gemini call gets a deadline and fails fast.
const TIMEOUT_MS = 20_000;
const MAX_TRIES = 3;
const version = (n) => parseFloat((n.match(/(\d+(\.\d+)?)/) || [])[1]) || 0;

// Order the text models this key can call. Parsing a chat message is a small job, so the light
// models go first (fast, and the easiest to reach on the free tier); the full Flash models are the fallback.
export function rankModels(names, preferred) {
  const ok = names.filter((n) => /^gemini-/.test(n) && /flash/.test(n) && !/(image|tts|audio|live|preview|exp|thinking|omni|transcribe|robotics|embedding|computer)/.test(n));
  const lite = ok.filter((n) => /lite/.test(n)).sort((a, b) => version(b) - version(a));
  const full = ok.filter((n) => !/lite/.test(n)).sort((a, b) => version(b) - version(a));
  const out = [...lite, ...full];
  return preferred ? [preferred, ...out.filter((n) => n !== preferred)] : out;
}

export function geminiClient({ key, model, dailyLimit }, fetchImpl = fetch, today = () => new Date().toISOString().slice(0, 10), log = console) {
  let models = null; // ranked candidates; the one that last worked sits first
  const usage = { day: null, calls: 0, quotaErrors: 0, lastError: null };
  const bump = (field) => { const d = today(); if (usage.day !== d) Object.assign(usage, { day: d, calls: 0, quotaErrors: 0, lastError: null }); if (field) usage[field] += 1; };
  const reason = (e) => (e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : e.message);

  async function candidates() {
    if (models) return models;
    let res;
    try { res = await fetchImpl(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch (e) {
      log.error?.(`gemini model list failed: ${reason(e)}`);
      if (model) return [model]; // not cached, so the list is tried again next time
      throw new ServiceError('llm', 0, `model list: ${reason(e)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ServiceError('llm', res.status, data.error?.message || 'model list failed');
    const names = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace('models/', ''));
    const ranked = rankModels(names, model);
    if (!ranked.length) throw new ServiceError('llm', 404, 'no Flash model available to this key; set GEMINI_MODEL');
    log.log?.(`gemini candidates: ${ranked.join(', ')}`);
    models = ranked;
    return models;
  }

  // Tries up to three models. A slow, overloaded or missing model moves on to the next one;
  // a rejected key or a bad request stops at once, because another model would not help.
  async function generate(parts, { json = false, system = PERSONA, timeoutMs = TIMEOUT_MS } = {}) {
    if (!key) throw new ServiceError('llm', 401, 'GEMINI_API_KEY is not set');
    const list = (await candidates()).slice(0, MAX_TRIES);
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: json ? { responseMimeType: 'application/json', temperature: 0.1 } : { temperature: 0.6 },
    });
    const tried = [];
    let last = { status: 0 };
    for (const m of list) {
      bump('calls');
      const t0 = Date.now();
      let res; let data = {};
      try {
        res = await fetchImpl(`${BASE}/models/${m}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        log.error?.(`gemini ${m} failed after ${Date.now() - t0}ms: ${reason(e)}`);
        tried.push(`${m}: ${reason(e)}`); last = { status: 0 };
        continue;
      }
      log.log?.(`gemini ${m} ${res.status} ${Date.now() - t0}ms`);
      if (res.ok) {
        const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
        let out = text.trim();
        if (json) {
          try { out = JSON.parse(text.replace(/^\s*```(?:json)?|```\s*$/g, '')); }
          catch { tried.push(`${m}: reply was not JSON`); last = { status: 422 }; continue; }
        }
        if (models && models[0] !== m) models = [m, ...models.filter((x) => x !== m)];
        usage.lastError = null;
        return out;
      }
      const detail = data.error?.message || res.statusText || '';
      log.error?.(`gemini ${m} error ${res.status}: ${detail}`);
      tried.push(`${m}: ${res.status} ${detail}`.slice(0, 160));
      last = { status: res.status };
      if (res.status === 429) bump('quotaErrors');
      if ([400, 401, 403].includes(res.status)) break;
    }
    usage.lastError = tried.join(' | ');
    throw new ServiceError('llm', last.status, usage.lastError);
  }

  return {
    enabled: !!key,
    generate,
    model: () => (models ? models[0] : model || null),
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
