-- Add contact_name column to whatsapp_chats table
ALTER TABLE whatsapp_chats 
ADD COLUMN IF NOT EXISTS contact_name TEXT;

-- Create a function to update contact name (optional, but good for RPC if needed later)
-- For now, we can just use standard UPDATE queries via Supabase client
