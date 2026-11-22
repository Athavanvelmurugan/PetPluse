-- Migration 011: Double Booking Prevention Exclusion Constraint & Clinic Timezone
-- 1. Enable btree_gist extension for combining scalar equality (=) with range overlap (&&)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2. Ensure timezone column exists on clinic_settings
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Kolkata';

UPDATE clinic_settings cs
SET timezone = COALESCE(c.timezone, 'Asia/Kolkata')
FROM clinics c
WHERE c.id = cs.clinic_id AND (cs.timezone IS NULL OR cs.timezone = '');

-- 3. Resolve pre-existing duplicate/overlapping test bookings so constraint can be enforced cleanly
WITH overlapping AS (
  SELECT a2.id
  FROM appointments a1
  JOIN appointments a2 ON a1.doctor_id = a2.doctor_id AND a1.id < a2.id
  WHERE a1.doctor_id IS NOT NULL
    AND a1.status NOT IN ('cancelled', 'no_show')
    AND a2.status NOT IN ('cancelled', 'no_show')
    AND tsrange(
          (a1.scheduled_at AT TIME ZONE 'UTC'),
          (a1.scheduled_at AT TIME ZONE 'UTC') + make_interval(mins => a1.duration_min)
        ) &&
        tsrange(
          (a2.scheduled_at AT TIME ZONE 'UTC'),
          (a2.scheduled_at AT TIME ZONE 'UTC') + make_interval(mins => a2.duration_min)
        )
)
UPDATE appointments
SET status = 'cancelled',
    cancelled_reason = 'Cancelled by migration 011: resolved pre-existing slot conflict before applying exclusion constraint'
WHERE id IN (SELECT id FROM overlapping);

-- 4. Apply btree_gist exclusion constraint on appointments
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS prevent_overlapping_doctor_appointments;

ALTER TABLE appointments
ADD CONSTRAINT prevent_overlapping_doctor_appointments
EXCLUDE USING gist (
  doctor_id WITH =,
  tsrange(
    (scheduled_at AT TIME ZONE 'UTC'),
    (scheduled_at AT TIME ZONE 'UTC') + make_interval(mins => duration_min)
  ) WITH &&
) WHERE (doctor_id IS NOT NULL AND status NOT IN ('cancelled', 'no_show'));

