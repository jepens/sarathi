# Panduan Update Webhook Nindra untuk Forward Status ke Mudik

**Tanggal:** 2026-01-27  
**Tujuan:** Meng-update webhook Nindra untuk forward delivery status callbacks ke Mudik  
**Project Terkait:** sahabat-umkm (Nindra), mudik-antigravity

---

## 📋 Ringkasan

Karena Nindra dan Mudik menggunakan **satu Meta App yang sama** dengan **phone number berbeda**, Meta hanya mengizinkan **satu webhook URL**. Oleh karena itu, webhook Nindra perlu di-update untuk:

1. Menerima status callbacks (sent, delivered, read, failed) dari Meta
2. Memeriksa `phone_number_id` untuk menentukan tujuan
3. Forward ke Mudik jika callback berasal dari nomor Mudik

---

## 🔍 Langkah 1: Cek Apakah Nindra Sudah Handle Status Callbacks

### Cara Mengecek

Buka file: `app/api/webhook/whatsapp/route.ts`

Cari kode yang menangani `statuses` array:

```typescript
// Cari apakah ada handler untuk statuses
const statuses = body.entry?.[0]?.changes?.[0]?.value?.statuses;
```

### Berdasarkan Kode Saat Ini

Dari kode webhook Nindra yang diberikan, **BELUM ADA handler untuk status callbacks**. 

Kode saat ini hanya menangani:
```typescript
// Hanya handle messages, BUKAN statuses
if (body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
    const message = body.entry[0].changes[0].value.messages[0];
    // ...
}
```

**Kesimpulan:** Perlu menambahkan handler untuk `statuses`.

---

## 📝 Langkah 2: Konfigurasi Routing

Tambahkan konstanta untuk routing di bagian atas file atau di file config terpisah:

```typescript
// Routing Configuration - Tambahkan di awal file atau di config terpisah
const ROUTING_CONFIG = {
    mudik: {
        phone_number_id: '94146140571942',
        webhook_url: 'https://mudik.buildwithabdul.com/api/webhook/whatsapp'
    }
    // Tambahkan app lain di sini jika diperlukan
};
```

---

## 🔧 Langkah 3: Update Kode Webhook

### Lokasi File
`D:\bedul\apk\AI\sahabat-umkm\app\api\webhook\whatsapp\route.ts`

### Kode yang Perlu Ditambahkan

Tambahkan kode berikut **SEBELUM** handler untuk messages (sekitar baris 61):

```typescript
export async function POST(request: Request) {
    try {
        // ... existing signature verification code ...

        const body = JSON.parse(rawBody);

        // Enhanced logging
        whatsappLogger.info('Webhook received:', JSON.stringify(body, null, 2));

        // Initialize Supabase client
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        if (body.object === 'whatsapp_business_account') {
            
            // ========== TAMBAHAN BARU: ROUTING CONFIG ==========
            const MUDIK_PHONE_NUMBER_ID = '94146140571942';
            const MUDIK_WEBHOOK_URL = 'https://mudik.buildwithabdul.com/api/webhook/whatsapp';
            
            // Ambil metadata untuk routing
            const metadata = body.entry?.[0]?.changes?.[0]?.value?.metadata;
            const phoneNumberId = metadata?.phone_number_id;
            
            whatsappLogger.info(`Webhook from phone_number_id: ${phoneNumberId}`);

            // ========== TAMBAHAN BARU: HANDLE STATUS CALLBACKS ==========
            const statuses = body.entry?.[0]?.changes?.[0]?.value?.statuses;
            
            if (statuses && statuses.length > 0) {
                // Ini adalah STATUS callback (sent/delivered/read/failed)
                whatsappLogger.info(`Status callback received: ${statuses[0].status} for ${statuses[0].id}`);
                
                if (phoneNumberId === MUDIK_PHONE_NUMBER_ID) {
                    // Forward ke Mudik webhook
                    try {
                        const forwardResponse = await fetch(MUDIK_WEBHOOK_URL, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'X-Forwarded-From': 'nindra'
                            },
                            body: JSON.stringify(body)
                        });
                        
                        if (forwardResponse.ok) {
                            whatsappLogger.info(`Status forwarded to Mudik successfully`);
                        } else {
                            whatsappLogger.error(`Failed to forward to Mudik: ${forwardResponse.status}`);
                        }
                    } catch (err) {
                        whatsappLogger.error('Error forwarding to Mudik:', err);
                    }
                } else {
                    // Process locally for Nindra (optional - jika Nindra butuh tracking)
                    whatsappLogger.info('Status callback for Nindra - not implemented yet');
                }
                
                // Always return 200 to Meta
                return new NextResponse('EVENT_RECEIVED', { status: 200 });
            }
            // ========== END TAMBAHAN BARU ==========

            // ========== TAMBAHAN BARU: FORWARD MESSAGES DARI MUDIK ==========
            if (phoneNumberId === MUDIK_PHONE_NUMBER_ID) {
                // Forward incoming messages ke Mudik juga (jika Mudik butuh)
                // Untuk saat ini, Mudik tidak butuh incoming messages, jadi skip
                whatsappLogger.info('Message from Mudik number - ignoring (Mudik is outbound only)');
                return new NextResponse('EVENT_RECEIVED', { status: 200 });
            }
            // ========== END TAMBAHAN ==========

            // ... existing message handling code for Nindra ...
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
                // ... existing Nindra message handling ...
            }
        }

        // ... rest of existing code ...
    } catch (error) {
        whatsappLogger.error('Error processing webhook', error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
```

---

## 📊 Langkah 4: Testing

### Test Status Forwarding

1. **Kirim notifikasi dari Mudik** (approve/reject registration)
2. **Cek logs di Nindra** - harus ada log: `Status forwarded to Mudik successfully`
3. **Cek database Mudik** - tabel `notification_queue` harus terupdate:
   - `delivery_status`: sent → delivered → read
   - `delivered_at`: timestamp
   - `read_at`: timestamp

### Verifikasi di Meta Webhook Logs

1. Buka Meta Business Suite → WhatsApp → Configuration
2. Klik "Webhook" → "Test"
3. Pastikan webhook merespons 200 untuk semua event types

---

## 🚨 Troubleshooting

### Status tidak ter-forward

Cek:
1. `phone_number_id` sudah benar (`94146140571942`)
2. URL Mudik accessible dari server Nindra
3. Firewall tidak memblokir request

### Error di Mudik saat menerima forward

Cek:
1. Mudik webhook handler bisa menerima request tanpa signature verification (karena forward)
2. Database migration `043_whatsapp_delivery_tracking` sudah dijalankan

---

## 📁 File Reference

| Project | File | Deskripsi |
|---------|------|-----------|
| sahabat-umkm | `app/api/webhook/whatsapp/route.ts` | Webhook utama yang perlu diupdate |
| mudik-antigravity | `src/app/api/webhook/whatsapp/route.ts` | Webhook Mudik yang menerima forward |
| mudik-antigravity | `supabase/migrations/043_whatsapp_delivery_tracking.sql` | Migration untuk delivery tracking |

---

## ✅ Checklist

- [x] Backup kode webhook Nindra sebelum edit
- [x] Tambahkan routing config
- [x] Tambahkan handler untuk statuses
- [x] Tambahkan forward logic ke Mudik
- [x] Test dengan mengirim notifikasi dari Mudik
- [x] Verifikasi status terupdate di database Mudik

---

**Catatan:** Jika Nindra juga ingin tracking delivery status untuk pesan-pesannya sendiri, kita bisa menambahkan logic serupa untuk menyimpan status ke database Nindra.
