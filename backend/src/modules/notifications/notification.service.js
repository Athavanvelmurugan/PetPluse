const nodemailer = require('nodemailer');
const webpush = require('web-push');
const db = require('../../db/connection');
const config = require('../../config');

// Initialize Web Push VAPID configuration if keys exist
if (config.webPush && config.webPush.publicKey && config.webPush.privateKey) {
  try {
    webpush.setVapidDetails(
      config.webPush.subject || 'mailto:admin@petcare.ai',
      config.webPush.publicKey,
      config.webPush.privateKey
    );
  } catch (err) {
    console.warn('[NotificationService] Failed to initialize Web Push VAPID:', err.message);
  }
}

// Initialize Nodemailer transporter with free SMTP or console fallback
let smtpTransporter = null;
if (config.smtp && config.smtp.host) {
  try {
    smtpTransporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port || 587,
      secure: config.smtp.port === 465,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });
  } catch (err) {
    console.warn('[NotificationService] Failed to initialize SMTP transporter:', err.message);
  }
}

/**
 * Generate iCalendar (.ics) format string for appointment invites
 */
function buildIcsContent({ appointmentId, summary, description, location, startIso, durationMin = 15 }) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationMin * 60 * 1000);
  const formatDate = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PetCare AI//Appointment Assistant//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:appointment-${appointmentId}@petcare.ai`,
    `DTSTAMP:${formatDate(new Date())}`,
    `DTSTART:${formatDate(start)}`,
    `DTEND:${formatDate(end)}`,
    `SUMMARY:${summary || 'Veterinary Clinical Appointment'}`,
    `DESCRIPTION:${(description || '').replace(/\n/g, '\\n')}`,
    `LOCATION:${location || 'PetCare Animal Hospital'}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

class NotificationService {
  /**
   * Queue and dispatch an email notification
   */
  async sendEmail({ clinicId, ownerId, recipient, subject, html, text, template, payload = {}, attachments = [] }) {
    if (!recipient) {
      console.warn('[NotificationService] Skipped email: missing recipient address');
      return null;
    }

    // Insert into notifications queue table
    const insertQuery = `
      INSERT INTO notifications (
        clinic_id, owner_id, channel, template, recipient, subject, payload, status, sent_at
      )
      VALUES ($1, $2, 'email', $3, $4, $5, $6, 'sent', NOW())
      RETURNING *;
    `;
    const values = [
      clinicId || null,
      ownerId || null,
      template,
      recipient.trim().toLowerCase(),
      subject,
      JSON.stringify(payload),
    ];

    const { rows } = await db.query(insertQuery, values);
    const notification = rows[0];

    // If SMTP is configured, attempt real email transmission
    if (smtpTransporter) {
      try {
        await smtpTransporter.sendMail({
          from: config.smtp.from || 'PetCare AI <no-reply@petcare.ai>',
          to: recipient,
          subject,
          text: text || subject,
          html: html || undefined,
          attachments,
        });
        console.log(`[NotificationService] SMTP email sent successfully to ${recipient}`);
      } catch (err) {
        console.warn(`[NotificationService] SMTP delivery failed for ${recipient}:`, err.message);
      }
    } else {
      // Free dev/staging console logger
      console.log(`\n=======================================================`);
      console.log(`📧 [EMAIL DISPATCHED] ID #${notification.id}`);
      console.log(`📬 To: ${recipient}`);
      console.log(`📌 Subject: ${subject}`);
      console.log(`📄 Template: ${template}`);
      if (attachments && attachments.length > 0) {
        console.log(`📎 Attachments: ${attachments.map((a) => a.filename).join(', ')}`);
      }
      console.log(`🔗 Link: ${payload.link || 'N/A'}`);
      console.log(`=======================================================\n`);
    }

    return notification;
  }

  /**
   * Deliver Web Push notification to all subscriptions for a user or owner
   */
  async sendWebPush({ clinicId, ownerId, userId, payload }) {
    if (!config.webPush || !config.webPush.publicKey || !config.webPush.privateKey) {
      console.log('[NotificationService] Web Push skipped: VAPID keys not configured.');
      return null;
    }

    const subRes = await db.query(
      `SELECT id, endpoint, keys
       FROM push_subscriptions
       WHERE (user_id IS NOT NULL AND user_id = $1)
          OR (owner_id IS NOT NULL AND owner_id = $2);`,
      [userId || null, ownerId || null]
    );

    if (subRes.rows.length === 0) {
      return null;
    }

    const payloadString = JSON.stringify(payload);
    const results = [];

    for (const sub of subRes.rows) {
      try {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: typeof sub.keys === 'string' ? JSON.parse(sub.keys) : sub.keys,
        };

        await webpush.sendNotification(pushSubscription, payloadString);
        results.push({ id: sub.id, status: 'delivered' });
      } catch (err) {
        console.warn(`[NotificationService] Push delivery error for subscription #${sub.id}:`, err.statusCode || err.message);
        if (err.statusCode === 404 || err.statusCode === 410) {
          // Subscription has expired or been revoked -> clean up
          await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        }
        results.push({ id: sub.id, status: 'failed', error: err.message });
      }
    }

    // Insert push audit into notifications table
    await db.query(
      `INSERT INTO notifications (clinic_id, owner_id, channel, template, recipient, subject, payload, status, sent_at)
       VALUES ($1, $2, 'push', 'web_push_notification', $3, $4, $5, 'sent', NOW());`,
      [
        clinicId || null,
        ownerId || null,
        `owner_${ownerId || userId}`,
        payload.title || 'PetCare Update',
        JSON.stringify(payload),
      ]
    );

    return results;
  }

  /**
   * Send appointment confirmation email (with .ics attachment), web push, and in-app doctor alert
   */
  async sendAppointmentConfirmation({ clinicId, appointment, owner, doctor, pet, clinic }) {
    const aptDate = new Date(appointment.scheduled_at);
    const dateFormatted = aptDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeFormatted = aptDate.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

    const clinicName = clinic?.name || 'Central Valley Animal Hospital';
    const clinicAddress = clinic?.address || '123 Pet Care Lane, Suite A';
    const doctorName = doctor?.name ? (doctor.name.startsWith('Dr.') ? doctor.name : `Dr. ${doctor.name}`) : 'Veterinary Team';
    const petName = pet?.name || 'your pet';

    const subject = `Confirmed: Veterinary Appointment for ${petName} on ${dateFormatted}`;
    const icsContent = buildIcsContent({
      appointmentId: appointment.id,
      summary: `Veterinary Appointment for ${petName} with ${doctorName}`,
      description: `Appointment reserved for ${petName} (${pet?.species || 'Pet'}). Attending Doctor: ${doctorName}. Location: ${clinicName}. Reason: ${appointment.reason || 'Checkup'}.`,
      location: `${clinicName}, ${clinicAddress}`,
      startIso: appointment.scheduled_at,
      durationMin: appointment.duration_min || 15,
    });

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #2563eb; margin-top: 0;">Appointment Confirmed! 🐾</h2>
        <p>Dear ${owner?.name || 'Pet Guardian'},</p>
        <p>Your appointment for <strong>${petName}</strong> has been successfully confirmed at <strong>${clinicName}</strong>.</p>
        <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
          <p style="margin: 6px 0;"><strong>Patient Pet:</strong> ${petName} (${pet?.species || 'Pet'})</p>
          <p style="margin: 6px 0;"><strong>Date:</strong> ${dateFormatted}</p>
          <p style="margin: 6px 0;"><strong>Time:</strong> ${timeFormatted}</p>
          <p style="margin: 6px 0;"><strong>Attending Veterinarian:</strong> ${doctorName}</p>
          <p style="margin: 6px 0;"><strong>Hospital Location:</strong> ${clinicName}, ${clinicAddress}</p>
          <p style="margin: 6px 0;"><strong>Reason for Visit:</strong> ${appointment.reason || 'Routine Checkup'}</p>
        </div>
        <p>A calendar invitation file (<code>invite.ics</code>) is attached to this email. You can add it directly to Apple Calendar, Google Calendar, or Outlook.</p>
        <p style="font-size: 13px; color: #64748b;">If you need to reschedule or cancel, you can do so directly in the Pet Guardian portal or with Dharu AI Assistant.</p>
      </div>
    `;

    // 1. Send Email to Pet Owner
    if (owner?.email) {
      await this.sendEmail({
        clinicId,
        ownerId: owner.id,
        recipient: owner.email,
        subject,
        html,
        text: `Your appointment for ${petName} with ${doctorName} on ${dateFormatted} at ${timeFormatted} is confirmed at ${clinicName}.`,
        template: 'appointment_confirmation',
        payload: {
          appointmentId: appointment.id,
          petName,
          doctorName,
          dateFormatted,
          timeFormatted,
          clinicName,
        },
        attachments: [
          {
            filename: `appointment_${appointment.id}.ics`,
            content: icsContent,
            contentType: 'text/calendar',
          },
        ],
      });
    }

    // 2. Send Web Push to Pet Owner
    await this.sendWebPush({
      clinicId,
      ownerId: owner?.id,
      userId: owner?.userId,
      payload: {
        title: `Appointment Confirmed! 🐾`,
        body: `${petName}'s visit with ${doctorName} is booked for ${dateFormatted} at ${timeFormatted}.`,
        url: '/owner-portal',
      },
    });

    // 3. Create In-App Notification for Attending Doctor
    if (doctor?.id) {
      await db.query(
        `INSERT INTO notifications (clinic_id, recipient, channel, template, subject, payload, status, sent_at)
         VALUES ($1, $2, 'email', 'new_appointment_doctor', $3, $4, 'sent', NOW());`,
        [
          clinicId || null,
          doctor.email || `doctor_${doctor.id}@clinic.local`,
          `New Appointment Scheduled: ${petName} (${owner?.name || 'Owner'})`,
          JSON.stringify({
            appointmentId: appointment.id,
            doctorId: doctor.id,
            doctorName,
            petName,
            ownerName: owner?.name,
            scheduledAt: appointment.scheduled_at,
          }),
        ]
      );
    }
  }

  /**
   * Send appointment cancellation notice via Email and Web Push
   */
  async sendAppointmentCancellation({ clinicId, appointment, owner, doctor, pet, clinic }) {
    const aptDate = new Date(appointment.scheduled_at);
    const dateFormatted = aptDate.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
    const petName = pet?.name || 'your pet';
    const doctorName = doctor?.name || 'the veterinarian';

    const subject = `Cancelled: Appointment for ${petName} on ${dateFormatted}`;

    if (owner?.email) {
      await this.sendEmail({
        clinicId,
        ownerId: owner.id,
        recipient: owner.email,
        subject,
        text: `Your appointment for ${petName} on ${dateFormatted} with ${doctorName} has been cancelled.`,
        template: 'appointment_cancellation',
        payload: {
          appointmentId: appointment.id,
          petName,
          dateFormatted,
        },
      });
    }

    await this.sendWebPush({
      clinicId,
      ownerId: owner?.id,
      userId: owner?.userId,
      payload: {
        title: `Appointment Cancelled`,
        body: `Your visit for ${petName} on ${dateFormatted} has been cancelled.`,
        url: '/owner-portal',
      },
    });
  }

  /**
   * Send 24-hour appointment reminder
   */
  async sendAppointmentReminder({ clinicId, appointment, owner, doctor, pet, clinic }) {
    const aptDate = new Date(appointment.scheduled_at);
    const dateFormatted = aptDate.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
    const timeFormatted = aptDate.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const petName = pet?.name || 'your pet';
    const doctorName = doctor?.name ? (doctor.name.startsWith('Dr.') ? doctor.name : `Dr. ${doctor.name}`) : 'your veterinarian';
    const clinicName = clinic?.name || 'Central Valley Animal Hospital';

    const subject = `Reminder: ${petName}'s Veterinary Visit Tomorrow at ${timeFormatted}`;

    if (owner?.email) {
      await this.sendEmail({
        clinicId,
        ownerId: owner.id,
        recipient: owner.email,
        subject,
        text: `Friendly reminder that ${petName} has an upcoming visit with ${doctorName} at ${clinicName} on ${dateFormatted} at ${timeFormatted}.`,
        template: 'appointment_reminder_24h',
        payload: {
          appointmentId: appointment.id,
          petName,
          doctorName,
          dateFormatted,
          timeFormatted,
          clinicName,
        },
      });
    }

    await this.sendWebPush({
      clinicId,
      ownerId: owner?.id,
      userId: owner?.userId,
      payload: {
        title: `Upcoming Visit Reminder 🐾`,
        body: `${petName}'s appointment with ${doctorName} is tomorrow at ${timeFormatted}.`,
        url: '/owner-portal',
      },
    });
  }

  async sendConsentRequest({ clinicId, ownerId, recipient, ownerName, petName, consultationId }) {
    const portalUrl = `${config.frontendUrl || 'http://localhost:3000'}?portal=owner`;
    const subject = `Digital Recording Consent Request for ${petName || 'your pet'}`;
    return this.sendEmail({
      clinicId,
      ownerId,
      recipient,
      subject,
      template: 'digital_consent_request',
      payload: {
        ownerName,
        petName,
        consultationId,
        link: portalUrl,
        message: `Dr. Attending has requested your digital consent to record audio for ${petName}'s clinical visit. Please review and sign digitally in the Pet Owner Portal.`,
      },
    });
  }

  async sendDocumentsReady({ clinicId, ownerId, recipient, ownerName, petName, docTitle, shareUrl }) {
    const subject = `Official Medical Records & Prescription Ready for ${petName || 'your pet'}`;
    return this.sendEmail({
      clinicId,
      ownerId,
      recipient,
      subject,
      template: 'documents_ready',
      payload: {
        ownerName,
        petName,
        docTitle,
        link: shareUrl,
        message: `Your verified clinical summary and signed prescription for ${petName} are ready. You can download and verify the official PDF report directly.`,
      },
    });
  }

  async getOwnerNotifications(ownerId) {
    const query = `
      SELECT id, channel, template, recipient, subject, payload, status, sent_at, created_at
      FROM notifications
      WHERE owner_id = $1
      ORDER BY created_at DESC
      LIMIT 50;
    `;
    const { rows } = await db.query(query, [ownerId]);
    return rows;
  }
}

module.exports = new NotificationService();
