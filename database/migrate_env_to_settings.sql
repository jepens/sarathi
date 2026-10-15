-- Migration script to copy environment variables to database
-- Run this ONCE to migrate existing .env values to app_settings table
-- After migration, you can manage these settings via /dashboard/settings

-- Instructions:
-- 1. Replace the placeholder values below with your actual .env values
-- 2. Run this script in your Supabase SQL Editor
-- 3. After successful migration, these values can be managed via dashboard

-- WhatsApp Settings
UPDATE app_settings 
SET value = '<WHATSAPP_ACCESS_TOKEN>' 
WHERE key = 'whatsapp_access_token' AND value = '';

UPDATE app_settings 
SET value = '<WHATSAPP_PHONE_NUMBER_ID>' 
WHERE key = 'whatsapp_phone_number_id' AND value = '';

UPDATE app_settings 
SET value = '<WHATSAPP_APP_SECRET>' 
WHERE key = 'whatsapp_app_secret' AND value = '';

UPDATE app_settings 
SET value = '<WHATSAPP_VERIFY_TOKEN>' 
WHERE key = 'whatsapp_verify_token' AND value = '';

-- AI Settings
UPDATE app_settings 
SET value = '<OPENAI_API_KEY>' 
WHERE key = 'openai_api_key' AND value = '';

-- Shipping Settings (optional)
UPDATE app_settings 
SET value = '<SHIPPING_API_KEY>' 
WHERE key = 'shipping_api_key' AND value = '';

-- Verify migration
SELECT key, 
       CASE 
           WHEN value = '' THEN '❌ Empty'
           ELSE '✅ Configured'
       END as status,
       description
FROM app_settings
WHERE key IN (
    'whatsapp_access_token',
    'whatsapp_phone_number_id', 
    'whatsapp_app_secret',
    'whatsapp_verify_token',
    'openai_api_key',
    'shipping_api_key'
)
ORDER BY key;
