const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/connection');

describe('Phase 1 - Database Schema (Migration 012)', () => {
  let createdSessionId = null;
  let testPushId = null;

  after(async () => {
    if (createdSessionId) {
      await db.query(`DELETE FROM assistant_sessions WHERE id = $1`, [createdSessionId]);
    }
    if (testPushId) {
      await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [testPushId]);
    }
    await db.query(`DELETE FROM notifications WHERE recipient = 'test-push@example.com'`);
    await db.pool.end();
  });

  test('assistant_sessions table supports session insertion, JSONB, and defaults', async () => {
    // Pick an existing owner
    const ownerRes = await db.query(`SELECT id FROM owners LIMIT 1`);
    assert.ok(ownerRes.rows.length > 0, 'Must have at least one owner');
    const ownerId = ownerRes.rows[0].id;

    const res = await db.query(
      `INSERT INTO assistant_sessions (owner_id, channel, state, data, messages)
       VALUES ($1, 'chat', 'GREETING', '{"petId": 1}'::jsonb, '[{"role": "assistant", "text": "Hi"}]'::jsonb)
       RETURNING id, channel, state, data, messages, expires_at, created_at;`,
      [ownerId]
    );

    const session = res.rows[0];
    assert.ok(session.id);
    createdSessionId = session.id;
    assert.equal(session.channel, 'chat');
    assert.equal(session.state, 'GREETING');
    assert.equal(session.data.petId, 1);
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].text, 'Hi');

    // Verify expiry is ~15 min in the future
    const now = Date.now();
    const exp = new Date(session.expires_at).getTime();
    const diffMin = (exp - now) / (60 * 1000);
    assert.ok(diffMin >= 14 && diffMin <= 16, `Expiry should be ~15 min, got ${diffMin}`);
  });

  test('assistant_sessions rejects invalid channel', async () => {
    const ownerRes = await db.query(`SELECT id FROM owners LIMIT 1`);
    const ownerId = ownerRes.rows[0].id;

    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO assistant_sessions (owner_id, channel) VALUES ($1, 'invalid_channel')`,
          [ownerId]
        );
      },
      (err) => {
        assert.equal(err.code, '23514'); // check_violation
        return true;
      }
    );
  });

  test('push_subscriptions supports insertion and enforces unique endpoint', async () => {
    const userRes = await db.query(`SELECT id FROM users LIMIT 1`);
    assert.ok(userRes.rows.length > 0, 'Must have at least one user');
    const userId = userRes.rows[0].id;

    const testEndpoint = `https://fcm.googleapis.com/fcm/send/test-token-${Date.now()}`;
    const keys = { auth: 'test-auth-secret', p256dh: 'test-p256dh-key' };

    const ins = await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, endpoint, keys;`,
      [userId, testEndpoint, JSON.stringify(keys)]
    );

    assert.ok(ins.rows[0].id);
    testPushId = ins.rows[0].id;
    assert.equal(ins.rows[0].endpoint, testEndpoint);
    assert.equal(ins.rows[0].keys.auth, 'test-auth-secret');

    // Duplicate endpoint must fail with unique violation 23505
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO push_subscriptions (user_id, endpoint, keys)
           VALUES ($1, $2, $3)`,
          [userId, testEndpoint, JSON.stringify(keys)]
        );
      },
      (err) => {
        assert.equal(err.code, '23505');
        return true;
      }
    );
  });

  test('notifications allows channel = "push"', async () => {
    const clinicRes = await db.query(`SELECT id FROM clinics LIMIT 1`);
    const clinicId = clinicRes.rows[0].id;

    const notif = await db.query(
      `INSERT INTO notifications (clinic_id, channel, template, recipient, subject, payload, status)
       VALUES ($1, 'push', 'appointment_reminder', 'test-push@example.com', 'Appointment Confirmed', '{}'::jsonb, 'pending')
       RETURNING id, channel;`,
      [clinicId]
    );

    assert.ok(notif.rows[0].id);
    assert.equal(notif.rows[0].channel, 'push');
  });

  test('appointments supports booking_channel and booking_transcript', async () => {
    const clinicRes = await db.query(`SELECT id FROM clinics LIMIT 1`);
    const clinicId = clinicRes.rows[0].id;
    const petRes = await db.query(`SELECT id FROM pets LIMIT 1`);
    const petId = petRes.rows[0].id;

    const slot = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const appt = await db.query(
      `INSERT INTO appointments (clinic_id, pet_id, scheduled_at, duration_min, type, reason, source, status, booking_channel, booking_transcript)
       VALUES ($1, $2, $3, 15, 'general_checkup', 'Channel Test', 'owner_portal', 'scheduled', 'voice', 'User: I want to book Dr. Smith for Milo tomorrow')
       RETURNING id, booking_channel, booking_transcript;`,
      [clinicId, petId, slot]
    );

    assert.ok(appt.rows[0].id);
    assert.equal(appt.rows[0].booking_channel, 'voice');
    assert.ok(appt.rows[0].booking_transcript.includes('Milo'));

    // Clean up
    await db.query(`DELETE FROM appointments WHERE id = $1`, [appt.rows[0].id]);
  });
});

