-- Enable Realtime for WhatsApp Chat Tables
-- Run this in Supabase SQL Editor to enable instant real-time updates

-- Enable realtime replication for whatsapp_chats table
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_chats;

-- Enable realtime replication for whatsapp_messages table
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_messages;

-- Verify realtime is enabled
SELECT 
    schemaname,
    tablename,
    pubname
FROM 
    pg_publication_tables
WHERE 
    pubname = 'supabase_realtime'
    AND tablename IN ('whatsapp_chats', 'whatsapp_messages');
