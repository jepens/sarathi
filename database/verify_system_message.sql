-- Verification Script for System Message Table
-- Run this in Supabase SQL Editor to verify the installation

-- 1. Check if table exists
SELECT 
    table_name,
    table_type
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name = 'system_message';

-- 2. Check table structure
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public' 
AND table_name = 'system_message'
ORDER BY ordinal_position;

-- 3. Check if default system message exists
SELECT 
    id,
    name,
    is_active,
    description,
    LENGTH(content) as content_length,
    created_at,
    updated_at
FROM system_message;

-- 4. Verify only one active message
SELECT 
    COUNT(*) as total_messages,
    COUNT(CASE WHEN is_active = true THEN 1 END) as active_messages
FROM system_message;

-- Expected results:
-- - Table exists: 1 row
-- - Columns: id, name, content, is_active, description, created_at, updated_at
-- - At least 1 system message with name='default' and is_active=true
-- - Only 1 active message
