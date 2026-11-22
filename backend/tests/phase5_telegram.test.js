const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/connection');
const telegramService = require('../src/modules/assistant/telegram.service');

describe('Phase 5 - Telegram Bot Assistant Integration', () => {
  let testOwner = null;
  let testChatId = 987654321;

  before(async () => {
    const ownerRes = await db.query(`SELECT id, name, email, clinic_id FROM owners LIMIT 1;`);
    testOwner = ownerRes.rows[0];
  });

  after(async () => {
    await db.query(`DELETE FROM telegram_links WHERE chat_id = $1 OR owner_id = $2;`, [testChatId, testOwner.id]);
    await db.pool.end();
  });

  test('generateLinkCode produces a 6-digit code stored in database', async () => {
    const { code, expiresAt } = await telegramService.generateLinkCode(testOwner.id);

    assert.equal(typeof code, 'string');
    assert.equal(code.length, 6);
    assert.match(code, /^\d{6}$/);
    assert.ok(new Date(expiresAt) > new Date());

    const rowRes = await db.query(`SELECT * FROM telegram_links WHERE link_code = $1;`, [code]);
    assert.equal(rowRes.rows.length, 1);
    assert.equal(rowRes.rows[0].owner_id, testOwner.id);
  });

  test('unlinked chat receives prompt to enter 6-digit portal code', async () => {
    const update = {
      message: {
        chat: { id: testChatId },
        text: 'Hello, I want to book a visit',
      },
    };

    const res = await telegramService.handleWebhookUpdate(update);
    assert.equal(res.action, 'prompt_code');
  });

  test('entering valid 6-digit code binds chat_id and returns Dharu welcome', async () => {
    const { code } = await telegramService.generateLinkCode(testOwner.id);

    const update = {
      message: {
        chat: { id: testChatId },
        text: code,
      },
    };

    const res = await telegramService.handleWebhookUpdate(update);
    assert.equal(res.action, 'linked');
    assert.equal(res.ownerId, testOwner.id);

    // Verify chat_id is stored
    const checkRes = await db.query(`SELECT chat_id FROM telegram_links WHERE chat_id = $1;`, [testChatId]);
    assert.equal(checkRes.rows.length, 1);
  });

  test('linked chat routes conversational message to assistant state machine', async () => {
    const update = {
      message: {
        chat: { id: testChatId },
        text: 'What are my appointments?',
      },
    };

    const res = await telegramService.handleWebhookUpdate(update);
    assert.ok(res.ok);
    assert.ok(res.result);
    assert.ok(res.result.reply);
  });

  test('callback query (chip tap) triggers deterministic chip action without LLM', async () => {
    const update = {
      callback_query: {
        message: { chat: { id: testChatId } },
        data: JSON.stringify({ type: 'intent', value: 'book' }),
      },
    };

    const res = await telegramService.handleWebhookUpdate(update);
    assert.ok(res.ok);
    assert.ok(res.result);
    assert.equal(res.result.state, 'COLLECT');
    assert.ok(res.result.chips.length > 0);
  });
});

