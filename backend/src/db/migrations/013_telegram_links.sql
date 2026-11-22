-- Migration 013: Telegram Bot Integration Links
CREATE TABLE IF NOT EXISTS telegram_links (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  chat_id BIGINT UNIQUE,
  link_code VARCHAR(6),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_links_chat ON telegram_links(chat_id);
CREATE INDEX IF NOT EXISTS idx_telegram_links_code ON telegram_links(link_code);

