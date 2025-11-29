import { WebhookSettings } from "./components/WebhookSettings";
import { AISettings } from "./components/AISettings";
import { ShippingSettings } from "./components/ShippingSettings";
import { SettingsTabs } from "./components/SettingsTabs";
import {
    getWebhookUrl,
    getVerifyToken,
    getWhatsAppAccessToken,
    getWhatsAppPhoneNumberId,
    getWhatsAppAppSecret,
    getOpenAIApiKey,
    getShippingApiKey,
    isWhatsAppConfigured,
    isAIConfigured
} from "@/lib/settings/app-settings";
import { SystemMessageEditor } from "./components/SystemMessageEditor";

export default async function SettingsPage() {
    // Fetch all settings
    const webhookUrl = await getWebhookUrl();
    const verifyToken = await getVerifyToken();

    // WhatsApp settings with fallback to empty string
    let accessToken = '';
    let phoneNumberId = '';
    let appSecret = '';

    try {
        accessToken = await getWhatsAppAccessToken();
    } catch {
        // Not configured yet
    }

    try {
        phoneNumberId = await getWhatsAppPhoneNumberId();
    } catch {
        // Not configured yet
    }

    appSecret = (await getWhatsAppAppSecret()) || '';

    // AI settings with fallback
    let openAIKey = '';
    try {
        openAIKey = await getOpenAIApiKey();
    } catch {
        // Not configured yet
    }

    // Shipping settings (optional)
    const shippingKey = (await getShippingApiKey()) || '';

    // Check configuration status
    const whatsappConfigured = await isWhatsAppConfigured();
    const aiConfigured = await isAIConfigured();
    const shippingConfigured = !!shippingKey;

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
                <p className="text-muted-foreground">Manage your application settings.</p>
            </div>

            <SettingsTabs
                whatsappTab={
                    <WebhookSettings
                        initialWebhookUrl={webhookUrl}
                        initialVerifyToken={verifyToken}
                        initialAccessToken={accessToken}
                        initialPhoneNumberId={phoneNumberId}
                        initialAppSecret={appSecret}
                        isConfigured={whatsappConfigured}
                    />
                }
                aiTab={
                    <AISettings
                        initialOpenAIKey={openAIKey}
                        isConfigured={aiConfigured}
                    />
                }
                shippingTab={
                    <ShippingSettings
                        initialShippingKey={shippingKey}
                        isConfigured={shippingConfigured}
                    />
                }
                systemMessageTab={<SystemMessageEditor />}
            />
        </div>
    );
}
