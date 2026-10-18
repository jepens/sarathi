import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.local manually
const envPath = path.resolve(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["']|["']$/g, ''); // Remove quotes
        env[key] = value;
    }
});

const BASE_URL = 'http://localhost:3000';
const VERIFY_TOKEN = env.WHATSAPP_VERIFY_TOKEN;

async function testWebhookVerification() {
    console.log('\n--- Testing Webhook Verification ---');
    const challenge = '11223344';
    const url = `${BASE_URL}/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${challenge}`;

    try {
        const response = await fetch(url);
        const text = await response.text();

        if (response.status === 200 && text === challenge) {
            console.log('✅ Verification Successful!');
        } else {
            console.error('❌ Verification Failed');
            console.error('Status:', response.status);
            console.error('Response:', text);
        }
    } catch (error) {
        console.error('❌ Error connecting to server:', error.message);
    }
}

async function testIncomingMessage() {
    console.log('\n--- Testing Incoming Message Flow ---');

    // Mock WhatsApp Webhook Payload, signed like Meta signs it (the webhook
    // refuses anything else) and addressed to the app's own number.
    if (!env.WHATSAPP_APP_SECRET || !env.WHATSAPP_PHONE_NUMBER_ID) {
        console.error('❌ WHATSAPP_APP_SECRET and WHATSAPP_PHONE_NUMBER_ID must be set in .env.local');
        return;
    }
    const payload = {
        object: 'whatsapp_business_account',
        entry: [{
            changes: [{
                field: 'messages',
                value: {
                    metadata: { phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID },
                    messages: [{
                        id: `wamid.local-test-${Date.now()}`,
                        from: '6281234567890', // Mock number
                        type: 'text',
                        text: {
                            body: 'Halo, apa saja produk yang tersedia?' // Test query
                        }
                    }]
                }
            }]
        }]
    };

    try {
        const raw = JSON.stringify(payload);
        const signature = 'sha256=' + crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex');
        const response = await fetch(`${BASE_URL}/api/webhook/whatsapp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Hub-Signature-256': signature
            },
            body: raw
        });

        if (response.status === 200) {
            console.log('✅ Webhook received message successfully!');
            console.log('Check your server terminal logs to see if AI processed it and tried to reply.');
        } else {
            console.error('❌ Webhook failed to process message');
            console.error('Status:', response.status);
        }
    } catch (error) {
        console.error('❌ Error connecting to server:', error.message);
    }
}

async function runTests() {
    if (!VERIFY_TOKEN) {
        console.error('❌ WHATSAPP_VERIFY_TOKEN not found in .env.local');
        return;
    }

    await testWebhookVerification();
    await testIncomingMessage();
}

runTests();
