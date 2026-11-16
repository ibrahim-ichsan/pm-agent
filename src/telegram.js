// Minimal Telegram Bot API client: long polling, messages with buttons, file download.
import { ServiceError } from './notion.js';

export function telegramClient(token, fetchImpl = fetch) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, body) {
    let res;
    try { res = await fetchImpl(`${base}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
    catch (e) { throw new ServiceError('telegram', 0, e.message); }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new ServiceError('telegram', res.status, data.description || 'request failed');
    return data.result;
  }
  return {
    async send(chatId, text, { buttons = [], forceReply = false } = {}) {
      const body = { chat_id: chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true };
      if (buttons.length) body.reply_markup = { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text.slice(0, 60), callback_data: b.data }))) };
      else if (forceReply) body.reply_markup = { force_reply: true, input_field_placeholder: 'Reply here' };
      try { return await call('sendMessage', body); }
      catch (e) {
        // If the HTML is rejected, send it as plain text rather than not at all.
        if (e.status === 400 && /parse/i.test(e.message)) { delete body.parse_mode; body.text = text.replace(/<[^>]+>/g, ''); return call('sendMessage', body); }
        throw e;
      }
    },
    answer: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text }),
    getUpdates: (offset, timeout = 30) => call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }),
    deleteWebhook: () => call('deleteWebhook', { drop_pending_updates: false }),
    setCommands: (commands) => call('setMyCommands', { commands }),
    async download(fileId) {
      const f = await call('getFile', { file_id: fileId });
      const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
      if (!res.ok) throw new ServiceError('telegram', res.status, 'file download failed');
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
