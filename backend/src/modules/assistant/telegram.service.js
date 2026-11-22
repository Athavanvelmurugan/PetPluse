const db = require('../../db/connection');
const assistantService = require('./assistant.service');

class TelegramService {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || null;
  }

  /**
   * Generates a 6-digit one-time code to link an owner's account to Telegram.
   */
  async generateLinkCode(ownerId) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    // Invalidate existing unused codes for this owner
    await db.query(
      `DELETE FROM telegram_links WHERE owner_id = $1 AND chat_id IS NULL;`,
      [ownerId]
    );

    const { rows } = await db.query(
      `INSERT INTO telegram_links (owner_id, link_code, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, link_code, expires_at;`,
      [ownerId, code, expiresAt.toISOString()]
    );

    return {
      code: rows[0].link_code,
      expiresAt: rows[0].expires_at,
    };
  }

  /**
   * Dispatches outbound message to Telegram API (or console staging if token not set)
   */
  async sendTelegramMessage(chatId, text, chips = []) {
    const inlineKeyboard = chips && chips.length > 0
      ? chips.map((c) => [
          {
            text: c.label,
            callback_data: JSON.stringify(c.action).slice(0, 64), // Telegram 64-byte callback_data limit
          },
        ])
      : undefined;

    if (this.botToken) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
          }),
        });
        return await res.json();
      } catch (err) {
        console.warn('[TelegramService] Telegram API error:', err.message);
      }
    } else {
      console.log(`[TelegramService] Outbound to #${chatId}: ${text}`);
      if (inlineKeyboard) {
        console.log(`[TelegramService] Chips: ${chips.map((c) => c.label).join(' | ')}`);
      }
    }

    return { ok: true, text, inlineKeyboard };
  }

  /**
   * Processes incoming Telegram webhook updates
   */
  async handleWebhookUpdate(update) {
    // 1. Handle Inline Keyboard Callback Queries (Chip Taps)
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      let action = null;
      try {
        action = JSON.parse(cb.data);
      } catch (_) {
        action = { type: 'custom', value: cb.data };
      }

      const linkRes = await db.query(
        `SELECT tl.owner_id, o.*
         FROM telegram_links tl
         JOIN owners o ON o.id = tl.owner_id
         WHERE tl.chat_id = $1;`,
        [chatId]
      );

      if (linkRes.rows.length === 0) {
        await this.sendTelegramMessage(chatId, 'Session expired or not linked. Please enter your 6-digit code from the Pet Guardian portal.');
        return { ok: true };
      }

      const owner = linkRes.rows[0];
      const result = await assistantService.processTurn({
        owner,
        channel: 'telegram',
        action,
      });

      await this.sendTelegramMessage(chatId, result.reply, result.chips);
      return { ok: true, result };
    }

    // 2. Handle Text Messages
    const message = update.message;
    if (!message || !message.text) return { ok: true };

    const chatId = message.chat.id;
    const text = message.text.trim();

    // Check if user is typing a 6-digit linking code
    if (/^\d{6}$/.test(text)) {
      const codeRes = await db.query(
        `SELECT tl.id, tl.owner_id, o.name, o.clinic_id, o.email
         FROM telegram_links tl
         JOIN owners o ON o.id = tl.owner_id
         WHERE tl.link_code = $1 AND tl.expires_at > NOW()
         ORDER BY tl.created_at DESC LIMIT 1;`,
        [text]
      );

      if (codeRes.rows.length > 0) {
        const link = codeRes.rows[0];
        // Bind chat_id to owner
        await db.query(
          `UPDATE telegram_links
           SET chat_id = $1, link_code = NULL
           WHERE id = $2;`,
          [chatId, link.id]
        );

        const welcomeReply = `Account linked successfully!\n\nHi ${link.name}, I am Dharu, your PetCare AI assistant. How can I help you and your pet today?`;
        const initialChips = [
          { label: 'Book appointment', action: { type: 'intent', value: 'book' } },
          { label: 'My appointments', action: { type: 'intent', value: 'list' } },
        ];

        await this.sendTelegramMessage(chatId, welcomeReply, initialChips);
        return { ok: true, action: 'linked', ownerId: link.owner_id };
      } else {
        await this.sendTelegramMessage(chatId, '❌ Invalid or expired 6-digit code. Please generate a new code in the Pet Guardian portal.');
        return { ok: true, action: 'invalid_code' };
      }
    }

    // Check if chat is already linked to an owner
    const existingLink = await db.query(
      `SELECT tl.owner_id, o.*
       FROM telegram_links tl
       JOIN owners o ON o.id = tl.owner_id
       WHERE tl.chat_id = $1;`,
      [chatId]
    );

    if (existingLink.rows.length === 0) {
      const promptLink = `Welcome to PetCare AI Assistant!\n\nTo link this Telegram chat to your pet account, please enter the 6-digit code shown in your Pet Guardian web portal.`;
      await this.sendTelegramMessage(chatId, promptLink);
      return { ok: true, action: 'prompt_code' };
    }

    const owner = existingLink.rows[0];
    const result = await assistantService.processTurn({
      owner,
      channel: 'telegram',
      text,
    });

    await this.sendTelegramMessage(chatId, result.reply, result.chips);
    return { ok: true, result };
  }
}

module.exports = new TelegramService();
