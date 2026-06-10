import { WebhookSettings } from "./components/WebhookSettings";
import { SettingsTabs } from "./components/SettingsTabs";
import {
    getWebhookUrl,
    getVerifyToken,
} from "@/lib/settings/app-settings";
import { SystemMessageEditor } from "./components/SystemMessageEditor";
import { TestChatPreview } from "./components/TestChatPreview";
import { KnowledgeCoverageSummary } from "./components/KnowledgeCoverageSummary";
import { BusinessProfileEditor } from "./components/BusinessProfileEditor";
import { GENERIC_BUSINESS_PROFILE, getBusinessProfile } from "@/lib/settings/business-profile";
import { getCurrentOrgId } from "@/lib/settings/org-context";
import { createClient } from "@/lib/supabase/server";
import { createServiceOrServerClient } from "@/lib/supabase/service";
import { WhatsAppCredentials } from "./components/WhatsAppCredentials";
import { getMyWhatsAppIntegration } from "@/lib/whatsapp/integration";
import { headers } from "next/headers";

export default async function SettingsPage() {
    // Fetch all settings
    const supabase = await createClient();
    const orgId = await getCurrentOrgId(supabase);

    // Callback URL + Verify Token are platform-global (the webhook routes by
    // phone_number_id). Resolve them platform-wide so every tenant — not just the
    // platform owner whose org owns the app_settings row — sees the real values:
    // the URL from the request host, the verify token via a service-role client.
    const h = await headers();
    const host = h.get("host");
    const proto = h.get("x-forwarded-proto") ?? "https";
    const svc = await createServiceOrServerClient();
    const webhookUrl = host
        ? `${proto}://${host}/api/webhook/whatsapp`
        : await getWebhookUrl(svc);
    const verifyToken = await getVerifyToken(svc);

    const businessProfile = orgId
        ? await getBusinessProfile(supabase, orgId)
        : { ...GENERIC_BUSINESS_PROFILE };
    const waIntegration = await getMyWhatsAppIntegration();

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
                <p className="text-muted-foreground">Manage your application settings.</p>
            </div>

            {/* Knowledge Coverage Summary */}
            <KnowledgeCoverageSummary />

            <SettingsTabs
                businessProfileTab={<BusinessProfileEditor initial={businessProfile} />}
                whatsappTab={
                    <div className="space-y-6">
                        <WhatsAppCredentials initial={waIntegration} />
                        <WebhookSettings
                            webhookUrl={webhookUrl}
                            verifyToken={verifyToken}
                        />
                    </div>
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
