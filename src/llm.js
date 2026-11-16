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
    name: 'Gemini', files: true,
    enabled: !!key,
    generate,
    model: () => (models ? models[0] : model || null),
    usage() { bump(); return { ...usage, limit: dailyLimit || null }; },
  };
}

// Any provider that speaks the OpenAI chat-completions format: Groq, GitHub Models, OpenRouter, Mistral, a local server.
// Text only: files such as PDFs are left to Gemini.
const OPENAI_SKIP = /(whisper|guard|tts|speech|embed|rerank|moderation|orpheus|compound|vision-preview|allam|image)/i;
const OPENAI_PREFER = [/gpt-oss-120b/i, /llama-?4/i, /llama-3\.3-70b/i, /qwen/i, /kimi/i, /gpt-4\.1-mini|gpt-4o-mini/i, /gpt-oss-20b/i];
export function rankOpenAIModels(ids, preferred) {
  const ok = ids.filter((id) => !OPENAI_SKIP.test(id));
  const score = (id) => { const i = OPENAI_PREFER.findIndex((re) => re.test(id)); return i < 0 ? OPENAI_PREFER.length : i; };
  const out = [...ok].sort((a, b) => score(a) - score(b));
  return preferred ? [preferred, ...out.filter((n) => n !== preferred)] : out;
}

export function openaiClient({ key, baseUrl, model, name = 'llm', dailyLimit }, fetchImpl = fetch, today = () => new Date().toISOString().slice(0, 10), log = console) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  let models = null;
  const usage = { day: null, calls: 0, quotaErrors: 0, lastError: null };
  const bump = (field) => { const d = today(); if (usage.day !== d) Object.assign(usage, { day: d, calls: 0, quotaErrors: 0, lastError: null }); if (field) usage[field] += 1; };
  const reason = (e) => (e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : e.message);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  async function candidates() {
    if (models) return models;
    try {
      const res = await fetchImpl(`${base}/models`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const data = await res.json().catch(() => ({}));
      const ids = (data.data || (Array.isArray(data) ? data : [])).map((m) => m.id || m.name).filter(Boolean);
      if (res.ok && ids.length) { models = rankOpenAIModels(ids, model); log.log?.(`${name} candidates: ${models.slice(0, 5).join(', ')}`); return models; }
      if (!model) throw new ServiceError('llm', res.status || 404, `${name}: could not list models; set LLM_MODEL`);
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      if (!model) throw new ServiceError('llm', 0, `${name} model list: ${reason(e)}`);
    }
    return [model];
  }

  async function generate(parts, { json = false, system = PERSONA, timeoutMs = TIMEOUT_MS } = {}) {
    if (parts.some((p) => p.inline_data)) throw new ServiceError('llm', 415, `${name} cannot read files`);
    const list = (await candidates()).slice(0, MAX_TRIES);
    const messages = [{ role: 'system', content: system }, { role: 'user', content: parts.map((p) => p.text || '').join('\n') }];
    const tried = []; let last = { status: 0 };
    for (const m of list) {
      bump('calls');
      const t0 = Date.now();
      let res; let data = {};
      try {
        res = await fetchImpl(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: m, messages, temperature: json ? 0.1 : 0.6, ...(json ? { response_format: { type: 'json_object' } } : {}) }), signal: AbortSignal.timeout(timeoutMs) });
        data = await res.json().catch(() => ({}));
      } catch (e) { log.error?.(`${name} ${m} failed after ${Date.now() - t0}ms: ${reason(e)}`); tried.push(`${m}: ${reason(e)}`); last = { status: 0 }; continue; }
      log.log?.(`${name} ${m} ${res.status} ${Date.now() - t0}ms`);
      if (res.ok) {
        const text = String(data.choices?.[0]?.message?.content || '');
        let out = text.trim();
        if (json) {
          try { out = JSON.parse(text.replace(/^\s*```(?:json)?|```\s*$/g, '')); }
          catch { tried.push(`${m}: reply was not JSON`); last = { status: 422 }; continue; }
        }
        if (models && models[0] !== m) models = [m, ...models.filter((x) => x !== m)];
        usage.lastError = null;
        return out;
      }
      const detail = data.error?.message || (typeof data.error === 'string' ? data.error : '') || res.statusText || '';
      log.error?.(`${name} ${m} error ${res.status}: ${detail}`);
      tried.push(`${m}: ${res.status} ${detail}`.slice(0, 160)); last = { status: res.status };
      if (res.status === 429) bump('quotaErrors');
      if ([401, 403].includes(res.status)) break;
    }
    usage.lastError = tried.join(' | ');
    throw new ServiceError('llm', last.status, `${name}: ${usage.lastError}`);
  }
  return { name, enabled: !!(key && base), generate, model: () => (models ? models[0] : model || null), usage() { bump(); return { ...usage, limit: dailyLimit || null }; } };
}

// Several providers in order of preference. A request goes to the first that can take it
// (files only to one that reads files) and moves down the list when a provider fails.
export function llmChain(clients) {
  const on = clients.filter((c) => c && c.enabled);
  let lastUsed = null;
  return {
    enabled: on.length > 0,
    providers: () => on.map((c) => c.name),
    model: () => { const c = lastUsed || on[0]; return c ? `${c.name}${c.model() ? ` · ${c.model()}` : ''}` : null; },
    usage() {
      const all = on.map((c) => c.usage());
      const sum = (k) => all.reduce((t, u) => t + (u[k] || 0), 0);
      // Quota only counts as a problem when every provider has hit it.
      return { calls: sum('calls'), quotaErrors: all.length && all.every((u) => u.quotaErrors > 0) ? sum('quotaErrors') : 0, limit: null, lastError: all.map((u) => u.lastError).filter(Boolean).join(' | ') || null };
    },
    async generate(parts, opt) {
      const hasFile = parts.some((p) => p.inline_data);
      const able = on.filter((c) => !hasFile || c.files);
      if (!able.length) throw new ServiceError('llm', 415, hasFile ? 'No provider that reads PDFs is set up. Send a Word file or paste the text, or set GEMINI_API_KEY.' : 'No language model is set up.');
      const errs = []; let last;
      for (const c of able) {
        try { const out = await c.generate(parts, opt); lastUsed = c; return out; }
        catch (e) { last = e; errs.push(e.message); }
      }
      throw new ServiceError('llm', last.status ?? 0, errs.join(' || '));
    },
  };
}

// Usage line: a warning only after a quota error or close to a set limit, otherwise a plain note.
export function usageNote(u, lang = 'en') {
  const id = lang === 'id';
  if (u.quotaErrors > 0) return id ? `⚠️ Kuota model kena limit hari ini (${u.calls} panggilan). Reset besok, atau pakai key lain.` : `⚠️ The model hit its quota today (${u.calls} calls). It resets tomorrow, or use another key.`;
  if (u.limit && u.calls >= 0.8 * u.limit) return id ? `⚠️ Pemakaian model ${u.calls}/${u.limit} hari ini, udah mepet limit.` : `⚠️ Model usage ${u.calls}/${u.limit} today, close to the limit.`;
  if (u.limit) return id ? `Pemakaian model: ${u.calls}/${u.limit} hari ini. Aman.` : `Model usage: ${u.calls}/${u.limit} today. Fine.`;
  return id ? `Pemakaian model: ${u.calls} panggilan hari ini. Gue baru warning kalau kena error kuota.` : `Model usage: ${u.calls} calls today. I warn only after a quota error.`;
}
