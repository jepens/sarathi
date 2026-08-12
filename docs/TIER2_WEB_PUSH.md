# Tier 2 — Web Push (notifikasi walau app ditutup)

Notifikasi pesan masuk seperti WhatsApp Web, **tetap muncul walau tab/aplikasi
dashboard sudah ditutup**. Server (webhook) mengirim _push_ ke setiap perangkat
admin yang sudah berlangganan setiap kali ada pesan customer masuk, lalu service
worker menampilkan notifikasi OS-nya.

> **Status:** Kode **selesai & lolos gate** (typecheck · lint · test 98 · build) di
> branch `feat/inbound-notifications` (PR #4), menyatu dengan `sw.js` Tier 1.
> **Belum aktif di runtime** sampai dua langkah operasional dikerjakan: (1) isi env
> VAPID, (2) terapkan migrasi `0046_push_subscriptions.sql`. Tanpa itu, fitur
> dorman — Tier 1 (notifikasi selama tab terbuka) tetap jalan.

---

## 1. Tier 1 vs Tier 2 — kenapa dua-duanya ada

| Kondisi tab | Yang menangani | Mekanisme |
|---|---|---|
| Terbuka & fokus | **Tier 1** | Realtime Supabase → toast + chime |
| Terbuka tapi tab lain / minimized | **Tier 1** (+ Tier 2) | Realtime → `showNotification` (desktop) |
| **Ditutup total** | **Tier 2** | Web Push dari server → SW `push` handler |

Tier 1 instan tapi hanya hidup selama ada tab dashboard terbuka. Tier 2 menutup
celah "app ditutup". Keduanya memakai **`tag` notifikasi yang sama**
(`wa:<phone>`) sehingga kalau dua-duanya kebetulan menyala (tab tersembunyi tapi
terbuka), keduanya **menyatu jadi satu notifikasi**, bukan menumpuk.

---

## 2. Komponen (file yang ditamb/diubah)

| File | Peran |
|---|---|
| `supabase/migrations/0046_push_subscriptions.sql` | Tabel `push_subscriptions` + RLS |
| `lib/notifications/web-push.ts` | **Server** — `sendPushToOrg()`, `isPushConfigured()`, prune sub mati (404/410) |
| `lib/notifications/push.ts` | **Client** — `subscribeToPush()`, `unsubscribeFromPush()`, `urlBase64ToUint8Array()` |
| `app/api/push/subscribe/route.ts` | Simpan/refresh langganan (auth-gated, upsert on `endpoint`) |
| `app/api/push/unsubscribe/route.ts` | Hapus langganan (idempoten) |
| `public/sw.js` | Handler `push` baru (+ `notificationclick` dari Tier 1) |
| `components/notifications/notification-provider.tsx` | Daftar push saat "Aktifkan", batal saat "Nonaktifkan", resync saat load |
| `components/notifications/notification-bell.tsx` | Copy berubah saat push aktif ("walau ditutup") |
| `app/api/webhook/whatsapp/route.ts` | Fan-out `sendPushToOrg` setelah insert pesan (deduped 23505) |
| `.env.example` | Empat variabel VAPID |
| `lib/notifications/__tests__/push.test.ts` | Unit test decoder VAPID |

---

## 3. Setup (2 langkah operasional)

### 3a. Env VAPID
Buat satu pasang kunci VAPID **sekali** (kunci milikmu, jangan di-commit):

```bash
npx web-push generate-vapid-keys
```

Isi ke `.env.local` (produksi: di panel env server). **Public key dipakai di dua
variabel** — client butuh untuk subscribe, server butuh untuk menandatangani:

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public key>
VAPID_PUBLIC_KEY=<public key yang SAMA>
VAPID_PRIVATE_KEY=<private key — RAHASIA, jangan NEXT_PUBLIC>
VAPID_SUBJECT=mailto:admin@sailendra.co.id
```

> `NEXT_PUBLIC_VAPID_PUBLIC_KEY` di-_inline_ saat build → **rebuild** setelah
> mengisinya. Kalau ketiganya kosong, Tier 2 mati total (Tier 1 tetap jalan).

- [ ] Env VAPID terisi (dev + prod)

### 3b. Migrasi
Terapkan `0046_push_subscriptions.sql` **sebelum** deploy kode (aditif +
idempoten — `create table if not exists`). Lewat Supabase MCP `apply_migration`
di sesi interaktif, atau `supabase db push`.

- [ ] Migrasi 0046 diterapkan (cek `list_migrations`)

### 3c. Aktifkan dari dashboard
Klik lonceng **Notifikasi → Aktifkan** di sidebar. Browser minta izin →
`subscribeToPush` mendaftarkan perangkat ke server. Ulangi di tiap perangkat yang
mau dapat notifikasi.

- [ ] Minimal satu perangkat berlangganan (cek `select count(*) from push_subscriptions`)

---

## 4. Alur runtime

```
Customer kirim WA
   └─> webhook /api/webhook/whatsapp  (service-role)
         ├─ insert whatsapp_messages (wa_message_id UNIQUE → 23505 dedup)
         └─ sendPushToOrg(org)                     ← HANYA jika insert sukses
               └─ web-push → endpoint tiap device
                     └─ SW 'push' → showNotification(tag: wa:<phone>)
                           └─ notificationclick → fokus/buka /dashboard/chats?phone=…
```

- **Idempoten:** fan-out digantung pada insert pesan yang sukses **dan** `wamid`
  yang ada. Redelivery Meta kena 23505 → tidak sampai ke `sendPushToOrg`. Pesan
  tanpa `wamid` (anomali langka, sudah di-log) tak punya kunci dedup → push
  di-skip agar tidak dobel saat redelivery.
- **Best-effort:** kegagalan push (VAPID kosong, push service down) tidak pernah
  mengganggu penyimpanan pesan — dibungkus try/catch, `sendPushToOrg` tak melempar.
- **Manual mode (AI off) tetap dinotif** — justru saat itu admin paling perlu tahu.
  Fan-out berada di luar cabang `aiEnabled`.

---

## 5. Dedup & suara ganda

Push API Chrome mewajibkan `userVisibleOnly: true` → **setiap** push wajib
menampilkan notifikasi. Jadi dedup dilakukan lewat `tag`, bukan dengan menahan
notifikasi:

- **Visual:** Tier 1 & Tier 2 pakai `tag` sama → OS menyatukan jadi satu.
- **Suara:** SW `push` handler cek `clients.matchAll`. Kalau ada tab **dashboard
  terbuka** (fokus ATAU sekadar tersembunyi — Tier 1 sudah chime + tampilkan
  notifikasinya sendiri), push dibuat `silent: true` + tanpa `renotify` (cuma
  me-refresh notifikasi ber-`tag` sama). Hanya saat app **benar-benar tertutup**
  (tak ada tab dashboard) push berbunyi + `renotify`. Ini mencegah double-chime
  pada pola "dashboard nyala di tab latar".

---

## 6. Caveat iOS / Safari

- iOS **hanya** mendukung Web Push untuk **PWA yang di-_install_ ke Home Screen**
  (Bagikan → Tambah ke Layar Utama), **iOS 16.4+**. Di tab Safari biasa, push
  tidak jalan — Tier 1 tetap berlaku selama tab terbuka.
- Desktop Chrome/Edge/Firefox & Android Chrome: didukung penuh.
- `isPushSupported()` menjaga UI tetap waras di browser tak didukung (subscribe
  di-skip, tak ada error).

---

## 7. Verifikasi manual

- [ ] Aktifkan notifikasi di dashboard → `push_subscriptions` bertambah satu baris.
- [ ] **Tutup semua tab dashboard**, kirim WA dari nomor lain → notifikasi OS muncul,
      klik → buka chat yang benar.
- [ ] Tab dashboard fokus, kirim WA → hanya satu notifikasi (tak dobel), tak ada
      dua chime.
- [ ] Nonaktifkan notifikasi → baris `push_subscriptions` perangkat itu hilang.
- [ ] Cabut izin di browser lalu kirim WA → server dapat 410 → baris auto-terprune
      (cek log `pruned N stale subscription(s)`).

---

## 8. Batasan & residual

- **Rotasi langganan:** kalau browser merotasi endpoint saat app tertutup, event
  `pushsubscriptionchange` di SW belum ditangani; resync saat load berikutnya
  (`subscribeToPush` idempoten) yang memulihkannya. Cukup untuk pemakaian normal.
- **Tanpa VAPID = dorman**, bukan error — sengaja, agar Tier 1 mandiri.
- **Fan-out saat ini di jalur pesan `text`.** Contact-share & WhatsApp Flow
  (`nfm_reply`, ada di PR #3) belum ikut fan-out; bisa ditambahkan setelah PR #3
  & PR #4 sama-sama masuk `main`.
