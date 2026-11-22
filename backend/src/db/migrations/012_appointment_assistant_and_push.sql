-- Migration 012: Appointment Assistant Sessions, Web Push Subscriptions & Channel Tracking
--
-- Rollback Notes:
--   DROP TABLE IF EXISTS assistant_sessions;
--   DROP TABLE IF EXISTS push_subscriptions;
--   ALTER TABLE appointments DROP COLUMN IF EXISTS booking_channel;
--   ALTER TABLE appointments DROP COLUMN IF EXISTS booking_transcript;
--   ALTER TABLE appointments DROP COLUMN IF EXISTS reminder_sent_at;
--   ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_booking_channel_check;
--   ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;

-- 1. Assistant Sessions Table (UUID PK, expires in 15 mins, JSONB state and transcript)
CREATE TABLE IF NOT EXISTS assistant_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id INT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL DEFAULT 'chat' CHECK (channel IN ('chat', 'voice', 'telegram')),
  state VARCHAR(30) NOT NULL DEFAULT 'GREETING',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assistant_sessions_owner_exp ON assistant_sessions(owner_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_exp ON assistant_sessions(expires_at);

-- 2. Web Push Subscriptions Table
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  keys JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- 3. Widen Notifications Channel Check Constraint to include 'push'
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check CHECK (channel IN ('email', 'push', 'sms', 'whatsapp'));

-- 4. Extend Appointments with Booking Channel, Spoken Transcript & 24h Reminder Tracker
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booking_channel VARCHAR(20) NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booking_transcript TEXT NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ NULL;

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_booking_channel_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_booking_channel_check CHECK (booking_channel IS NULL OR booking_channel IN ('form', 'chat', 'voice', 'telegram'));

CREATE INDEX IF NOT EXISTS idx_appointments_reminder ON appointments(scheduled_at, reminder_sent_at) WHERE status IN ('scheduled', 'confirmed');

