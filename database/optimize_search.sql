-- Enable pg_trgm extension for fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add trigram index to products name for faster ilike and similarity search
CREATE INDEX IF NOT EXISTS products_name_trgm_idx ON products USING GIN (name gin_trgm_ops);

-- Add index to products type for faster filtering
CREATE INDEX IF NOT EXISTS products_type_idx ON products (type);

-- Add index to orders customer_phone for faster history retrieval
CREATE INDEX IF NOT EXISTS orders_customer_phone_idx ON orders (customer_phone);

-- Add index to whatsapp_messages phone_number and created_at for faster chat history
CREATE INDEX IF NOT EXISTS whatsapp_messages_phone_created_at_idx ON whatsapp_messages (phone_number, created_at DESC);
