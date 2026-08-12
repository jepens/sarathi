# Phase 2 — Perbaikan Code Review: Handoff Sarathi → Portal

> **Status:** ✅ **Kode 9/9 selesai** (disusun 13 Jul; diimplementasi 14 Jul 2026). Gate hijau
> (`typecheck`/`lint`/`test` 100 lulus/`build`). **Verifikasi manual §6 masih tersisa.**
> **Sumber:** Review kode effort `xhigh` atas fitur *Portal handoff* (PR #1 — commit `2446ac5`).
> **Cakupan:** 9 temuan berbeda (2 CONFIRMED correctness, 5 PLAUSIBLE, 2 cleanup).
> **Keputusan:** Temuan #4 diperbaiki secara *pragmatis* (tanpa migrasi baru). Dokumen ini
> adalah artefak pelacakan — centang tiap item saat perbaikan dikerjakan.
> **2 koreksi terhadap sketsa saat implementasi** (validasi ulang vs kode + Context7):
> **#4** — seed kunci deterministik menyertakan `lead.phone_number` (sketsa hanya `selectionSig`
> → dua lead berbeda dengan nama klien-baru sama bisa bertabrakan di satu kunci; kini tidak).
> **#7** — `window.open('about:blank')` **tanpa** `noopener` (sketsa `'noopener'` mengembalikan
> `null` → handle hilang; `opener` di-null-kan setelah navigasi untuk menjaga proteksi).
> **Terkait:** [phase-2-sarathi-portal-handoff.md](./phase-2-sarathi-portal-handoff.md) (cetak biru fitur).

---

## 1. Ringkasan & pelacakan

Dua temуan P0 **memutus janji inti fitur** ("tanpa klien Portal ganda") secara diam-diam —
perbaiki sebelum deploy berikutnya. Prioritas: **P0** (wajib), **P1** (correctness/hardening),
**P2** (kebersihan kode).

| # | Prioritas | Berkas | Temuan | Vonis | Status |
|---|-----------|--------|--------|-------|--------|
| 1 | 🔴 P0 | [actions.ts:100](../app/dashboard/pipeline/actions.ts) | Kegagalan simpan `portal_client_id` ditelan → klien Portal ganda | CONFIRMED | ✅ kode |
| 2 | 🔴 P0 | [client.ts:78](../lib/portal/client.ts) | Baca body JSON tanpa timeout → request menggantung selamanya | CONFIRMED | ✅ kode |
| 3 | 🟠 P1 | [route.ts:16](../app/api/leads/route.ts) · [actions.ts:25](../app/dashboard/pipeline/actions.ts) | Urutan deploy migrasi 0044 | PLAUSIBLE | ✅ kode |
| 4 | 🟠 P1 | [actions.ts:65](../app/dashboard/pipeline/actions.ts) | Race handoff-pertama konkuren → klien ganda | PLAUSIBLE | ✅ kode |
| 5 | 🟠 P1 | [PortalHandoffDialog.tsx:172](../app/dashboard/pipeline/components/PortalHandoffDialog.tsx) | `crypto.randomUUID()` di luar try + secure-context → no-op senyap via HTTP | PLAUSIBLE | ✅ kode |
| 6 | 🟠 P1 | [client.ts:89](../lib/portal/client.ts) | Klien non-UUID bisa dipilih tapi gagal handoff | PLAUSIBLE | ✅ kode |
| 7 | 🟡 P1 | [PortalHandoffDialog.tsx:194](../app/dashboard/pipeline/components/PortalHandoffDialog.tsx) | `window.open` sesudah `await` diblokir popup blocker | PLAUSIBLE | ✅ kode |
| 8 | 🟡 P2 | [actions.ts:48](../app/dashboard/pipeline/actions.ts) | Query org-scoping mati (dead I/O) | CONFIRMED | ✅ kode |
| 9 | 🟡 P2 | [PortalHandoffDialog.tsx:30](../app/dashboard/pipeline/components/PortalHandoffDialog.tsx) | Interface lead duplikat | PLAUSIBLE | ✅ kode |

**Checklist eksekusi (per fase):**

- [x] **P0** — Temuan #1, #2 (kode selesai + gate hijau; verifikasi manual §6 masih tersisa)
- [x] **P1** — Temuan #3, #4, #5, #6, #7 (kode selesai; #4/#7 dikoreksi dari sketsa — lihat catatan)
- [x] **P2** — Temuan #8, #9
- [x] `npm run typecheck && npm run lint && npm run test && npm run build` hijau (100 tes lulus)
- [ ] Verifikasi manual (lihat §6) selesai

---

## 2. Keputusan kunci

| Keputusan | Pilihan | Alasan |
|-----------|---------|--------|
| Kedalaman perbaikan #4 (race) | **Pragmatis, tanpa migrasi** | App single-tenant, konkurensi rendah (kokpit EO). Persist andal (#1) + kunci idempotensi deterministik untuk handoff pertama menutup mayoritas kasus; sisa risiko didokumentasi. |
| Serialisasi penuh #4 (advisory lock RPC) | ❌ Tidak diambil | Butuh fungsi SQL + migrasi + `.rpc()`; berlebihan untuk konteks saat ini. Dicatat sebagai opsi "perbaikan lengkap". |
| Migrasi baru | ❌ Tidak ada | 0044 sudah ikut di PR ini; kolom bersifat aditif + idempoten. |

---

## 3. Helper bersama yang diperkenalkan

Perbaikan #4 & #5 memperkenalkan modul **client-safe** baru: **`lib/uuid.ts`**.

> ⚠️ **Client-safe:** dipakai oleh dialog `'use client'`, jadi **jangan** meng-import modul
> server-only (mis. `lib/portal/config.ts`, `node:crypto`).

Konteks: `crypto.randomUUID()` adalah API **hanya-secure-context** — `undefined` di HTTP polos
pada origin non-localhost (umum untuk tool internal LAN). Sebaliknya `crypto.getRandomValues()`
**tidak** dibatasi secure-context, sehingga jalan di mana saja. Semua helper menghasilkan string
yang valid untuk `z.uuid()` (nibble versi `4`, varian `8..b`; `z.uuid()` menerima v1–v8 —
diverifikasi via Context7).

```ts
// lib/uuid.ts (client-safe)

/** Format 16 byte menjadi UUID v4-shaped (valid untuk z.uuid()). */
export function uuidFromBytes(bytes: Uint8Array): string {
    const b = bytes.slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x40; // versi 4
    b[8] = (b[8] & 0x3f) | 0x80; // varian 10xx
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUID acak — pakai crypto.randomUUID bila ada, jika tidak fallback getRandomValues (aman di HTTP). */
export function safeRandomUUID(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return uuidFromBytes(bytes);
}

/** UUID deterministik dari string (hash sinkron, non-kripto, tanpa API crypto → jalan di HTTP).
 *  Bukan untuk keamanan — hanya agar dua pilihan handoff-pertama identik bertabrakan di SATU key. */
export function deterministicUuid(seed: string): string {
    return uuidFromBytes(hash128(seed));
}

// cyrb128: digest 128-bit sinkron (4×32-bit) → 16 byte.
function hash128(str: string): Uint8Array {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
        const k = str.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    const out = new Uint8Array(16);
    [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0].forEach((h, i) => {
        out[i * 4] = h & 0xff;
        out[i * 4 + 1] = (h >>> 8) & 0xff;
        out[i * 4 + 2] = (h >>> 16) & 0xff;
        out[i * 4 + 3] = (h >>> 24) & 0xff;
    });
    return out;
}
```

---

## 4. Detail per temuan

### 🔴 [1] Kegagalan simpan `portal_client_id` ditelan → klien Portal ganda — **CONFIRMED**

**Lokasi:** [`app/dashboard/pipeline/actions.ts:100`](../app/dashboard/pipeline/actions.ts) (blok 92–104)

**Akar masalah:** Setelah `postHandoff` sukses (Portal membuat klien C1 + proposal), `UPDATE`
yang menyimpan `portal_client_id` hanya di-`console.error` bila gagal, lalu action tetap
mengembalikan `{ ok: true }`.

**Skenario gagal:** UPDATE gagal (error DB transien / RLS) → lead tetap `portal_client_id = null`.
Handoff berikutnya untuk lead yang sama menampilkan picker lagi (`alreadyLinked = false`); bila
operator memilih "Buat klien baru", **klien Portal DUPLIKAT terbuat** — melanggar kriteria terima
*"Handoff kedua lead sama … tanpa klien ganda"*.

**Perbaikan yang diusulkan:**
1. **Retry UPDATE sekali** saat gagal.
2. Bila masih gagal: **jangan** kembalikan `ok` polos. Perluas union sukses `HandoffResult`
   (actions.ts:18-20) dengan `warning?: string`, tetap sertakan `proposalUrl` (draft tetap bisa
   dibuka), dan tampilkan **peringatan persisten** di dialog: proposal sudah dibuat tetapi tautan
   gagal disimpan — saat membuat proposal lagi untuk lead ini, **pilih klien yang SAMA** (cari
   namanya), jangan buat klien baru.
3. Karena kunci idempotensi stabil per-pilihan, retry oleh pengguna aman-idempoten (Portal dedup →
   klien sama) dan pada akhirnya menautkan ulang.

```ts
// actions.ts — sketsa
type HandoffResult =
    | { ok: true; clientId: string; proposalUrl: string; warning?: string }
    | { ok: false; error: string };

// ...setelah postHandoff sukses:
let updateError = await persistLink(supabase, input.phone, resp);
if (updateError) updateError = await persistLink(supabase, input.phone, resp); // retry 1x
if (updateError) {
    console.error('Handoff sukses tapi gagal simpan portal_client_id:', updateError);
    return {
        ok: true, clientId: resp.clientId, proposalUrl: resp.proposalUrl,
        warning: 'Proposal dibuat, tetapi tautan klien gagal disimpan. Saat membuat proposal ' +
                 'lagi untuk lead ini, pilih klien yang SAMA — jangan buat klien baru.',
    };
}
```

Di [`PortalHandoffDialog.tsx`](../app/dashboard/pipeline/components/PortalHandoffDialog.tsx):
bila `result.warning` ada → `toast.warning(result.warning, { id: toastId, duration: Infinity })`
(atau catatan inline di tampilan sukses) alih-alih `toast.success` biasa; tetap buka proposal.

**Berkas:** `app/dashboard/pipeline/actions.ts`, `app/dashboard/pipeline/components/PortalHandoffDialog.tsx`
(satu-satunya pemanggil `handoffToPortal`; menambah field opsional bersifat backward-compatible).

**Kriteria terima:**
- [ ] UPDATE gagal → di-retry sekali.
- [ ] Gagal 2× → action mengembalikan `ok:true` **dengan** `warning`, dialog menampilkan peringatan persisten.
- [ ] Proposal tetap terbuka pada kasus gagal-simpan.

---

### 🔴 [2] Baca body JSON tanpa timeout — request menggantung selamanya — **CONFIRMED**

**Lokasi:** [`lib/portal/client.ts:78`](../lib/portal/client.ts) (juga `postHandoff` :115)

**Akar masalah:** `fetchWithTimeout` memanggil `clearTimeout(timer)` di blok `finally` **begitu
`fetch()` resolve** (header diterima). Pembacaan body `await res.json()` yang terjadi setelahnya
**tidak lagi tercakup** AbortController.

**Skenario gagal:** Portal mengirim header dalam <15s lalu **macet** saat streaming body (proxy
hiccup / koneksi half-open). `res.json()` tak pernah resolve → `postHandoff()` menggantung tanpa
batas; dialog terkunci `submitting=true`, toast berputar selamanya, dan dialog tak bisa ditutup
(`onOpenChange` di-guard `!submitting`) sampai reload paksa.

**Perbaikan yang diusulkan:** Ganti `AbortController` + `setTimeout` + `clearTimeout(finally)` manual
dengan **`signal: AbortSignal.timeout(TIMEOUT_MS)`** pada `fetch`. Satu signal ini tetap terikat ke
stream body Response, jadi `res.json()` yang macet ikut ter-abort. Perbarui `catch` agar cocok dengan
`err.name === 'TimeoutError' || err.name === 'AbortError'` (⚠️ `AbortSignal.timeout` melempar
`DOMException` bernama **`TimeoutError`**, bukan `AbortError`).

```ts
// lib/portal/client.ts — sketsa
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
            throw new PortalError('Portal tidak merespons (timeout).');
        }
        throw new PortalError(
            `Tidak bisa menghubungi Portal: ${err instanceof Error ? err.message : 'unknown'}`
        );
    }
}
```

> **Catatan:** Anggaran waktu kini mencakup header **+ body** (sebelumnya hanya header). 15s cukup
> untuk respons JSON handoff yang kecil. `AbortSignal.timeout` tersedia di runtime Node Next.js 15
> (Node 18.18+/20). Referensi: [MDN — AbortSignal.timeout()](https://developer.mozilla.org/docs/Web/API/AbortSignal/timeout_static).

**Berkas:** `lib/portal/client.ts`.

**Kriteria terima:**
- [ ] Body yang macet ter-abort dalam ~`TIMEOUT_MS` → `PortalError` timeout, bukan gantung.
- [ ] Timeout header (existing) masih terpetakan ke pesan yang sama.

---

### 🟠 [3] Urutan deploy migrasi 0044 — **PLAUSIBLE** (2 lokasi, akar sama)

**Lokasi:** [`app/api/leads/route.ts:16`](../app/api/leads/route.ts) & [`app/dashboard/pipeline/actions.ts:25`](../app/dashboard/pipeline/actions.ts)

**Akar masalah:** Kedua SELECT merujuk `portal_client_id` / `portal_last_proposal_url`, kolom yang
baru ditambah oleh [`supabase/migrations/0044_whatsapp_chats_portal_client.sql`](../supabase/migrations/0044_whatsapp_chats_portal_client.sql)
di PR ini. Migrasi diterapkan **manual** (Supabase MCP/CLI) dan **terpisah dari deploy app** (CI tidak
pernah menyentuh DB). Bila app rilis lebih dulu:
- `route.ts:16` → `GET /api/leads` balas 500 → `PipelineBoard.fetchLeads` throw → **seluruh papan
  leads/pipeline kosong** (bukan hanya fitur baru).
- `actions.ts:25` → tiap klik "Buat Proposal di Portal" gagal dengan toast menyesatkan *"Lead tidak ditemukan"*.

**Perbaikan yang diusulkan (proses, bukan kode):** Terapkan migrasi 0044 **SEBELUM** deploy kode app.
Tambahkan langkah eksplisit ini ke [`docs/VPS_DEPLOYMENT.md`](./VPS_DEPLOYMENT.md) dan §5 dokumen ini.
Kolom bersifat aditif + idempoten (`add column if not exists`), jadi guard runtime "kolom hilang"
ditolak sebagai *over-engineering*.

**Berkas:** `docs/VPS_DEPLOYMENT.md` (checklist), dokumen ini §5. **Tanpa perubahan kode.**

**Kriteria terima:**
- [ ] Checklist pra-deploy mewajibkan 0044 diterapkan sebelum rilis app.

---

### 🟠 [4] Race handoff-pertama konkuren → klien ganda — **PLAUSIBLE** (pragmatis)

**Lokasi:** [`app/dashboard/pipeline/actions.ts:65`](../app/dashboard/pipeline/actions.ts)

**Akar masalah:** Guard "reuse `portal_client_id`" adalah *check-then-act* tanpa kunci. Dua operator/tab
membuka lead yang belum tertaut; keduanya baca `portal_client_id = null`, keduanya POST dengan kunci
idempotensi berbeda → Portal tak bisa dedup → dua klien.

**Perbaikan yang diusulkan (pragmatis, tanpa migrasi):**
1. Persist andal (#1) + guard reuse yang sudah ada memperkecil jendela race.
2. **Hanya untuk handoff pertama (belum tertaut)**, turunkan kunci idempotensi secara **deterministik**
   dari `phone + mode + clientId|name` via `deterministicUuid()` (§3) — dua tab dengan pilihan **SAMA**
   bertabrakan di satu kunci → Portal dedup → satu klien. **Handoff ulang (sudah tertaut) tetap pakai
   `safeRandomUUID()`** agar bisa membuat banyak draft.

```ts
// PortalHandoffDialog.tsx — sketsa logika idemRef
if (!idemRef.current || idemRef.current.sig !== selectionSig) {
    const key = alreadyLinked
        ? safeRandomUUID()                 // draft ulang → key segar tiap attempt
        : deterministicUuid(selectionSig); // handoff pertama → key deterministik (anti-race)
    idemRef.current = { sig: selectionSig, key };
}
```

> **Sisa risiko (didokumentasi):** dua operator mengetik **nama klien-baru berbeda** untuk lead yang
> sama → tetap 2 klien. Diterima sebagai keterbatasan severity-rendah untuk konteks single-tenant /
> konkurensi rendah. Perbaikan lengkap (advisory lock / dedup sisi-Portal) — lihat §7.

**Berkas:** `app/dashboard/pipeline/components/PortalHandoffDialog.tsx`, `lib/uuid.ts`.

**Kriteria terima:**
- [ ] Dua handoff-pertama dengan pilihan identik → satu klien Portal.
- [ ] Lead sudah-tertaut tetap bisa membuat >1 draft (key tidak deterministik di jalur ini).

---

### 🟠 [5] `crypto.randomUUID()` di luar try + secure-context → no-op senyap via HTTP — **PLAUSIBLE**

**Lokasi:** [`app/dashboard/pipeline/components/PortalHandoffDialog.tsx:172`](../app/dashboard/pipeline/components/PortalHandoffDialog.tsx)

**Akar masalah:** Pemanggilan ada **sebelum** blok `try` (dan sebelum `setSubmitting`/`toast`).
`crypto.randomUUID` hanya tersedia di secure context — `undefined` di HTTP polos pada origin
non-localhost. Lemparannya di luar `try` → tak ada toast, handler async reject tanpa penanganan →
tombol tampak "tak berbuat apa-apa".

**Perbaikan yang diusulkan:** Pakai `safeRandomUUID()` (§3) yang fallback ke `getRandomValues`
(tersedia di non-secure context). Selain itu, **pindahkan pembuatan kunci ke DALAM `try`** sebagai
pertahanan agar kegagalan apa pun memunculkan toast. (Untuk jalur handoff-pertama, kunci dari
`deterministicUuid()` juga tidak butuh crypto.randomUUID — lihat #4.)

**Berkas:** `lib/uuid.ts`, `app/dashboard/pipeline/components/PortalHandoffDialog.tsx`.

**Kriteria terima:**
- [ ] Handoff berhasil via HTTP polos (LAN IP), bukan no-op senyap.
- [ ] Pembuatan kunci berada di dalam `try`.

---

### 🟠 [6] Klien non-UUID bisa dipilih tapi gagal handoff — **PLAUSIBLE**

**Lokasi:** [`lib/portal/client.ts:89`](../lib/portal/client.ts)

**Akar masalah:** `searchPortalClients` menyimpan tiap `id` bertipe string (`typeof r.id === 'string'`),
tetapi `handoffClientSelectionSchema` mensyaratkan `z.uuid()`. Bila Portal mengembalikan id non-UUID
(slug/numeric), ia tampil di picker; saat dipilih & submit, validasi server menolak
(`"Client id tidak valid"`) — klien yang jelas terlihat di picker tak bisa di-handoff.

**Perbaikan yang diusulkan:** Filter hasil `searchPortalClients` ke **id UUID valid saja** (regex UUID
selaras zod: versi `1-8`, varian `89ab`). Ini menyelaraskan picker secara end-to-end — kolom DB
`portal_client_id` bertipe **`uuid`** (migrasi 0044) dan action server mensyaratkan `z.uuid()`, jadi id
non-UUID toh tak akan pernah bisa disimpan.

```ts
// lib/portal/client.ts — sketsa
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
// ...di dalam .map(): 
const id = typeof r.id === 'string' && UUID_RE.test(r.id) ? r.id : null;
```

**Berkas:** `lib/portal/client.ts`.

**Kriteria terima:**
- [ ] Klien dengan id non-UUID tidak muncul di picker.
- [ ] Klien dengan id UUID valid tetap muncul & bisa di-handoff.

---

### 🟡 [7] `window.open` sesudah `await` diblokir popup blocker — **PLAUSIBLE**

**Lokasi:** [`app/dashboard/pipeline/components/PortalHandoffDialog.tsx:194`](../app/dashboard/pipeline/components/PortalHandoffDialog.tsx)

**Akar masalah:** `window.open` berjalan **setelah** `await handoffToPortal(...)`, di luar jendela
aktivasi-pengguna klik asli. Di Safari (dan Chrome bila aktivasi transien kadaluarsa pada handoff
lambat), auto-open tab proposal diblokir.

**Perbaikan yang diusulkan:** Buka tab kosong **sinkron di dalam gesture klik**
(`const w = window.open('', '_blank', 'noopener,noreferrer')`), lalu set `w.location.href = result.proposalUrl`
setelah await; `w?.close()` bila gagal. Tombol fallback "Buka proposal di Portal" di tampilan sukses
tetap dipertahankan sebagai jaring pengaman.

```ts
// PortalHandoffDialog.tsx — sketsa
const w = window.open('', '_blank', 'noopener,noreferrer'); // sinkron, di dalam gesture
try {
    const result = await handoffToPortal({ ... });
    if (!result.ok) throw new Error(result.error);
    // ...sukses...
    if (w) w.location.href = result.proposalUrl; else { /* andalkan tombol fallback */ }
} catch (err) {
    w?.close();
    // ...toast error...
}
```

**Berkas:** `app/dashboard/pipeline/components/PortalHandoffDialog.tsx`.

**Kriteria terima:**
- [ ] Draft proposal terbuka otomatis di Safari setelah handoff sukses.
- [ ] Tab kosong ditutup bila handoff gagal.

---

### 🟡 [8] Query org-scoping mati (dead I/O) — **CONFIRMED** (cleanup)

**Lokasi:** [`app/dashboard/pipeline/actions.ts:48`](../app/dashboard/pipeline/actions.ts)

**Akar masalah:** `getCurrentOrgId(supabase)` memicu round-trip `app_settings`, tetapi `orgId` hanya
dipakai di cek null — query load/update tidak di-scope per-org (filter hanya `phone_number` +
`contact_type`). Jadi ini murni gerbang-auth dengan I/O mati; berbeda dari `orders/actions.ts` yang
memakai `orgId` untuk scoping/insert.

**Perbaikan yang diusulkan:** Ganti dengan gerbang auth langsung `supabase.auth.getUser()`; hapus import
`getCurrentOrgId` yang tak terpakai. Menghilangkan satu round-trip `app_settings` per handoff.

```ts
// actions.ts — sketsa
const { data: { user } } = await supabase.auth.getUser();
if (!user) return { ok: false, error: 'Sesi tidak valid — silakan login ulang.' };
```

**Berkas:** `app/dashboard/pipeline/actions.ts`.

**Kriteria terima:**
- [ ] Tak ada lagi query `app_settings` pada jalur handoff; gerbang auth tetap ada.

---

### 🟡 [9] Interface lead duplikat — **PLAUSIBLE** (cleanup)

**Lokasi:** [`app/dashboard/pipeline/components/PortalHandoffDialog.tsx:30`](../app/dashboard/pipeline/components/PortalHandoffDialog.tsx)

**Akar masalah:** `PortalHandoffLead` mendeklarasikan ulang 9 field `HandoffLead` secara verbatim
(seharusnya `extends`) + 2 field portal, dan mencantumkan 6 field yang tak pernah dibaca dialog
(`email`, `participant_count`, `location_pref`, `event_date_pref`, `event_goals`, `budget_range`).
Bentuk lead kini ada di 4 salinan mirip (`HandoffLead`, `Lead`, `PortalHandoffLead`, `LeadRow`).

**Perbaikan yang diusulkan:** `extends HandoffLead` — impor `type HandoffLead` dari `@/lib/portal/types`
(dialog sudah meng-import dari sana). Menghapus 9 baris duplikat + risiko drift; superset `Lead` di
papan tetap memenuhinya secara struktural.

```ts
// PortalHandoffDialog.tsx — sketsa
import { buildProposalTitle, type PortalClient, type HandoffLead } from '@/lib/portal/types';

export interface PortalHandoffLead extends HandoffLead {
    portal_client_id: string | null;
    portal_last_proposal_url: string | null;
}
```

**Berkas:** `app/dashboard/pipeline/components/PortalHandoffDialog.tsx`.

**Kriteria terima:**
- [ ] `PortalHandoffLead extends HandoffLead`; tak ada field yang dideklarasi ulang.
- [ ] `npm run typecheck` hijau (papan `Lead` tetap kompatibel).

---

## 5. Urutan & prasyarat deploy

> ⚠️ **WAJIB — urutan.** Migrasi 0044 dan kode app terpisah; CI tidak menerapkan migrasi (lihat #3).

1. [ ] Terapkan [`supabase/migrations/0044_whatsapp_chats_portal_client.sql`](../supabase/migrations/0044_whatsapp_chats_portal_client.sql)
   ke DB (Supabase MCP `apply_migration` atau CLI / SQL Editor) — **SEBELUM** deploy app.
2. [ ] Verifikasi kolom ada: `whatsapp_chats.portal_client_id` (uuid) & `portal_last_proposal_url` (text).
3. [ ] Baru deploy kode app.
4. [ ] Tambahkan langkah 1–3 sebagai item permanen di [`docs/VPS_DEPLOYMENT.md`](./VPS_DEPLOYMENT.md).

---

## 6. Rencana pengujian

**Gate otomatis:**
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run test` (Vitest) — 100 lulus
- [x] `npm run build`

**Unit test baru** (Vitest, env `node`, `__tests__/` ko-lokasi, impor eksplisit dari `'vitest'`):
- [x] `lib/__tests__/uuid.test.ts` — `safeRandomUUID()` lolos `handoffInputSchema` (`z.uuid()`);
  `deterministicUuid(s)` **stabil** (sama untuk input sama), **valid** (`z.uuid()`), **berbeda** untuk
  input berbeda **dan berbeda untuk phone lead berbeda** (anti-tabrakan lintas-lead — koreksi #4).
- [x] `lib/portal/__tests__/client.test.ts` (baru) — `vi.stubGlobal('fetch', …)` memastikan
  `searchPortalClients` membuang id non-UUID (#6) **dan** memetakan timeout saat baca body ke
  `PortalError` (#2). (Pola stub-fetch pertama di repo.)

**Verifikasi manual:**
- [ ] Handoff pertama via **HTTPS** dan via **HTTP polos (LAN IP)** → fallback crypto bekerja (#5).
- [ ] Simulasikan gagal-simpan (mis. cabut izin UPDATE sementara) → peringatan tampil + draft tetap terbuka (#1).
- [ ] Picker tak lagi menampilkan klien id non-UUID (#6).
- [ ] Auto-open proposal di Safari setelah handoff (#7).
- [ ] Body respons yang macet → timeout ~15s, dialog bisa ditutup (#2).

---

## 7. Di luar cakupan / sisa risiko terdokumentasi

- **Serialisasi penuh #4** (RPC `pg_advisory_xact_lock(hashtext(phone))` mengelilingi read-check-write)
  — perbaikan "lengkap" untuk race, tetapi butuh fungsi SQL + migrasi + `.rpc()`. **Tidak diambil**
  untuk saat ini.
- **Idempotensi sisi-Portal** berbasis `sourceRef.leadId` — akan menghilangkan race lintas-app, tetapi
  perubahan di aplikasi Portal (di luar repo ini).
- **Race nama-klien-baru berbeda** (#4) — tetap dapat menghasilkan 2 klien; diterima untuk konteks
  single-tenant/konkurensi rendah.

---

## 8. Referensi

- Zod `z.uuid()` menerima UUID v1–v8 (varian `8..b`) — diverifikasi via Context7
  (`/colinhacks/zod`, regex `regexes.ts`). UUID v4 dari helper §3 lolos validasi.
- [MDN — `AbortSignal.timeout()`](https://developer.mozilla.org/docs/Web/API/AbortSignal/timeout_static)
  dan [`Crypto.randomUUID()` (secure context only)](https://developer.mozilla.org/docs/Web/API/Crypto/randomUUID) /
  [`Crypto.getRandomValues()`](https://developer.mozilla.org/docs/Web/API/Crypto/getRandomValues) (tanpa batas secure-context).
- Cetak biru fitur: [phase-2-sarathi-portal-handoff.md](./phase-2-sarathi-portal-handoff.md).
