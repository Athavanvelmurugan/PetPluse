/**
 * Scheduling engine: slot computation, overlap detection, conflict resolution
 */

const timezoneUtil = require('../../utils/timezone');

class SchedulingEngine {
  /**
   * Check if a proposed appointment window overlaps with any existing appointments.
   * @param {Array} existingAppointments - Array of appointment objects with scheduled_at and duration_min
   * @param {Date|string} newStart - Start time of candidate appointment
   * @param {number} durationMin - Duration in minutes
   * @param {number|null} excludeAppointmentId - Optional ID to ignore (e.g. when updating existing appointment)
   * @returns {Object|null} Conflicting appointment or null if clear
   */
  detectConflict(existingAppointments, newStart, durationMin, excludeAppointmentId = null) {
    const start = new Date(newStart).getTime();
    const end = start + durationMin * 60 * 1000;

    for (const apt of existingAppointments) {
      if (excludeAppointmentId && apt.id === excludeAppointmentId) continue;
      if (apt.status === 'cancelled' || apt.status === 'no_show') continue;

      const aptStart = new Date(apt.scheduled_at).getTime();
      const aptEnd = aptStart + (apt.duration_min || 15) * 60 * 1000;

      // Overlap condition: start < aptEnd AND end > aptStart
      if (start < aptEnd && end > aptStart) {
        return apt;
      }
    }

    return null;
  }

  /**
   * Generate available slots for a given date, doctor's schedule blocks, and clinic timezone.
   * @param {string} dateStr - 'YYYY-MM-DD'
   * @param {Array} availabilityBlocks - [{ start_time: '09:00:00', end_time: '17:00:00', slot_minutes: 15 }]
   * @param {Array} dayAppointments - Active appointments on that day for that doctor
   * @param {string} timeZone - IANA timezone (e.g. 'Asia/Kolkata', 'America/New_York')
   * @returns {Array} List of slots with consistent shape: { start, end, label, time, available, durationMin, ... }
   */
  generateSlotsForDate(dateStr, availabilityBlocks, dayAppointments, timeZone = 'UTC') {
    const slots = [];

    for (const block of availabilityBlocks) {
      const slotMin = block.slot_minutes || 15;
      const startTimeStr = block.start_time || '09:00:00';
      const endTimeStr = block.end_time || '17:00:00';

      const blockStart = timezoneUtil.localToUtc(dateStr, startTimeStr, timeZone);
      const blockEnd = timezoneUtil.localToUtc(dateStr, endTimeStr, timeZone);

      let current = new Date(blockStart);
      while (current.getTime() + slotMin * 60 * 1000 <= blockEnd.getTime()) {
        const slotStart = new Date(current);
        const slotEnd = new Date(current.getTime() + slotMin * 60 * 1000);

        const conflict = this.detectConflict(dayAppointments, slotStart, slotMin);

        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          startTime: slotStart.toISOString(), // backward compatibility
          endTime: slotEnd.toISOString(),     // backward compatibility
          label: timezoneUtil.formatTimeInTimezone(slotStart, timeZone), // e.g. "10:30 AM"
          time: timezoneUtil.format24hTimeInTimezone(slotStart, timeZone), // e.g. "10:30"
          available: !conflict,
          durationMin: slotMin,
          bookedAppointment: conflict ? {
            id: conflict.id,
            petName: conflict.pet_name,
            reason: conflict.reason,
            status: conflict.status,
          } : null,
        });

        current = new Date(current.getTime() + slotMin * 60 * 1000);
      }
    }

    return slots;
  }
}

module.exports = new SchedulingEngine();
