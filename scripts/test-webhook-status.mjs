/**
 * Test Script: Webhook Status Callback Simulation
 * 
 * Simulates Meta's status callback to test the new routing logic.
 * Usage: node scripts/test-webhook-status.mjs
 */

const WEBHOOK_URL = process.argv[2] || 'http://localhost:3000/api/webhook/whatsapp';

// Mudik phone number ID for routing
const MUDIK_PHONE_NUMBER_ID = '94146140571942';
// Nindra phone number ID (replace with actual if different)
const NINDRA_PHONE_NUMBER_ID = '668003893055590';

/**
 * Create a status callback payload
 */
function createStatusPayload(phoneNumberId, status = 'delivered', messageId = 'wamid.test123') {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: '123456789',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: {
                        display_phone_number: '628123456789',
                        phone_number_id: phoneNumberId
                    },
                    statuses: [{
                        id: messageId,
                        status: status,
                        timestamp: Math.floor(Date.now() / 1000).toString(),
                        recipient_id: '628987654321'
                    }]
                },
                field: 'messages'
            }]
        }]
    };
}

/**
 * Create a message payload (for testing skip logic)
 */
function createMessagePayload(phoneNumberId, from = '628123456789', body = 'Test message') {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: '123456789',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: {
                        display_phone_number: '628123456789',
                        phone_number_id: phoneNumberId
                    },
                    messages: [{
                        from: from,
                        id: 'wamid.test456',
                        timestamp: Math.floor(Date.now() / 1000).toString(),
                        type: 'text',
                        text: {
                            body: body
                        }
                    }]
                },
                field: 'messages'
            }]
        }]
    };
}

/**
 * Send POST request to webhook
 */
async function sendToWebhook(payload, description) {
    console.log(`\n🧪 ${description}`);
    console.log('   Payload:', JSON.stringify(payload, null, 2).split('\n').slice(0, 10).join('\n') + '...');

    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const text = await response.text();
        console.log(`   Status: ${response.status}`);
        console.log(`   Response: ${text}`);

        if (response.status === 200) {
            console.log('   ✅ Success');
            return true;
        } else {
            console.log('   ❌ Unexpected status');
            return false;
        }
    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        return false;
    }
}

/**
 * Run all tests
 */
async function runTests() {
    console.log('='.repeat(60));
    console.log('🚀 Webhook Status Callback Test Suite');
    console.log('='.repeat(60));
    console.log(`Target: ${WEBHOOK_URL}`);
    console.log('');

    const results = [];

    // Test 1: Status callback from Mudik (should forward)
    results.push(await sendToWebhook(
        createStatusPayload(MUDIK_PHONE_NUMBER_ID, 'delivered'),
        'Test 1: Status callback from Mudik (should forward to Mudik webhook)'
    ));

    // Test 2: Status callback from Nindra (should handle locally)
    results.push(await sendToWebhook(
        createStatusPayload(NINDRA_PHONE_NUMBER_ID, 'read'),
        'Test 2: Status callback from Nindra (should handle locally)'
    ));

    // Test 3: Message from Mudik phone (should be ignored)
    results.push(await sendToWebhook(
        createMessagePayload(MUDIK_PHONE_NUMBER_ID, '628999888777', 'Hello from Mudik number'),
        'Test 3: Incoming message to Mudik phone (should be ignored)'
    ));

    // Test 4: Message from Nindra phone (should process normally)
    results.push(await sendToWebhook(
        createMessagePayload(NINDRA_PHONE_NUMBER_ID, '628111222333', 'Hello Nindra'),
        'Test 4: Incoming message to Nindra phone (should process)'
    ));

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Test Summary');
    console.log('='.repeat(60));
    const passed = results.filter(r => r).length;
    console.log(`   Passed: ${passed}/${results.length}`);

    if (passed === results.length) {
        console.log('\n✅ All tests passed!');
        console.log('\n📝 Next steps:');
        console.log('   1. Check server logs for routing messages');
        console.log('   2. Verify Mudik endpoint received forwarded status');
    } else {
        console.log('\n⚠️ Some tests failed. Check server logs for details.');
    }
}

runTests();
