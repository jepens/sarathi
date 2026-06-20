# Fase 1 — Multi-tenancy (Sarathi)

> Rencana teknis untuk direview sebelum coding. Keputusan: **1 user = 1 EO**,
> **org diturunkan dari login (tanpa subdomain)**. Masih satu Supabase project &
> satu nomor WhatsApp (per-tenant WhatsApp = Fase 2).

Referensi pola: Supabase RLS (context7 `/supabase/supabase` — "Optimized RLS
Policy without join", "RLS Policy with security definer function",
`handle_new_user`), Next.js auth (context7 `/vercel/next.js`).

---

## 1. Model tenant

```sql
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique,
  created_at  timestamptz not null default now()
);

create type public.org_role as enum ('owner','admin','staff');

create table public.organization_members (
  org_id     uuid not null references public.organizations on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  role       public.org_role not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on public.organization_members (user_id);
```

**Helper SECURITY DEFINER** — wajib agar policy di `organization_members`
sendiri tidak rekursif, dan lebih cepat (pola context7 `is_room_participant` /
`private.has_good_role`):

```sql
create or replace function public.is_org_member(check_org uuid)
returns boolean language sql security definer set search_path = '' stable
as $$
  select exists (
    select 1 from public.organization_members m
    where m.org_id = check_org and m.user_id = (select auth.uid())
  );
$$;
```

RLS untuk tabel tenant itu sendiri:

```sql
alter table public.organizations enable row level security;
create policy "read own org" on public.organizations
  for select to authenticated using (public.is_org_member(id));

alter table public.organization_members enable row level security;
-- pakai (select auth.uid()) langsung → tidak rekursif
create policy "read own memberships" on public.organization_members
  for select to authenticated using (user_id = (select auth.uid()));
```

---

## 2. Kolom `org_id` per tabel (skema nyata, 12 tabel)

| Tabel | rows | `org_id`? | Catatan |
|---|---|---|---|
| whatsapp_chats | 40 | ✅ | lead/kontak/CRM |
| whatsapp_messages | 570 | ✅ | pesan |
| documents | 6 | ✅ | chunk+embedding KB |
| kb_sources | 5 | ✅ | sumber KB |
| products | 0 | ✅ | Paket Acara |
| orders | 1 | ✅ | Bookings |
| proposals | 0 | ✅ | (fitur deprecated, tetap di-scope) |
| vendors | 17 | ✅ | vendor |
| system_message | 0 | ✅ | persona per-org |
| app_settings | 0 | ✅ | config per-org (lihat §5) |
| message_queue | 260 | ✅ | di-set saat enqueue (webhook) |
| rate_limits | 40 | ⚠️ | boleh tetap global (infra), atau scope org |

**Policy template** (berlaku ke semua tabel ✅ — bentuk "no join" + helper):

```sql
-- contoh whatsapp_chats (RLS sudah enabled, tinggal ganti policy)
create policy "org members access chats" on public.whatsapp_chats
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
create index on public.whatsapp_chats (org_id);
```

---

## 3. ⚠️ Audit jalur service-role (RISIKO UTAMA)

Service-role **mem-bypass RLS** → setiap tulis **harus set `org_id` manual**.
Kalau satu saja lupa → kebocoran lintas-tenant. File yang menulis via
service-role (hasil audit):

| File | Yang ditulis | Aksi Fase 1 |
|---|---|---|
| [app/api/webhook/whatsapp/route.ts](../app/api/webhook/whatsapp/route.ts) | whatsapp_chats, whatsapp_messages, message_queue | resolve org (Fase 1: org default; Fase 2: `phone_number_id`→org), set `org_id` di semua insert |
| [app/api/queue/process/route.ts](../app/api/queue/process/route.ts) | proses queue → AI | bawa `org_id` dari item queue |
| [lib/ai/tools.ts](../lib/ai/tools.ts) | saveLeadInfo, updateLeadStage, create_order | terima `orgId`, set di patch/insert |
| [lib/ai/rag.ts](../lib/ai/rag.ts) | baca KB/produk, ringkasan | filter retrieval by `org_id` |
| [lib/whatsapp/queue-db.ts](../lib/whatsapp/queue-db.ts) | enqueue/update queue | set `org_id` |
| [lib/whatsapp/history.ts](../lib/whatsapp/history.ts) | history pesan | set `org_id` |
| [lib/settings/app-settings.ts](../lib/settings/app-settings.ts) + business-profile | settings/profil | scope by `org_id` (§5) |
| scripts/* (backfill, seed) | one-off | tambah param `org_id` |

**Fase 1 single-number:** webhook resolve ke **satu org default** via helper
`getDefaultOrgId()` (baca `app_settings` global `default_org_id`, atau satu-satunya
org). Diganti `phone_number_id`→org di Fase 2.

---

## 4. Urutan migrasi (berurutan, reversibel)

1. `0025` buat `organizations`, `organization_members`, enum, `is_org_member()`, RLS+policy keduanya.
2. `0026` seed: insert org **"Sailendra Organizer"**, tambah user admin existing sebagai `owner`. Simpan id-nya ke `app_settings` (`default_org_id`) untuk dipakai jalur service-role.
3. `0027` per tabel tenant: `add column org_id uuid references organizations` (**nullable dulu**).
4. `0028` **backfill** `org_id = default_org` untuk semua baris lama (12 tabel).
5. `0029` `alter column org_id set not null` + `create index (org_id)` per tabel.
6. `0030` ganti policy lama → policy `is_org_member(org_id)` per tabel (drop policy permissif lama dulu).
7. `0031` trigger signup → auto-buat org + membership (lihat §6).

Tiap langkah punya `down` (drop policy/column/table) untuk rollback.

---

## 5. `app_settings` / `system_message` / BusinessProfile → per-org

- Tambah `org_id` ke `app_settings` & `system_message`; unik per (org_id, key).
- `getBusinessProfile()` & `getActiveSystemMessage()` **resolve org saat ini**
  lalu filter `eq('org_id', orgId)`. **Call site tak berubah** (abstraksi Fase 0
  sudah menyiapkan ini) — cukup ubah implementasi internal + tambah param `orgId`
  pada jalur service-role.
- Beberapa key tetap **global** (mis. `whatsapp_verify_token` bila satu nomor) →
  pisahkan: key global tanpa `org_id`, key tenant dengan `org_id`.

Resolusi org aktif (jalur UI, 1 user = 1 org):

```ts
// lib/settings/org.ts (baru)
export async function getCurrentOrgId(client?) {
  const supabase = client ?? await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1).maybeSingle();
  return data?.org_id ?? null;
}
```

---

## 6. Signup → auto-buat org (pola context7 `handle_new_user`)

```sql
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare new_org uuid;
begin
  insert into public.organizations (name)
  values (coalesce(new.raw_user_meta_data ->> 'org_name', 'EO Saya'))
  returning id into new_org;

  insert into public.organization_members (org_id, user_id, role)
  values (new_org, new.id, 'owner');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
```

App: ganti "Admin Login" → halaman **Sign up + Sign in** (Supabase Auth).
Saat signup, kirim `org_name` di `options.data` → trigger pakai sebagai nama org.
Onboarding minimal: setelah signup, arahkan ke Settings → Profil Bisnis.

---

## 7. Sub-fase eksekusi

- **1a — Fondasi isolasi** (§1–§5 migrasi + backfill + RLS). Output: data Sailendra
  ter-scope ke org default, RLS aktif, app jalan seperti biasa (single org).
- **1b — Auth/onboarding** (§6): signup multi-org, halaman auth, org-scoped
  settings/persona/KB di UI.
- **1c — Audit service-role** (§3): pastikan SEMUA tulis service-role set `org_id`;
  tes dengan 2 org dummy bahwa data tidak bocor.

## 8. Risiko & catatan
- **Kebocoran lintas-tenant** lewat service-role → mitigasi: helper wajib +
  test 2-org.
- **Backfill** harus jalan sebelum `NOT NULL`; di luar jam sibuk.
- **Embeddings (documents)**: retrieval RAG harus filter `org_id` (match function
  `match_documents` perlu param org).
- Verifikasi tiap migrasi di branch Supabase / lokal sebelum remote.
