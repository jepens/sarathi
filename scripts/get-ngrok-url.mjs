async function getNgrokUrl() {
    try {
        const response = await fetch('http://127.0.0.1:4041/api/tunnels');
        const data = await response.json();

        if (data.tunnels && data.tunnels.length > 0) {
            const tunnel = data.tunnels[0];
            const publicUrl = tunnel.public_url;

            console.log('\n🚀 ngrok Tunnel Information\n');
            console.log('Public URL:', publicUrl);
            console.log('Webhook URL:', `${publicUrl}/api/webhook/whatsapp/<webhook_key>`);
            console.log('\n📋 Next Steps:\n');
            console.log("1. Copy the Webhook URL above, with the app's webhook_key (scripts/wa-provision.mjs)");
            console.log('2. Go to Meta for Developers: https://developers.facebook.com/apps/');
            console.log('3. Navigate to: WhatsApp → Configuration → Webhook');
            console.log('4. Click "Edit" and paste the Webhook URL');
            console.log("5. Enter that app's verify token (set with scripts/wa-provision.mjs)");
            console.log('6. Click "Verify and Save"');
            console.log('7. Subscribe to "messages" webhook field');
            console.log('\n✅ Your server is now publicly accessible!\n');
        } else {
            console.error('❌ No ngrok tunnels found. Make sure ngrok is running.');
        }
    } catch (error) {
        console.error('❌ Error fetching ngrok info:', error.message);
        console.log('\nMake sure ngrok is running with: ngrok http 3000');
    }
}

getNgrokUrl();
