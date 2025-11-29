import { WebhookSettings } from "./components/WebhookSettings";
import { SettingsTabs } from "./components/SettingsTabs";
import {
    getWebhookUrl,
    getVerifyToken,
    isWhatsAppConfigured,
} from "@/lib/settings/app-settings";
import { SystemMessageEditor } from "./components/SystemMessageEditor";
import { TestChatPreview } from "./components/TestChatPreview";
import { KnowledgeCoverageSummary } from "./components/KnowledgeCoverageSummary";

export default async function SettingsPage() {
    // Fetch all settings
    const webhookUrl = await getWebhookUrl();
    const verifyToken = await getVerifyToken();

    // Check configuration status
    const whatsappConfigured = await isWhatsAppConfigured();

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
                <p className="text-muted-foreground">Manage your application settings.</p>
            </div>

            {/* Knowledge Coverage Summary */}
            <KnowledgeCoverageSummary />

            <SettingsTabs
                whatsappTab={
                    <WebhookSettings
                        initialWebhookUrl={webhookUrl}
                        initialVerifyToken={verifyToken}
                        isConfigured={whatsappConfigured}
                    />
                }
                aiTab={
                    <div className="p-4 text-center text-muted-foreground">
                        AI configuration is managed via environment variables (.env)
                    </div>
                }
                shippingTab={
                    <div className="p-4 text-center text-muted-foreground">
                        Shipping configuration is managed via environment variables (.env)
                    </div>
                }
                systemMessageTab={<SystemMessageEditor />}
            />

            {/* Test Chat Preview */}
            <TestChatPreview />
        </div>
    );
}
