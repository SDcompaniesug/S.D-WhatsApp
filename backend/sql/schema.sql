CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(16) NOT NULL UNIQUE,
  phone_verified_at TIMESTAMPTZ,
  display_name VARCHAR(80),
  username VARCHAR(30) UNIQUE,
  about VARCHAR(140),
  avatar_url TEXT,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(120),
  platform VARCHAR(30) NOT NULL DEFAULT 'android',
  push_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(12) NOT NULL CHECK (type IN ('direct', 'group')),
  title VARCHAR(100),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(12) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_read_message_id UUID,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_message_id UUID,
  message_type VARCHAR(20) NOT NULL DEFAULT 'text',
  ciphertext TEXT,
  media_url TEXT,
  reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  UNIQUE (sender_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- Add message encryption metadata and refresh-token sessions in a later
-- migration before enabling production messaging and long-lived sessions.
