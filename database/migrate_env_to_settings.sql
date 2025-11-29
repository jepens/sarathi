-- Migration script to copy environment variables to database
-- Run this ONCE to migrate existing .env values to app_settings table
-- After migration, you can manage these settings via /dashboard/settings

-- Instructions:
-- 1. Replace the placeholder values below with your actual .env values
-- 2. Run this script in your Supabase SQL Editor
-- 3. After successful migration, these values can be managed via dashboard

-- WhatsApp Settings
UPDATE app_settings 
SET value = 'EAAOOBFxBujMBOZBL0S4JbothWzCHzcgJRbSEwyHpaZC33eKKvuPYsFIEFcgCKfARcwCf7gkCo4cBlriFv6ZCx8xDHs0Vbnj7OcQm9Igg9ZCHxMvBby1KOWKqmoc2a8Lo9QTpO8lEIiBzj8fNNKCYZBkZCjsPfX7wzG37W8lwR3bbH2qnoe67WnzsEWwxfH1QS12wZDZD' 
WHERE key = 'whatsapp_access_token' AND value = '';

UPDATE app_settings 
SET value = '668003893055590' 
WHERE key = 'whatsapp_phone_number_id' AND value = '';

UPDATE app_settings 
SET value = '1aafe59a62fbda1e0adefd1d8f96bf9a' 
WHERE key = 'whatsapp_app_secret' AND value = '';

UPDATE app_settings 
SET value = '16381738' 
WHERE key = 'whatsapp_verify_token' AND value = '';

-- AI Settings
UPDATE app_settings 
SET value = 'k-svcacct-9URc2TnSMUigxkiXtXToJPJlKSg99TryIGcX77SGjaN8E9JFIrpPN_pCT-JW69DFM_4aLVcyYnT3BlbkFJMDK8X8vUvNMPBK39xOVD1khv3YjFm0kC_CpDlah2PoRFRSnHD7z7tkGprJMjtzZ8wfQTt6_5QA' 
WHERE key = 'openai_api_key' AND value = '';

-- Shipping Settings (optional)
UPDATE app_settings 
SET value = '0KutCiCz396b710cc2de0138th7k3kDe' 
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
