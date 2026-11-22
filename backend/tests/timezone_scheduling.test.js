const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const timezoneUtil = require('../src/utils/timezone');
const schedulingEngine = require('../src/modules/scheduling/scheduling.engine');
const schedulingService = require('../src/modules/scheduling/scheduling.service');
const db = require('../src/db/connection');

describe('Phase 0 - Timezone & Scheduling Engine', () => {
  test('converts Asia/Kolkata local times to exact UTC ISO instants', () => {
    // 2026-11-22 09:00 AM IST (UTC+05:30) -> 03:30 UTC
    const utcDate = timezoneUtil.localToUtc('2026-11-22', '09:00', 'Asia/Kolkata');
    assert.equal(utcDate.toISOString(), '2026-11-22T03:30:00.000Z');

    // 2026-11-22 23:45 PM IST -> 18:15 UTC
    const midnightEdge = timezoneUtil.localToUtc('2026-11-22', '23:45', 'Asia/Kolkata');
    assert.equal(midnightEdge.toISOString(), '2026-11-22T18:15:00.000Z');
  });

  test('converts UTC-minus (America/New_York) local times to exact UTC ISO instants', () => {
    // 2026-11-22 09:00 AM EST (UTC-05:00) -> 14:00 UTC
    const utcDate = timezoneUtil.localToUtc('2026-11-22', '09:00', 'America/New_York');
    assert.equal(utcDate.toISOString(), '2026-11-22T14:00:00.000Z');

    // 2026-11-22 00:15 AM EST near midnight -> 05:15 UTC
    const midnightEdge = timezoneUtil.localToUtc('2026-11-22', '00:15', 'America/New_York');
    assert.equal(midnightEdge.toISOString(), '2026-11-22T05:15:00.000Z');
  });

  test('calculates correct weekday in target timezone', () => {
    // 2026-11-22 is Sunday (0), 2026-11-23 is Monday (1)
    const sundayKolkata = timezoneUtil.getWeekdayInTimezone('2026-11-22', 'Asia/Kolkata');
    const mondayKolkata = timezoneUtil.getWeekdayInTimezone('2026-11-23', 'Asia/Kolkata');
    assert.equal(sundayKolkata, 0);
    assert.equal(mondayKolkata, 1);

    const sundayNY = timezoneUtil.getWeekdayInTimezone('2026-11-22', 'America/New_York');
    const mondayNY = timezoneUtil.getWeekdayInTimezone('2026-11-23', 'America/New_York');
    assert.equal(sundayNY, 0);
    assert.equal(mondayNY, 1);
  });

  test('formats slot labels and times consistently in clinic timezone', () => {
    const utcDate = new Date('2026-11-22T03:30:00.000Z');
    const labelKolkata = timezoneUtil.formatTimeInTimezone(utcDate, 'Asia/Kolkata');
    const time24hKolkata = timezoneUtil.format24hTimeInTimezone(utcDate, 'Asia/Kolkata');
    assert.equal(labelKolkata, '9:00 AM');
    assert.equal(time24hKolkata, '09:00');

    const utcNY = new Date('2026-11-22T14:00:00.000Z');
    const labelNY = timezoneUtil.formatTimeInTimezone(utcNY, 'America/New_York');
    const time24hNY = timezoneUtil.format24hTimeInTimezone(utcNY, 'America/New_York');
    assert.equal(labelNY, '9:00 AM');
    assert.equal(time24hNY, '09:00');
  });

  test('schedulingEngine.generateSlotsForDate returns consistent slot shape with timezone labels', () => {
    const blocks = [{ start_time: '09:00:00', end_time: '10:00:00', slot_minutes: 30 }];
    const dayAppointments = [];

    const slots = schedulingEngine.generateSlotsForDate('2026-11-22', blocks, dayAppointments, 'Asia/Kolkata');
    assert.equal(slots.length, 2);

    assert.equal(slots[0].start, '2026-11-22T03:30:00.000Z');
    assert.equal(slots[0].label, '9:00 AM');
    assert.equal(slots[0].time, '09:00');
    assert.equal(slots[0].available, true);
    assert.equal(slots[0].durationMin, 30);

    assert.equal(slots[1].start, '2026-11-22T04:00:00.000Z');
    assert.equal(slots[1].label, '9:30 AM');
    assert.equal(slots[1].time, '09:30');
    assert.equal(slots[1].available, true);
  });

  test('schedulingEngine.detectConflict detects overlapping appointment windows', () => {
    const existing = [
      { id: 101, scheduled_at: '2026-11-22T03:30:00.000Z', duration_min: 30, status: 'confirmed' }
    ];

    // Conflict: start inside existing
    const conflict1 = schedulingEngine.detectConflict(existing, '2026-11-22T03:45:00.000Z', 15);
    assert.ok(conflict1);
    assert.equal(conflict1.id, 101);

    // No conflict: starts right when existing ends
    const noConflict = schedulingEngine.detectConflict(existing, '2026-11-22T04:00:00.000Z', 15);
    assert.equal(noConflict, null);

    // Cancelled appointments are ignored
    const cancelled = [
      { id: 102, scheduled_at: '2026-11-22T03:30:00.000Z', duration_min: 30, status: 'cancelled' }
    ];
    const noConflictCancelled = schedulingEngine.detectConflict(cancelled, '2026-11-22T03:30:00.000Z', 30);
    assert.equal(noConflictCancelled, null);
  });
});

describe('Phase 0 - Database Exclusion Constraint & Concurrent Double Booking', () => {
  const testClinicId = 1;
  const testDoctorId = 1;
  const testSlotTime = '2028-06-15T09:00:00.000Z'; // Far future slot to avoid collision with seed data

  after(async () => {
    // Clean up test appointments
    await db.query(
      `DELETE FROM appointments WHERE clinic_id = $1 AND doctor_id = $2 AND scheduled_at = $3`,
      [testClinicId, testDoctorId, testSlotTime]
    );
    await db.pool.end();
  });

  test('database prevents overlapping appointments via exclusion constraint', async () => {
    // Clean up any leftovers
    await db.query(
      `DELETE FROM appointments WHERE clinic_id = $1 AND doctor_id = $2 AND scheduled_at = $3`,
      [testClinicId, testDoctorId, testSlotTime]
    );

    // Insert first appointment
    const first = await db.query(
      `INSERT INTO appointments (clinic_id, pet_id, doctor_id, scheduled_at, duration_min, type, reason, source, status)
       VALUES ($1, 1, $2, $3, 30, 'general_checkup', 'Constraint Test 1', 'test', 'scheduled')
       RETURNING *;`,
      [testClinicId, testDoctorId, testSlotTime]
    );
    assert.ok(first.rows[0].id);

    // Attempt overlapping insert: should fail with code 23P01
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO appointments (clinic_id, pet_id, doctor_id, scheduled_at, duration_min, type, reason, source, status)
           VALUES ($1, 1, $2, '2028-06-15T09:15:00.000Z', 30, 'general_checkup', 'Constraint Test 2', 'test', 'scheduled')
           RETURNING *;`,
          [testClinicId, testDoctorId]
        );
      },
      (err) => {
        assert.equal(err.code, '23P01');
        return true;
      }
    );
  });

  test('concurrent booking of the same slot ends with exactly one success and one 409 conflict', async () => {
    const concurrentSlot = '2028-06-16T10:00:00.000Z';

    // Clean up
    await db.query(
      `DELETE FROM appointments WHERE clinic_id = $1 AND doctor_id = $2 AND scheduled_at = $3`,
      [testClinicId, testDoctorId, concurrentSlot]
    );

    const bookingPayload = {
      pet_id: 1,
      doctor_id: testDoctorId,
      scheduled_at: concurrentSlot,
      duration_min: 30,
      type: 'general_checkup',
      reason: 'Concurrent Race Test',
      source: 'owner_portal',
      status: 'scheduled',
    };

    // Run two bookings concurrently
    const [result1, result2] = await Promise.allSettled([
      schedulingService.createAppointment(testClinicId, bookingPayload, 1),
      schedulingService.createAppointment(testClinicId, bookingPayload, 1),
    ]);

    const successes = [result1, result2].filter((r) => r.status === 'fulfilled');
    const failures = [result1, result2].filter((r) => r.status === 'rejected');

    assert.equal(successes.length, 1, 'Exactly one booking must succeed');
    assert.equal(failures.length, 1, 'Exactly one booking must be rejected');

    const err = failures[0].reason;
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, 'SLOT_CONFLICT');

    // Clean up
    await db.query(
      `DELETE FROM appointments WHERE clinic_id = $1 AND doctor_id = $2 AND scheduled_at = $3`,
      [testClinicId, testDoctorId, concurrentSlot]
    );
  });
});
