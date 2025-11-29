-- Revert settings to environment variables
-- Deletes the keys that are now managed by .env from the app_settings table

DELETE FROM app_settings 
WHERE key IN (
    'whatsapp_access_token',
    'whatsapp_phone_number_id',
    'whatsapp_app_secret',
    'openai_api_key',
    'shipping_api_key'
);
