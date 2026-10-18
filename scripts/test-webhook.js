#!/usr/bin/env node

/**
 * Script untuk test webhook WhatsApp secara manual
 * Mensimulasikan pesan dari WhatsApp API ke webhook lokal.
 *
 * Webhook hanya menerima kiriman bertanda tangan (X-Hub-Signature-256, HMAC
 * dengan WHATSAPP_APP_SECRET) untuk nomor WHATSAPP_PHONE_NUMBER_ID, jadi
 * jalankan dengan env aplikasi:
 *   node --env-file=.env.local scripts/test-webhook.js
 */

const crypto = require('crypto');

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/api/webhook/whatsapp';
// Signed with the real app secret, this script injects a message any webhook
// accepts, so it only talks to this machine unless --allow-remote is given.
const ALLOW_REMOTE = process.argv.includes('--allow-remote');
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const TEST_PHONE = process.env.TEST_PHONE || '6281234567890';

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
    console.log(`📱 Test Phone: ${TEST_PHONE}\n`);

    const host = new URL(WEBHOOK_URL).hostname;
    if (!ALLOW_REMOTE && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
        console.error(`❌ ${host} is not this machine. A signed test message would really be stored (and answered) there.`);
        console.error('   Pass --allow-remote only if that is what you want.');
        return;
    }
    if (!APP_SECRET || !PHONE_NUMBER_ID) {
        console.error('❌ WHATSAPP_APP_SECRET dan WHATSAPP_PHONE_NUMBER_ID wajib ada.');
        console.error('   Jalankan: node --env-file=.env.local scripts/test-webhook.js');
        return;
    }
    const raw = JSON.stringify(webhookPayload);
    const signature = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');

    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Hub-Signature-256': signature,
            },
            body: raw
        });

        console.log(`✅ Response Status: ${response.status} ${response.statusText}`);

        const responseText = await response.text();
        console.log(`📄 Response Body: ${responseText}\n`);

        if (response.ok) {
            console.log('✅ Webhook test SUCCESSFUL!');
            console.log('\n📋 Next Steps:');
            console.log('1. Check terminal logs for webhook processing');
            console.log('2. Open http://localhost:3000/dashboard/debug-chats');
            console.log(`3. Look for phone number: ${TEST_PHONE}`);
            console.log('4. Verify message: "Test message from script"');
        } else {
            console.log('❌ Webhook test FAILED!');
            console.log('\n🔍 Troubleshooting:');
            console.log('1. Make sure app is running (npm run dev)');
            console.log('2. Check if webhook URL is correct');
            console.log('3. Check terminal for error messages');
        }

    } catch (error) {
        console.error('❌ Error testing webhook:', error.message);
        console.log('\n🔍 Troubleshooting:');
        console.log('1. Make sure app is running (npm run dev)');
        console.log('2. Check if webhook URL is accessible');
        console.log(`3. Try: curl ${WEBHOOK_URL}`);
    }
}

// Run test
testWebhook();
