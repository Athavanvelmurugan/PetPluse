const db = require('../../db/connection');
const schedulingRepo = require('../scheduling/scheduling.repository');
const timezoneUtil = require('../../utils/timezone');

/**
 * Loads dynamic context required by the assistant:
 *  - Owner's registered pets
 *  - Clinic doctors and specialties
 *  - Clinic timezone
 *  - Today's date in clinic timezone
 *  - Clinic contact details for emergency escalation
 */
async function loadContext(ownerId, clinicId = 1) {
  const resolvedClinicId = clinicId || 1;

  // 1. Fetch Owner's registered pets
  const petsRes = await db.query(
    `SELECT p.id, p.name, p.species, p.breed
     FROM pets p
     JOIN pet_owners po ON po.pet_id = p.id
     WHERE po.owner_id = $1
     ORDER BY p.id ASC;`,
    [ownerId]
  );
  const pets = petsRes.rows;

  // 2. Fetch Clinic doctors
  const doctorsRes = await db.query(
    `SELECT u.id, u.name, COALESCE(dp.specialization, u.specialty, 'Veterinary Medicine') AS specialty
     FROM users u
     LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
     WHERE (u.clinic_id = $1 OR EXISTS (
       SELECT 1 FROM practice_members pm
       JOIN practices pr ON pr.id = pm.practice_id
       WHERE pm.user_id = u.id AND pr.clinic_id = $1 AND pm.status = 'ACTIVE' AND pm.role IN ('DOCTOR', 'OWNER')
     ))
     AND u.role IN ('doctor', 'veterinarian')
     AND UPPER(u.status) = 'ACTIVE'
     ORDER BY u.name ASC;`,
    [resolvedClinicId]
  );
  const doctors = doctorsRes.rows;

  // 3. Resolve clinic timezone and local date
  const timeZone = await schedulingRepo.getClinicTimezone(resolvedClinicId);
  const todayDate = timezoneUtil.formatDateInTimezone(new Date(), timeZone);

  // 4. Fetch clinic / practice info (phone number for emergency escalation)
  const clinicRes = await db.query(
    `SELECT c.id, c.name, COALESCE(p.phone, c.phone, '+91 98765 43210') AS phone,
            COALESCE(p.address, c.address, 'Veterinary Clinic') AS address
     FROM clinics c
     LEFT JOIN practices p ON p.clinic_id = c.id
     WHERE c.id = $1
     ORDER BY p.id ASC LIMIT 1;`,
    [resolvedClinicId]
  );
  const clinic = clinicRes.rows[0] || { id: resolvedClinicId, name: 'PetCare Hospital', phone: '+91 98765 43210' };

  return {
    ownerId,
    clinicId: resolvedClinicId,
    timeZone,
    todayDate,
    pets,
    doctors,
    clinic,
  };
}

module.exports = {
  loadContext,
};

