import { getWhatsAppAccessToken, getWhatsAppPhoneNumberId } from '@/lib/settings/app-settings';

const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0';

export async function sendWhatsAppMessage(to: string, text: string) {
    const phoneNumberId = await getWhatsAppPhoneNumberId();
    const accessToken = await getWhatsAppAccessToken();

    if (!phoneNumberId || !accessToken) {
        throw new Error('WhatsApp not configured. Please configure in /dashboard/settings');
    }

    try {
        const response = await fetch(`${WHATSAPP_API_URL}/${phoneNumberId}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: to,
                text: { body: text },
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Error sending WhatsApp message:', JSON.stringify(errorData, null, 2));
            throw new Error(`WhatsApp API Error: ${response.statusText}`);
        }

        const data = await response.json();
        return data;

    } catch (error) {
        console.error('Failed to send WhatsApp message:', error);
        throw error;
    }
}
