// Every failure is reported with what broke, what the bot already tried, and what the owner should do.
export function explain(err, lang = 'en', ctx = {}) {
  const id = lang === 'id';
  const s = err?.service || 'unknown';
  const st = err?.status ?? -1;
  const name = { notion: 'Notion', calendar: 'Google Calendar', llm: id ? 'Language model' : 'The language model', telegram: 'Telegram' }[s] || s;
  let todo;
  if (s === 'notion' && (st === 401)) todo = id ? 'Token Notion salah atau dicabut. Bikin ulang di notion.so/profile/integrations, terus update NOTION_TOKEN.' : 'The Notion token is wrong or revoked. Make a new one at notion.so/profile/integrations and update NOTION_TOKEN.';
  else if (s === 'notion' && (st === 404 || st === 403)) todo = id ? 'Integration belum di-share ke page itu. Buka page "Komplot — PM Agent" (dan CreditFlow Tracker), ••• > Connections > tambah integration bot.' : 'The integration cannot see that page. Open "Komplot — PM Agent" (and CreditFlow Tracker), ••• > Connections > add the bot integration.';
  else if (s === 'notion' && st === 400) todo = id ? `Notion nolak datanya: ${err.message}. Biasanya nama kolom diganti. Balikin nama kolomnya atau kabarin gue.` : `Notion rejected the data: ${err.message}. Usually a column was renamed. Rename it back or tell me.`;
  else if (s === 'calendar' && st === 401) todo = id ? 'Kunci service account nggak kebaca. Cek GOOGLE_SERVICE_ACCOUNT_JSON (paste isi file JSON-nya utuh).' : 'The service account key could not be read. Check GOOGLE_SERVICE_ACCOUNT_JSON (paste the whole JSON file).';
  else if (s === 'calendar' && (st === 403 || st === 404)) todo = id ? `Kalender ${ctx.calendarId || ''} belum di-share ke ${ctx.saEmail || 'email service account'}. Google Calendar > Settings > kalender itu > Share with specific people > "Make changes to events".` : `Calendar ${ctx.calendarId || ''} is not shared with ${ctx.saEmail || 'the service account email'}. Google Calendar > Settings > that calendar > Share with specific people > "Make changes to events".`;
  else if (s === 'llm' && st === 401) todo = id ? 'Key model kosong atau ditolak. Cek GROQ_API_KEY / GEMINI_API_KEY di config var.' : 'The model key is missing or rejected. Check GROQ_API_KEY / GEMINI_API_KEY in the config vars.';
  else if (s === 'llm' && st === 415) todo = err.message;
  else if (s === 'llm' && (st === 0 || st >= 500)) todo = id ? 'Semua model yang gue coba lagi lemot atau down. Pesan lo tetep kesimpen; kirim ulang nanti kalau mau dibaca ulang.' : 'Every model I tried was slow or down. Your message is still filed; send it again later if you want it read again.';
  else if (s === 'llm' && (st === 400 || st === 403)) todo = id ? 'Key model ditolak. Cek key-nya masih aktif di console provider-nya (Groq: console.groq.com, Gemini: aistudio.google.com).' : 'The provider rejected the key. Check it is still active in its console (Groq: console.groq.com, Gemini: aistudio.google.com).';
  else if (s === 'llm' && st === 429) todo = id ? 'Kuota model habis. Tunggu reset atau ganti key.' : 'The model quota is used up. Wait for the reset or use another key.';
  else if (st === 0 || st >= 500) todo = id ? 'Servernya lagi error atau koneksi putus. Gue coba lagi otomatis; kalau masih gagal, kirim /retry.' : 'The service is down or the connection dropped. I retry by myself; if it still fails, send /retry.';
  else todo = id ? `Error: ${err?.message}. Screenshot ini terus kasih ke Claude buat dicek.` : `Error: ${err?.message}. Screenshot this and send it to Claude to check.`;
  if (s === 'llm' && st !== 415 && err?.message) todo += id ? ` Detail: ${err.message}` : ` Detail: ${err.message}`;
  const tried = s === 'llm' ? '' : st === 0 || st >= 500 ? (id ? 'Udah gue coba ulang sekali.' : 'I already retried once.') : (id ? 'Ini bukan error sementara, jadi gue nggak retry.' : 'This is not a temporary error, so I did not retry.');
  const gap = tried ? `${tried} ` : '';
  return id ? `${name} gagal (${st}). ${gap}Yang perlu lo lakuin: ${todo}` : `${name} failed (${st}). ${gap}What to do: ${todo}`;
}
