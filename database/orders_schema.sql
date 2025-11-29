-- Create orders table
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_name TEXT,
    customer_phone TEXT REFERENCES whatsapp_chats(phone_number),
    items JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of {name, qty, price, note}
    total_amount NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'pending', -- pending, paid, shipped, completed, cancelled
    delivery_info TEXT, -- Address for products, Meeting Link/Location for services
    order_type TEXT DEFAULT 'product', -- product, service
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Create policy for admins (authenticated users)
CREATE POLICY "Admins can do everything on orders"
    ON orders
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
