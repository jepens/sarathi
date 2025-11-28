async function testWebhookPost() {
    const ngrokUrl = 'https://a4805ae31542.ngrok-free.app';

    const payload = {
        object: 'whatsapp_business_account',
        entry: [{
            changes: [{
                value: {
                    messages: [{
                        from: '6281234567890',
                        type: 'text',
                        text: {
                            body: 'Test message from manual script'
                        }
                    }]
                }
            }]
        }]
    };

    console.log('\n🧪 Testing POST to webhook...\n');
    console.log('URL:', `${ngrokUrl}/api/webhook/whatsapp`);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    try {
        const response = await fetch(`${ngrokUrl}/api/webhook/whatsapp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const text = await response.text();

        console.log('\n✅ Response received:');
        console.log('Status:', response.status);
        console.log('Body:', text);

        if (response.status === 200) {
            console.log('\n✅ Webhook POST endpoint is working!');
            console.log('Check ngrok interface to see the request details.');
        } else {
            console.log('\n❌ Unexpected response status');
        }

    } catch (error) {
        console.error('\n❌ Error:', error.message);
    }
}

testWebhookPost();
