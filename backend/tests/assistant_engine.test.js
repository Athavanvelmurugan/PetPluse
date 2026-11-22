const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/connection');
const assistantService = require('../src/modules/assistant/assistant.service');
const assistantSessions = require('../src/modules/assistant/assistant.sessions');

describe('Phase 2 - Assistant Engine (Dharu)', () => {
  let testOwner = null;
  let testPet = null;
  let testDoctor = null;
  let createdAppointmentId = null;

  before(async () => {
    // 1. Fetch or provision test doctor with active schedule availability
    const docRes = await db.query(
      `SELECT u.id, u.name, da.weekday
       FROM users u
       JOIN doctor_availability da ON da.doctor_id = u.id
       WHERE u.role IN ('doctor', 'veterinarian') AND UPPER(u.status) = 'ACTIVE' AND da.is_active = true
       LIMIT 1;`
    );
    assert.ok(docRes.rows.length > 0, 'Must have at least one doctor with availability');
    testDoctor = docRes.rows[0];

    // 2. Fetch or provision test owner
    let ownerRes = await db.query(
      `SELECT o.id, o.name, o.clinic_id, o.user_id FROM owners o LIMIT 1;`
    );
    if (ownerRes.rows.length === 0) {
      const insOwner = await db.query(
        `INSERT INTO owners (clinic_id, name, phone, email, preferred_language)
         VALUES (1, 'Sarah Jenkins', '+919876543210', 'sarah.jenkins@test.com', 'en')
         RETURNING id, name, clinic_id, user_id;`
      );
      testOwner = insOwner.rows[0];
    } else {
      testOwner = ownerRes.rows[0];
    }

    // 3. Ensure test owner has a registered pet
    const petRes = await db.query(
      `SELECT p.id, p.name, p.species
       FROM pets p
       JOIN pet_owners po ON po.pet_id = p.id
       WHERE po.owner_id = $1 LIMIT 1;`,
      [testOwner.id]
    );

    if (petRes.rows.length > 0) {
      testPet = petRes.rows[0];
    } else {
      const insPet = await db.query(
        `INSERT INTO pets (clinic_id, name, species, breed)
         VALUES ($1, 'Simba', 'Feline', 'Domestic') RETURNING id, name, species;`,
        [testOwner.clinic_id || 1]
      );
      testPet = insPet.rows[0];
      await db.query(
        `INSERT INTO pet_owners (pet_id, owner_id, is_primary)
         VALUES ($1, $2, true) ON CONFLICT DO NOTHING;`,
        [testPet.id, testOwner.id]
      );
    }
  });

  after(async () => {
    if (createdAppointmentId) {
      await db.query(`DELETE FROM appointments WHERE id = $1`, [createdAppointmentId]);
    }
    await db.query(`DELETE FROM assistant_sessions WHERE owner_id = $1`, [testOwner.id]);
    await db.pool.end();
  });

  test('Medical emergency keywords immediately halt booking and show phone number', async () => {
    const res = await assistantService.processTurn({
      owner: testOwner,
      text: 'My cat swallowed rat poison and is bleeding!',
    });

    assert.ok(res.reply.includes('MEDICAL EMERGENCY'), 'Must return emergency alert');
    assert.ok(res.chips.some((c) => c.action?.type === 'call_phone'), 'Must provide phone call chip');
  });

  test('First turn with no session or input returns greeting and action chips', async () => {
    const res = await assistantService.processTurn({
      owner: testOwner,
      channel: 'chat',
    });

    assert.ok(res.sessionId, 'Must provision a sessionId');
    assert.equal(res.state, 'GREETING');
    assert.ok(res.reply.includes('Dharu'));
    assert.ok(res.chips.length >= 3);
    assert.ok(res.chips.some((c) => c.action?.value === 'book'));
  });

  test('Fuzzy doctor matching matches doctor name and rejects unknown doctor', async () => {
    const queryDocName = testDoctor.name.replace(/^Dr\.?\s+/i, '').split(' ')[0];

    // Fuzzy matching
    const match = assistantService._fuzzyMatchDoctor(queryDocName, [testDoctor]);
    assert.ok(match.match, 'Should match doctor by first name');
    assert.equal(match.match.id, testDoctor.id);

    // Completely unknown doctor
    const noMatch = assistantService._fuzzyMatchDoctor('ZorblaxTheAlienVet999', [testDoctor]);
    assert.equal(noMatch.match, null, 'Unknown doctor must not match');
  });

  test('Slot filtering by time of day filters morning and afternoon correctly', () => {
    const slots = [
      { start: '2026-11-22T03:30:00Z', time: '09:00', label: '9:00 AM' },
      { start: '2026-11-22T05:30:00Z', time: '11:00', label: '11:00 AM' },
      { start: '2026-11-22T08:30:00Z', time: '14:00', label: '2:00 PM' },
      { start: '2026-11-22T12:30:00Z', time: '18:00', label: '6:00 PM' },
    ];

    const morning = assistantService._filterSlotsByTimeOfDay(slots, 'morning');
    assert.equal(morning.length, 2);
    assert.equal(morning[0].time, '09:00');
    assert.equal(morning[1].time, '11:00');

    const afternoon = assistantService._filterSlotsByTimeOfDay(slots, 'afternoon');
    assert.equal(afternoon.length, 1);
    assert.equal(afternoon[0].time, '14:00');

    const evening = assistantService._filterSlotsByTimeOfDay(slots, 'evening');
    assert.equal(evening.length, 1);
    assert.equal(evening[0].time, '18:00');
  });

  test('Full multi-turn booking via quick-reply chips commits appointment', async () => {
    // Turn 1: Click "Book appointment"
    const t1 = await assistantService.processTurn({
      owner: testOwner,
      action: { type: 'intent', value: 'book' },
    });
    assert.ok(t1.sessionId);
    const sid = t1.sessionId;

    // Turn 1b: Pick pet
    await assistantService.processTurn({
      owner: testOwner,
      sessionId: sid,
      action: { type: 'pick_pet', id: testPet.id },
    });

    // Turn 2: Pick doctor
    const t2 = await assistantService.processTurn({
      owner: testOwner,
      sessionId: sid,
      action: { type: 'pick_doctor', id: testDoctor.id },
    });

    // Turn 3: Pick date matching doctor's available weekday
    const target = new Date();
    target.setDate(target.getDate() + 1);
    while (target.getDay() !== testDoctor.weekday) {
      target.setDate(target.getDate() + 1);
    }
    const targetDate = target.toISOString().split('T')[0];

    const t3 = await assistantService.processTurn({
      owner: testOwner,
      sessionId: sid,
      action: { type: 'pick_date', date: targetDate },
    });

    assert.equal(t3.state, 'PICK_SLOT');
    assert.ok(t3.chips.length > 0, 'Must provide slot chips');
    const chosenSlotChip = t3.chips[0];

    // Turn 4: Pick slot
    const t4 = await assistantService.processTurn({
      owner: testOwner,
      sessionId: sid,
      action: chosenSlotChip.action,
    });

    assert.equal(t4.state, 'CONFIRM');
    assert.ok(t4.reply.includes('Shall I confirm'));
    assert.ok(t4.chips.some((c) => c.action?.type === 'confirm' && c.action?.value === true));

    // Turn 5: Explicit Yes Confirm
    const t5 = await assistantService.processTurn({
      owner: testOwner,
      sessionId: sid,
      action: { type: 'confirm', value: true },
    });

    assert.equal(t5.state, 'DONE');
    assert.ok(t5.appointment?.id);
    createdAppointmentId = t5.appointment.id;

    // Verify database record has booking_channel = 'chat'
    const apptCheck = await db.query(`SELECT booking_channel, status FROM appointments WHERE id = $1`, [createdAppointmentId]);
    assert.equal(apptCheck.rows[0].booking_channel, 'chat');
    assert.equal(apptCheck.rows[0].status, 'scheduled');
  });

  test('Cannot cancel an appointment belonging to another owner', async () => {
    // Other owner ID
    const fakeOtherOwner = { id: 999999, name: 'Attacker' };
    const cancelAttempt = await assistantService._executeCancel({}, createdAppointmentId, fakeOtherOwner, { timeZone: 'UTC' });
    assert.ok(cancelAttempt.reply.includes('not authorized') || cancelAttempt.reply.includes('not found'));
  });

  test('Session expiry starts fresh session politely', async () => {
    // Expired UUID
    const fakeExpiredId = '00000000-0000-0000-0000-000000000001';
    const { session, isNew } = await assistantSessions.getOrCreateSession(fakeExpiredId, testOwner.id, 'chat');
    assert.equal(isNew, true, 'Non-existent or expired session must trigger isNew = true');
    assert.notEqual(session.id, fakeExpiredId);
  });

  test('Strict Guardrail: Cooking recipe questions are politely declined without recipes', async () => {
    const resIdly = await assistantService.processTurn({
      owner: testOwner,
      text: 'how to cook idly ?',
    });
    assert.ok(resIdly.reply.includes('I specialize only in veterinary care'), 'Must return domain boundary refusal');
    assert.ok(!resIdly.reply.toLowerCase().includes('ferment'), 'Must not give recipe tips');
    assert.equal(resIdly.state, 'GREETING', 'Must not advance state to COLLECT');

    const resBriyani = await assistantService.processTurn({
      owner: testOwner,
      sessionId: resIdly.sessionId,
      text: 'how to cook briyani for siva ?',
    });
    assert.ok(resBriyani.reply.includes('I specialize only in veterinary care'), 'Must decline briyani question');
    assert.equal(resBriyani.state, 'GREETING', 'Must remain in GREETING state');
  });

  test('Strict Guardrail: Coding and programming questions are rejected', async () => {
    const resCode = await assistantService.processTurn({
      owner: testOwner,
      text: 'can you write the code spiral matrix in java',
    });
    assert.ok(resCode.reply.includes('I specialize only in veterinary care'), 'Must decline code request');
    assert.ok(!resCode.reply.includes('public class'), 'Must not return code');
    assert.equal(resCode.state, 'GREETING');
  });

  test('Strict Guardrail: Entertainment and movie questions are rejected', async () => {
    const resMovie = await assistantService.processTurn({
      owner: testOwner,
      text: 'tell me about o.m movie 2026',
    });
    assert.ok(resMovie.reply.includes('I specialize only in veterinary care'), 'Must decline movie request');
    assert.equal(resMovie.state, 'GREETING');
  });

  test('State Machine Integrity: Saying yes after off-topic question does not trigger booking', async () => {
    const t1 = await assistantService.processTurn({
      owner: testOwner,
      text: 'how to cook idly ?',
    });
    assert.equal(t1.state, 'GREETING');

    const t2 = await assistantService.processTurn({
      owner: testOwner,
      sessionId: t1.sessionId,
      text: 'yes',
    });
    assert.notEqual(t2.state, 'CONFIRM');
    assert.notEqual(t2.state, 'DONE');
    assert.ok(!t2.appointment, 'Must not create or confirm an appointment');
  });
});
