// Vendor categories — shared across API routes and UI.
// Mirrors the CHECK constraint in supabase/migrations/0004_vendors_table.sql
// (vendors_category_check). Keep this list in sync if the migration changes.
//
// Lives in lib/ rather than inside a route file because Next.js route
// handlers shouldn't be cross-imported between routes — keeping shared
// constants in lib avoids surprising bundler behavior.

export const VENDOR_CATEGORIES = [
    'catering',
    'venue',
    'transport',
    'entertainment',
    'photography',
    'decoration',
    'mc',
    'other',
] as const;

export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

export function isVendorCategory(value: unknown): value is VendorCategory {
    return typeof value === 'string'
        && (VENDOR_CATEGORIES as readonly string[]).includes(value);
}
