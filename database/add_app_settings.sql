-- Add new app settings for WhatsApp and AI configuration
-- This migration adds settings that can be configured via /dashboard/settings

-- Insert WhatsApp settings (if not exists)
INSERT INTO app_settings (key, value, description)
VALUES 
    ('whatsapp_access_token', '', 'WhatsApp Business API Access Token')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value, description)
VALUES 
    ('whatsapp_phone_number_id', '', 'WhatsApp Business Phone Number ID')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value, description)
VALUES 
    ('whatsapp_app_secret', '', 'WhatsApp App Secret for webhook signature validation')
ON CONFLICT (key) DO NOTHING;

-- Insert AI settings (if not exists)
INSERT INTO app_settings (key, value, description)
VALUES 
    ('openai_api_key', '', 'OpenAI API Key for AI Chat and RAG features')
ON CONFLICT (key) DO NOTHING;

-- Insert Shipping settings (if not exists) - for future use
INSERT INTO app_settings (key, value, description)
VALUES 
    ('shipping_api_key', '', 'Komerce API Key for shipping cost calculation')
ON CONFLICT (key) DO NOTHING;

-- Note: whatsapp_webhook_url and whatsapp_verify_token should already exist
-- from previous migrations
