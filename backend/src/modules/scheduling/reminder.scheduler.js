const db = require('../../db/connection');
const notificationService = require('../notifications/notification.service');

class ReminderScheduler {
  constructor() {
    this.timer = null;
    this.isRunning = false;
  }

  /**
   * Scans appointments within the next 24 hours that haven't received a reminder.
   * Sends email & push notifications, then stamps reminder_sent_at = NOW().
   */
  async checkAndSendReminders() {
    if (this.isRunning) return { processed: 0, skipped: true };
    this.isRunning = true;

    try {
      const query = `
        SELECT a.id, a.scheduled_at, a.duration_min, a.clinic_id, a.doctor_id, a.pet_id,
               p.name AS pet_name, p.species,
               o.id AS owner_id, o.name AS owner_name, o.email AS owner_email, o.user_id AS owner_user_id,
               u.name AS doctor_name, u.email AS doctor_email,
               c.name AS clinic_name, c.address AS clinic_address
        FROM appointments a
        JOIN pets p ON p.id = a.pet_id
        LEFT JOIN pet_owners po ON po.pet_id = p.id
        LEFT JOIN owners o ON o.id = po.owner_id
        LEFT JOIN users u ON u.id = a.doctor_id
        LEFT JOIN clinics c ON c.id = a.clinic_id
        WHERE a.scheduled_at BETWEEN NOW() AND (NOW() + INTERVAL '24 hours')
          AND a.status IN ('scheduled', 'confirmed')
          AND a.reminder_sent_at IS NULL
        ORDER BY a.scheduled_at ASC;
      `;

      const { rows } = await db.query(query);
      let count = 0;

      for (const row of rows) {
        try {
          await notificationService.sendAppointmentReminder({
            clinicId: row.clinic_id,
            appointment: {
              id: row.id,
              scheduled_at: row.scheduled_at,
              duration_min: row.duration_min,
            },
            owner: {
              id: row.owner_id,
              name: row.owner_name,
              email: row.owner_email,
              userId: row.owner_user_id,
            },
            doctor: {
              id: row.doctor_id,
              name: row.doctor_name,
              email: row.doctor_email,
            },
            pet: {
              id: row.pet_id,
              name: row.pet_name,
              species: row.species,
            },
            clinic: {
              name: row.clinic_name,
              address: row.clinic_address,
            },
          });

          // Stamp reminder as sent
          await db.query(
            `UPDATE appointments SET reminder_sent_at = NOW() WHERE id = $1;`,
            [row.id]
          );

          count++;
        } catch (itemErr) {
          console.error(`[ReminderScheduler] Failed to process reminder for appointment #${row.id}:`, itemErr.message);
        }
      }

      if (count > 0) {
        console.log(`[ReminderScheduler] Dispatched ${count} 24-hour appointment reminder(s).`);
      }

      return { processed: count, skipped: false };
    } catch (err) {
      console.error('[ReminderScheduler] Error during reminder scan:', err.message);
      return { processed: 0, error: err.message };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start recurring background timer
   */
  start(intervalMs = 15 * 60 * 1000) {
    if (this.timer) clearInterval(this.timer);

    console.log(`[ReminderScheduler] Background 24h reminder scheduler started (interval: ${intervalMs / 1000}s)`);

    // Initial check on startup
    this.checkAndSendReminders().catch(() => {});

    // Recurring interval
    this.timer = setInterval(() => {
      this.checkAndSendReminders().catch(() => {});
    }, intervalMs);

    // Prevent unref if in node environment to allow timer to run gracefully in background
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stop background timer
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[ReminderScheduler] Background scheduler stopped.');
    }
  }
}

module.exports = new ReminderScheduler();
