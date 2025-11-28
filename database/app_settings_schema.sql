-- App Settings Table
-- This table stores application-level settings like webhook configuration

CREATE TABLE IF NOT EXISTS app_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_app_settings_key ON app_settings(key);

-- Insert default webhook settings
INSERT INTO app_settings (key, value, description) VALUES
    ('whatsapp_webhook_url', 'http://localhost:3000/api/webhook/whatsapp', 'WhatsApp webhook URL - update this when deploying to production'),
    ('whatsapp_verify_token', '123456', 'WhatsApp webhook verify token - must match Meta Developer Portal configuration')
ON CONFLICT (key) DO NOTHING;

-- Enable Row Level Security
ALTER TABLE app_settings ENABLE ROW LEVEL Security;

-- Policy: Only authenticated users can read settings
CREATE POLICY "Allow authenticated users to read settings"
    ON app_settings FOR SELECT
    TO authenticated
    USING (true);

-- Policy: Only authenticated users can update settings
CREATE POLICY "Allow authenticated users to update settings"
    ON app_settings FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Function to update timestamp
CREATE OR REPLACE FUNCTION update_app_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS app_settings_updated_at ON app_settings;
CREATE TRIGGER app_settings_updated_at
    BEFORE UPDATE ON app_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_app_settings_updated_at();

-- SECURE TOKEN VERIFICATION FUNCTION
-- This allows the webhook route (which might be anonymous) to verify the token
-- without exposing the actual token value.
CREATE OR REPLACE FUNCTION verify_webhook_token(input_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER -- Runs with privileges of the creator (admin), bypassing RLS
SET search_path = public -- Secure search path
AS $$
DECLARE
    stored_token TEXT;
BEGIN
    SELECT value INTO stored_token
    FROM app_settings
    WHERE key = 'whatsapp_verify_token';
    
    -- If no token stored, default to false (or handle as needed)
    IF stored_token IS NULL THEN
        RETURN FALSE;
    END IF;
    
    RETURN stored_token = input_token;
END;
$$;

-- Grant execute permission to everyone (including anonymous webhook calls)
GRANT EXECUTE ON FUNCTION verify_webhook_token TO anon;
GRANT EXECUTE ON FUNCTION verify_webhook_token TO authenticated;
GRANT EXECUTE ON FUNCTION verify_webhook_token TO service_role;
