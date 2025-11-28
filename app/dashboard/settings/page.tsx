import { WebhookSettings } from "./components/WebhookSettings";
import { getWebhookUrl, getVerifyToken } from "@/lib/settings/app-settings";
import { SystemMessageEditor } from "./components/SystemMessageEditor";

export default async function SettingsPage() {
    const isWhatsAppConfigured =
        !!process.env.WHATSAPP_ACCESS_TOKEN &&
        !!process.env.WHATSAPP_PHONE_NUMBER_ID;

    const webhookUrl = await getWebhookUrl();
    const verifyToken = await getVerifyToken();

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
                <p className="text-muted-foreground">Manage your application settings.</p>
            </div>

            {/* WhatsApp Integration */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <WebhookSettings
                    initialWebhookUrl={webhookUrl}
                    initialVerifyToken={verifyToken}
                    isConfigured={isWhatsAppConfigured}
                />
            </div>

            {/* AI System Message */}
            <SystemMessageEditor />
        </div>
    );
}
