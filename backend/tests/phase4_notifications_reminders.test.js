const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/connection');
const notificationService = require('../src/modules/notifications/notification.service');
const reminderScheduler = require('../src/modules/scheduling/reminder.scheduler');

describe('Phase 4 - Notifications & 24h Background Reminders', () => {
  let testClinic = null;
  let testOwner = null;
  let testDoctor = null;
  let testPet = null;
  let testAppointmentId = null;
  let createdNotificationIds = [];

  before(async () => {
    // 1. Fetch clinic
    const clinicRes = await db.query(`SELECT id, name, address FROM clinics LIMIT 1;`);
    testClinic = clinicRes.rows[0] || { id: 1, name: 'Central Valley Animal Hospital', address: '123 Pet St' };

    // 2. Fetch doctor
    const docRes = await db.query(
      `SELECT id, name, email FROM users WHERE role IN ('doctor', 'veterinarian') AND status = 'ACTIVE' LIMIT 1;`
    );
    testDoctor = docRes.rows[0];

    // 3. Fetch owner with valid email or set test email
    const ownerRes = await db.query(`SELECT id, name, email, user_id FROM owners WHERE email IS NOT NULL LIMIT 1;`);
    if (ownerRes.rows.length > 0) {
      testOwner = ownerRes.rows[0];
    } else {
      const fallback = await db.query(`SELECT id, name, email, user_id FROM owners LIMIT 1;`);
      testOwner = fallback.rows[0];
      testOwner.email = 'guardian@test.com';
      await db.query(`UPDATE owners SET email = 'guardian@test.com' WHERE id = $1;`, [testOwner.id]);
    }

    // 4. Fetch pet
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
        `INSERT INTO pets (clinic_id, name, species) VALUES ($1, 'Oscar', 'Canine') RETURNING id, name, species;`,
        [testClinic.id]
      );
      testPet = insPet.rows[0];
      await db.query(
        `INSERT INTO pet_owners (pet_id, owner_id, is_primary) VALUES ($1, $2, true) ON CONFLICT DO NOTHING;`,
        [testPet.id, testOwner.id]
      );
    }
  });

  after(async () => {
    if (testAppointmentId) {
      await db.query(`DELETE FROM appointments WHERE id = $1`, [testAppointmentId]);
    }
    if (createdNotificationIds.length > 0) {
      await db.query(`DELETE FROM notifications WHERE id = ANY($1)`, [createdNotificationIds]);
    }
    await db.query(`DELETE FROM push_subscriptions WHERE endpoint LIKE '%test-mock-endpoint%'`);
    await db.pool.end();
  });

  test('sendAppointmentConfirmation generates .ics invite, emails owner, and alerts doctor', async () => {
    const fakeApt = {
      id: 999901,
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      duration_min: 15,
      reason: 'Annual Checkup',
    };

    await notificationService.sendAppointmentConfirmation({
      clinicId: testClinic.id,
      appointment: fakeApt,
      owner: testOwner,
      doctor: testDoctor,
      pet: testPet,
      clinic: testClinic,
    });

    // Verify notification table records
    const ownerNotifRes = await db.query(
      `SELECT id, template, recipient, channel, payload
       FROM notifications
       WHERE template = 'appointment_confirmation' AND recipient = $1
       ORDER BY created_at DESC LIMIT 1;`,
      [testOwner.email.toLowerCase()]
    );

    assert.ok(ownerNotifRes.rows.length > 0, 'Owner email confirmation must be recorded');
    createdNotificationIds.push(ownerNotifRes.rows[0].id);

    // Verify doctor notification
    const docNotifRes = await db.query(
      `SELECT id, template, channel
       FROM notifications
       WHERE template = 'new_appointment_doctor'
       ORDER BY created_at DESC LIMIT 1;`
    );

    assert.ok(docNotifRes.rows.length > 0, 'Doctor in-app notification must be recorded');
    createdNotificationIds.push(docNotifRes.rows[0].id);
  });

  test('sendWebPush dispatches push notification to registered devices', async () => {
    const mockEndpoint = `https://fcm.googleapis.com/fcm/send/test-mock-endpoint-${Date.now()}`;
    const mockKeys = {
      auth: 'dGVzdGF1dGhrZXkxMjM0NTY=',
      p256dh: 'dGVzdHAyNTZkaGtleTEyMzQ1Njc4OTA=',
    };

    await db.query(
      `INSERT INTO push_subscriptions (user_id, owner_id, endpoint, keys)
       VALUES ($1, $2, $3, $4);`,
      [testOwner.user_id, testOwner.id, mockEndpoint, JSON.stringify(mockKeys)]
    );

    const pushResult = await notificationService.sendWebPush({
      clinicId: testClinic.id,
      ownerId: testOwner.id,
      userId: testOwner.user_id,
      payload: {
        title: 'Upcoming Visit Test',
        body: 'Testing web push notification pipeline',
        url: '/owner-portal',
      },
    });

    assert.ok(pushResult !== null, 'Web Push handler must return array of dispatch attempts');

    const notifRes = await db.query(
      `SELECT id FROM notifications WHERE channel = 'push' ORDER BY created_at DESC LIMIT 1;`
    );
    assert.ok(notifRes.rows.length > 0, 'Push notification audit row must be inserted');
    createdNotificationIds.push(notifRes.rows[0].id);
  });

  test('sendAppointmentCancellation records cancellation notice', async () => {
    const fakeApt = {
      id: 999902,
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    };

    await notificationService.sendAppointmentCancellation({
      clinicId: testClinic.id,
      appointment: fakeApt,
      owner: testOwner,
      doctor: testDoctor,
      pet: testPet,
      clinic: testClinic,
    });

    const notifRes = await db.query(
      `SELECT id FROM notifications WHERE template = 'appointment_cancellation' ORDER BY created_at DESC LIMIT 1;`
    );
    assert.ok(notifRes.rows.length > 0, 'Cancellation notification must be recorded');
    createdNotificationIds.push(notifRes.rows[0].id);
  });

  test('24-Hour Reminder Background Scheduler scans upcoming visits and updates reminder_sent_at', async () => {
    // 1. Create test appointment 6 hours in the future without reminder
    const scheduledTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const insApt = await db.query(
      `INSERT INTO appointments (clinic_id, pet_id, doctor_id, scheduled_at, duration_min, status, reason, reminder_sent_at)
       VALUES ($1, $2, $3, $4, 15, 'scheduled', '24h Reminder Test', NULL)
       RETURNING id, reminder_sent_at;`,
      [testClinic.id, testPet.id, testDoctor.id, scheduledTime]
    );

    testAppointmentId = insApt.rows[0].id;
    assert.equal(insApt.rows[0].reminder_sent_at, null);

    // 2. Run reminder scheduler
    const result = await reminderScheduler.checkAndSendReminders();
    assert.ok(result.processed >= 1, 'Must process at least 1 pending reminder');

    // 3. Verify reminder_sent_at was stamped
    const updatedApt = await db.query(`SELECT reminder_sent_at FROM appointments WHERE id = $1;`, [testAppointmentId]);
    assert.ok(updatedApt.rows[0].reminder_sent_at !== null, 'reminder_sent_at must be populated');

    // 4. Verify reminder notification was logged
    const reminderNotif = await db.query(
      `SELECT id FROM notifications WHERE template = 'appointment_reminder_24h' ORDER BY created_at DESC LIMIT 1;`
    );
    assert.ok(reminderNotif.rows.length > 0, 'Reminder notification must be created');
    createdNotificationIds.push(reminderNotif.rows[0].id);
  });
});
