/**
 * Pre-defined short, friendly, plain text messages for Dharu (Appointment Assistant).
 * Designed for both visual screen display and browser text-to-speech (window.speechSynthesis).
 */

const messages = {
  greeting: (name) => `Hi ${name || 'there'}! I am Dharu, your veterinary appointment assistant. How can I help you today?`,

  emergencyAlert: (clinicName, phone) =>
    `⚠️ MEDICAL EMERGENCY: If your pet is in critical distress (poisoning, seizure, uncontrolled bleeding, or difficulty breathing), please do not wait for an appointment. Immediately call ${clinicName || 'the emergency clinic'} at ${phone} or proceed to the nearest emergency veterinary facility right away.`,

  askPet: () => 'Which pet is this visit for?',

  askDoctor: () => 'Which doctor would you like to see?',

  doctorNotFound: (name) => `I couldn't find a doctor named "${name}". Please choose from our veterinarians below:`,

  multipleDoctorsMatched: () => 'We have multiple doctors matching that name. Which one would you prefer?',

  askDate: () => 'What date would you like to book? (e.g., today, tomorrow, or a date like 22.11.2026)',

  slotsAvailable: (doctorName, dateStr, slots = [], maxSpoken = 5) => {
    const cleanDoc = String(doctorName || '').replace(/^Dr\.?\s+/i, '');
    const total = slots.length;
    const spoken = slots.slice(0, maxSpoken).map((s) => s.label).join(', ');
    const moreNotice = total > maxSpoken ? `, and ${total - maxSpoken} more available.` : '.';
    return `Dr. ${cleanDoc} is free on ${dateStr} at: ${spoken}${moreNotice} Which time works best for you?`;
  },

  noSlots: (doctorName, dateStr, nextDates = []) => {
    const cleanDoc = String(doctorName || '').replace(/^Dr\.?\s+/i, '');
    if (nextDates.length > 0) {
      const datesFormatted = nextDates.join(', ');
      return `Dr. ${cleanDoc} has no open slots on ${dateStr}. Would you like to check one of these upcoming dates: ${datesFormatted}?`;
    }
    return `Dr. ${cleanDoc} has no available slots on ${dateStr}. Please choose a different date.`;
  },

  slotNotAvailable: () => 'That specific time slot is no longer open. Please select an available slot from the options below.',

  confirmPrompt: (petName, doctorName, dateStr, timeLabel) => {
    const cleanDoc = String(doctorName || '').replace(/^Dr\.?\s+/i, '');
    return `Shall I confirm the appointment for ${petName} with Dr. ${cleanDoc} on ${dateStr} at ${timeLabel}? (Yes / No)`;
  },

  bookingSuccess: (petName, doctorName, dateStr, timeLabel, hospitalName) => {
    const cleanDoc = String(doctorName || '').replace(/^Dr\.?\s+/i, '');
    return `Your appointment for ${petName} with Dr. ${cleanDoc} on ${dateStr} at ${timeLabel} at ${hospitalName || 'our clinic'} is confirmed!`;
  },

  conflictRetry: (doctorName, dateStr) => {
    const cleanDoc = String(doctorName || '').replace(/^Dr\.?\s+/i, '');
    return `I apologize, that slot was just taken by another patient. Here are the remaining open slots with Dr. ${cleanDoc} on ${dateStr}:`;
  },

  myAppointmentsList: (count) => `Here are your ${count} upcoming appointment${count === 1 ? '' : 's'}:`,

  noAppointments: () => 'You have no upcoming appointments scheduled.',

  cancelConfirmPrompt: (petName, doctorName, dateStr, timeLabel) =>
    `Are you sure you want to cancel the appointment for ${petName} with Dr. ${doctorName} on ${dateStr} at ${timeLabel}? (Yes / No)`,

  cancelledSuccess: (petName, dateStr) => `Your appointment for ${petName} on ${dateStr} has been cancelled.`,

  sessionExpired: () => 'Your previous booking session expired. I have started a fresh session for you. How can I help?',

  rephrase: () => "I didn't quite catch that. Could you please rephrase, or tap one of the options below?",

  cancelledBooking: () => 'Booking cancelled. How else may I assist you?',

  help: () => 'You can ask me to book an appointment, check your upcoming visits, or cancel a booking. You can speak or type your request anytime!',

  outOfScopeDecline: (petName) => {
    if (petName) {
      return `I specialize only in veterinary care and clinic appointments for your pets. How can I help with ${petName}'s health or scheduling a visit today?`;
    }
    return `I specialize only in veterinary care and clinic appointments for your pets. Would you like to schedule an appointment or check your upcoming visits?`;
  },

  petHealthGuidance: (petName, symptom) =>
    `I'm sorry to hear ${petName || 'your pet'} is experiencing ${symptom || 'discomfort'}. It's best to have a veterinarian examine this in person. Shall we book a visit for a thorough checkup?`,
};

module.exports = messages;

