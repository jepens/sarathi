#!/usr/bin/env node

/**
 * Script untuk test webhook WhatsApp secara manual
 * Mensimulasikan pesan dari WhatsApp API ke webhook lokal.
 *
 * Webhook hanya menerima kiriman bertanda tangan (X-Hub-Signature-256, HMAC
 * dengan WHATSAPP_APP_SECRET) untuk nomor WHATSAPP_PHONE_NUMBER_ID, jadi
 * jalankan dengan env aplikasi:
 *   TEST_PHONE=<nomor milik Anda> node --env-file=.env.local scripts/test-webhook.js
 *
 * Server yang dituju memakai kredensialnya sendiri: pesan uji tersimpan di
 * database server itu, dan AI-nya benar-benar mencoba membalas TEST_PHONE dari
 * nomor WhatsApp server itu. Karena itu TEST_PHONE wajib diisi dengan nomor
 * milik Anda. Keluar dengan kode 1 bila ditolak atau gagal.
 *
 * --repeat=2 mengirim byte bertanda tangan yang sama dua kali, seperti Meta
 * yang mengirim ulang: hasil yang benar = satu pesan tersimpan dan satu
 * balasan (kiriman kedua dikenali sebagai duplikat).
 */

const crypto = require('crypto');

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/api/webhook/whatsapp';
// Signed with the real app secret, this script injects a message any webhook
// accepts, so it only talks to this machine unless --allow-remote is given.
const ALLOW_REMOTE = process.argv.includes('--allow-remote');
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const TEST_PHONE = process.env.TEST_PHONE || '';
// --repeat=N: the same signed bytes N times (1-5), as Meta resends a delivery.
const REPEAT_ARG = process.argv.find((a) => a.startsWith('--repeat='));
const REPEAT = REPEAT_ARG ? Number(REPEAT_ARG.slice('--repeat='.length)) : 1;

// Simulasi payload dari WhatsApp API
const webhookPayload = {
    object: 'whatsapp_business_account',
    entry: [
        {
            id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
            changes: [
                {
                    value: {
                        messaging_product: 'whatsapp',
                        metadata: {
                            display_phone_number: '15550000000',
                            phone_number_id: PHONE_NUMBER_ID
                        },
                        contacts: [
                            {
                                profile: {
                                    name: 'Test User'
                                },
                                wa_id: TEST_PHONE
                            }
                        ],
                        messages: [
                            {
                                from: TEST_PHONE,
                                id: `wamid.test-${Date.now()}`,
                                timestamp: Math.floor(Date.now() / 1000).toString(),
                                text: {
                                    body: 'Test message from script'
                                },
                                type: 'text'
                            }
                        ]
                    },
                    field: 'messages'
                }
            ]
        }
    ]
};

async function testWebhook() {
    console.log('🧪 Testing WhatsApp Webhook...\n');
    console.log(`📍 Webhook URL: ${WEBHOOK_URL}`);
    console.log(`📱 Test Phone: ${TEST_PHONE || '(belum diisi)'}\n`);

    const host = new URL(WEBHOOK_URL).hostname;
    if (!ALLOW_REMOTE && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
        console.error(`❌ ${host} is not this machine. A signed test message would really be stored (and answered) there.`);
        console.error('   Pass --allow-remote only if that is what you want.');
        process.exitCode = 1;
        return;
    }
    if (!APP_SECRET || !PHONE_NUMBER_ID) {
        console.error('❌ WHATSAPP_APP_SECRET dan WHATSAPP_PHONE_NUMBER_ID wajib ada.');
        console.error('   Jalankan: TEST_PHONE=<nomor milik Anda> node --env-file=.env.local scripts/test-webhook.js');
        process.exitCode = 1;
        return;
    }
    if (!Number.isInteger(REPEAT) || REPEAT < 1 || REPEAT > 5) {
        console.error('❌ --repeat harus angka 1 sampai 5 (mis. --repeat=2).');
        process.exitCode = 1;
        return;
    }
    if (!/^[0-9]{8,15}$/.test(TEST_PHONE)) {
        console.error('❌ TEST_PHONE wajib diisi dengan nomor milik Anda (angka saja, 8-15 digit, mis. 62812...).');
        console.error('   AI server tujuan benar-benar mencoba membalas nomor itu.');
        process.exitCode = 1;
        return;
    }
    // Signed once: a repeat sends exactly the same bytes (and wamid), as a
    // resend from Meta does.
    const raw = JSON.stringify(webhookPayload);
    const signature = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');

    try {
        let allOk = true;
        for (let attempt = 1; attempt <= REPEAT; attempt++) {
            const response = await fetch(WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Hub-Signature-256': signature,
                },
                body: raw
            });

            const label = REPEAT > 1 ? ` (kiriman ${attempt}/${REPEAT})` : '';
            console.log(`✅ Response Status${label}: ${response.status} ${response.statusText}`);

            const responseText = await response.text();
            console.log(`📄 Response Body: ${responseText}\n`);
            if (!response.ok) allOk = false;
        }

        if (allOk) {
            console.log('✅ Webhook test SUCCESSFUL!');
            console.log('\n📋 Next Steps:');
            console.log('1. Check terminal logs for webhook processing');
            console.log('2. Open http://localhost:3000/dashboard/debug-chats');
            console.log(`3. Look for phone number: ${TEST_PHONE}`);
            console.log('4. Verify message: "Test message from script"');
            if (REPEAT > 1) console.log(`5. Verify it was stored once and answered once (sent ${REPEAT} times)`);
        } else {
            process.exitCode = 1;
            console.log('❌ Webhook test FAILED!');
            console.log('\n🔍 Troubleshooting:');
            console.log('1. Make sure app is running (npm run dev)');
            console.log('2. Check if webhook URL is correct');
            console.log('3. Check terminal for error messages');
        }

    } catch (error) {
        process.exitCode = 1;
        console.error('❌ Error testing webhook:', error.message);
        console.log('\n🔍 Troubleshooting:');
        console.log('1. Make sure app is running (npm run dev)');
        console.log('2. Check if webhook URL is accessible');
        console.log(`3. Try: curl ${WEBHOOK_URL}`);
    }
}

// Run test
testWebhook();
