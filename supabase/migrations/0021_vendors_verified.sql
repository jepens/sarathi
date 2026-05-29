-- M4.x — Admin verification flag for vendors.
-- Marks a directory entry as manually vetted by an admin (vs. just auto-captured
-- from a WhatsApp chat or quickly added). Surfaced as a "Terverifikasi" badge.

alter table public.vendors
    add column if not exists verified boolean not null default false;

comment on column public.vendors.verified is
    'Admin-verified vendor (manually vetted). Shown as a "Terverifikasi" badge in the directory; toggled from the vendor card.';
