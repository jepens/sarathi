async function checkNgrokTraffic() {
    try {
        const response = await fetch('http://127.0.0.1:4041/api/requests/http');
        const data = await response.json();

        console.log('\n📊 ngrok Traffic Analysis\n');
        console.log('Total Requests:', data.requests?.length || 0);

        if (data.requests && data.requests.length > 0) {
            console.log('\n🔍 Recent Requests:\n');

            // Show last 10 requests
            const recentRequests = data.requests.slice(-10).reverse();

            recentRequests.forEach((req, index) => {
                const timestamp = new Date(req.start).toLocaleTimeString();
                const method = req.request.method;
                const path = req.request.uri;
                const status = req.response?.status || 'pending';

                console.log(`${index + 1}. [${timestamp}] ${method} ${path} → ${status}`);

                // Show webhook requests in detail
                if (path.includes('/api/webhook/whatsapp')) {
                    console.log(`   📱 WhatsApp Webhook Request Detected!`);

                    if (req.request.raw) {
                        try {
                            const bodyMatch = req.request.raw.match(/\r\n\r\n(.*)/s);
                            if (bodyMatch && bodyMatch[1]) {
                                const body = JSON.parse(bodyMatch[1]);
                                console.log(`   Body:`, JSON.stringify(body, null, 2));
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }

                    if (req.response?.raw) {
                        console.log(`   Response Status: ${req.response.status}`);
                    }
                }
            });
        } else {
            console.log('❌ No requests found yet.');
            console.log('\nPossible reasons:');
            console.log('1. Webhook not configured correctly in Meta Dashboard');
            console.log('2. WhatsApp message not sent yet');
            console.log('3. ngrok URL changed (restart ngrok if needed)');
        }

        console.log('\n💡 Tip: Open http://127.0.0.1:4041 in your browser for detailed traffic inspection\n');

    } catch (error) {
        console.error('❌ Error fetching ngrok traffic:', error.message);
        console.log('\nMake sure ngrok is running on port 4041');
    }
}

checkNgrokTraffic();
