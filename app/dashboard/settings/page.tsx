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
import { QuickRepliesEditor } from "./components/QuickRepliesEditor";
import { resolvePublicOrigin } from "@/lib/utils/public-url";
import { headers } from "next/headers";

export default async function SettingsPage() {
    // Fetch all settings
    const supabase = await createClient();
    const orgId = await getCurrentOrgId(supabase);

    // Callback URL + Verify Token are platform-global (the webhook routes by
    // phone_number_id). Resolve them platform-wide so every tenant — not just the
    // platform owner whose org owns the app_settings row — sees the real values:
    // the URL from the request host, the verify token via a service-role client.
    const origin = resolvePublicOrigin(await headers());
    const svc = await createServiceOrServerClient();
    const webhookUrl = origin
        ? `${origin}/api/webhook/whatsapp`
        : await getWebhookUrl(svc);
    const verifyToken = await getVerifyToken(svc);

    const businessProfile = orgId
        ? await getBusinessProfile(supabase, orgId)
        : { ...GENERIC_BUSINESS_PROFILE };
    // Single-tenant: WhatsApp credentials live in server env, not the DB.
    const waEnvConfigured =
        !!process.env.WHATSAPP_PHONE_NUMBER_ID && !!process.env.WHATSAPP_ACCESS_TOKEN;

    return (
        <div className="space-y-4 sm:space-y-6">
            <div>
                <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Settings</h2>
                <p className="text-muted-foreground">Manage your application settings.</p>
            </div>

            {/* Knowledge Coverage Summary */}
            <KnowledgeCoverageSummary />

            <SettingsTabs
                businessProfileTab={<BusinessProfileEditor initial={businessProfile} />}
                whatsappTab={
                    <div className="space-y-6">
                        <WhatsAppCredentials envConfigured={waEnvConfigured} />
                        <WebhookSettings
                            webhookUrl={webhookUrl}
                            verifyToken={verifyToken}
                        />
                    </div>
                }
                quickRepliesTab={<QuickRepliesEditor />}
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
