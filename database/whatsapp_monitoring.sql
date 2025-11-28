-- Table to store conversation summaries
CREATE TABLE IF NOT EXISTS whatsapp_chats (
    phone_number TEXT PRIMARY KEY,
    last_message TEXT,
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    unread_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table to store individual messages
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number TEXT NOT NULL REFERENCES whatsapp_chats(phone_number),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Index for faster retrieval of chat history
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone ON whatsapp_messages(phone_number);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_created_at ON whatsapp_messages(created_at);

-- Enable RLS (Row Level Security)
ALTER TABLE whatsapp_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

-- Create policies (allow public access for now, or restrict to authenticated users if auth is set up)
-- For this MVP, we'll allow public access to simplify, but in production this should be restricted.
CREATE POLICY "Allow public access to whatsapp_chats" ON whatsapp_chats FOR ALL USING (true);
CREATE POLICY "Allow public access to whatsapp_messages" ON whatsapp_messages FOR ALL USING (true);
