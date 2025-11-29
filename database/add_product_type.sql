-- Migration: Add type column to products table
-- Purpose: Support both products and services in catalog
-- Date: 2025-11-29

-- Add type column with CHECK constraint
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'product' 
CHECK (type IN ('product', 'service'));

-- Update existing records to ensure all have type='product'
UPDATE products 
SET type = 'product' 
WHERE type IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN products.type IS 'Product type: product (physical goods with stock) or service (unlimited availability)';

-- Verify migration
SELECT 
    id, 
    name, 
    type, 
    stock,
    created_at 
FROM products 
ORDER BY created_at DESC 
LIMIT 5;
