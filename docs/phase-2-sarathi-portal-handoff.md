# Phase 2 — Handoff Sarathi → Portal (forward cable + spine Organization minimal)

> **Status:** Cetak biru implementasi (siap dibangun). Disusun 29 Jun 2026.
> **Sifat:** LINTAS-APP. Kanonik di repo perencanaan (`Sailendra AI Platform`); ini salinan untuk repo Sarathi.
> **SARATHI = sisi yang dibangun SETELAH Portal** (endpoint intake Portal harus ada dulu). Buat feature branch (mis. `feat/portal-handoff`).
> Sisi pasangannya (endpoint `/api/intake/*`) ada di repo Portal (`sailendra event portal`).

---

## 0. Konteks & Keputusan

- **Tujuan:** internal-first — dari lead siap di Sarathi (cockpit harian), **satu klik** → mendarat di **draft proposal Portal yang sudah terisi**, dengan klien Portal **dibuat-atau-ditautkan**. Menghapus pengetikan ulang data klien.
- **Hadiah strategis:** keystone yang menetapkan **identitas Organization bersama** → menjadikan 3 app satu pipeline; membuka loop-balik repeat/upsell (Phase 3) & kelak genome Samsara.
- **Organization kanonik = `clients` Portal.** Sarathi (kontak/lead-sentris, kunci nomor HP) menyimpan `portal_client_id` di lead. Identitas dipin **manusia** di handoff pertama (link-or-create), lalu diingat selamanya.
- **Mekanisme = API langsung** (Sarathi sudah biasa outbound HTTP — memanggil WhatsApp Graph API). Sinkron & dipicu-user.

---

## 1. Arsitektur

```
  SARATHI (cockpit, repo INI)                    PORTAL (hub Organization)
  ┌──────────────────────┐   GET /api/intake/    ┌────────────────────────────┐
  │ Lead siap            │ ─── clients?q=astra ─▶ │ cari clients (picker)      │
  │ [Buat Proposal di    │                        │ → [{id,name}]              │
  │  Portal]             │   POST /api/intake/    │ resolve/insert client      │
  │  • link-or-create    │ ──── handoff ────────▶ │  + buat DRAFT proposal     │
  │  • kirim brief lead  │ ◀── {clientId,         │  + source_ref+idempotency  │
  │ simpan               │     proposalId,        │                            │
  │ portal_client_id     │     proposalUrl}       │                            │
  └──────────────────────┘                        └────────────────────────────┘
        buka proposalUrl (tab baru) → mendarat di proposal terisi
```

---

## 2. Delta skema Sarathi (aditif)

| Tabel | Perubahan | Guna |
|---|---|---|
| `whatsapp_chats` (lead) | `portal_client_id uuid null` (+ opsional `portal_last_proposal_url text`) | Ingat tautan Organization → handoff berikutnya lewati picker; cegah klien ganda |

---

## 3. Alur UX & server action (sisi Sarathi)

Tombol **"Buat Proposal di Portal"** pada detail lead:
- **`portal_client_id` kosong (pertama kali):** buka picker —
  - kotak cari (debounced) → `GET {PORTAL_BASE_URL}/api/intake/clients?q=…` → daftar klien Portal;
  - tombol **"Buat klien baru"** (nama prefill dari lead);
  - manusia memastikan identitas Organization **sekali**.
- **`portal_client_id` ada:** lewati picker, langsung handoff (pakai id tersimpan).
- Submit → **server action** Sarathi `POST {PORTAL_BASE_URL}/api/intake/handoff` dengan body (lihat §4). Sukses → simpan `portal_client_id` (+ `proposalUrl`) di lead → buka `proposalUrl` di tab baru.
- Env Sarathi: `PORTAL_BASE_URL`, `PORTAL_INTAKE_TOKEN` (server-side only).

---

## 4. Body request yang Sarathi kirim ke Portal

```jsonc
POST {PORTAL_BASE_URL}/api/intake/handoff
Authorization: Bearer {PORTAL_INTAKE_TOKEN}
{
  "idempotencyKey": "uuid-per-attempt",         // generate sekali per klik; retry pakai yang sama
  "client": { "mode": "existing", "clientId": "uuid" },
        // ATAU { "mode": "new", "name": "PT Astra" },
  "proposal": { "title": "Penawaran — Gathering PT Astra" },
  "brief": {                                     // dari field lead (whatsapp_chats)
    "eventInterest": "team_building", "participantCount": 300,
    "locationPref": "Bandung", "eventDatePref": "Q1 2026",
    "eventGoals": "…", "budgetRange": "250jt",
    "contactName": "Budi", "phone": "+62…", "email": "…"
  },
  "sourceRef": { "app": "sarathi", "leadId": "<phone_number lead>" }
}
```
Response: `{ "clientId", "proposalId", "proposalUrl" }` → simpan `clientId` ke `portal_client_id`, buka `proposalUrl`.

---

## 5. Auth & keamanan (sisi Sarathi)

- `PORTAL_INTAKE_TOKEN` = rahasia bersama dengan Portal; **server-side only**, jangan pernah masuk client bundle.
- Panggilan hanya dari **server action** (bukan dari browser) → token tak bocor; sekaligus hindari CORS.
- `idempotencyKey` di-generate sekali per klik dan dipakai ulang saat retry agar tak membuat proposal ganda.

---

## 6. Acceptance criteria (sisi Sarathi)

- [ ] Tombol "Buat Proposal di Portal" muncul di detail lead.
- [ ] Handoff pertama: picker mencari klien Portal live + opsi buat baru; submit → tab Portal terbuka di proposal; lead menyimpan `portal_client_id`.
- [ ] Handoff kedua lead sama: lewati picker, pakai `portal_client_id`, tanpa klien ganda.
- [ ] Klik-ganda → `idempotencyKey` sama → tanpa proposal ganda.
- [ ] Token disimpan server-side; tak ada kebocoran ke client bundle.

---

## 7. Urutan & best practice

1. **Portal (repo `sailendra event portal`) DULU** — endpoint `/api/intake/clients` & `/api/intake/handoff` + auth + idempotensi. (Lihat salinan blueprint di repo Portal.)
2. **Sarathi (repo INI) menyusul** — `whatsapp_chats.portal_client_id` + tombol/picker + server action outbound + env. Uji end-to-end ke Portal.

---

## 8. Di luar lingkup Phase 2 (ditunda)

- Membuat **event** Portal saat handoff → belakangan.
- Sinkron status balik (proposal `approved` → update `lead_stage` Sarathi) & **loop-balik repeat/upsell** → **Phase 3** (n8n untuk alur latar/event-driven).
- Auto-match nama perusahaan → tetap manual link-or-create.
