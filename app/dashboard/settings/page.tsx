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
import { getCurrentOrgId, isDefaultOrg } from "@/lib/settings/org-context";
import { createClient } from "@/lib/supabase/server";
import { createServiceOrServerClient } from "@/lib/supabase/service";
import { WhatsAppCredentials } from "./components/WhatsAppCredentials";
import { QuickRepliesEditor } from "./components/QuickRepliesEditor";
import { LabelsEditor } from "./components/LabelsEditor";
import { ThemeSettings } from "./components/ThemeSettings";
import { resolvePublicOrigin } from "@/lib/utils/public-url";
import { headers } from "next/headers";

export default async function SettingsPage() {
    // Fetch all settings
    const supabase = await createClient();
    const orgId = await getCurrentOrgId(supabase);

    // The env WhatsApp number, its Meta webhook (Callback URL + Verify Token) and
    // credentials belong to the default org. Other tenants' WhatsApp numbers are
    // set up by the Sarathi team, so they never see the platform webhook values
    // (KEA-27) — only a neutral "managed by the team" note.
    const isDefault = await isDefaultOrg(orgId);

    let webhookUrl: string | null = null;
    let verifyToken: string | null = null;
    if (isDefault) {
        // Resolve platform-wide: the URL from the request host, the verify
        // token via a service-role client.
        const origin = resolvePublicOrigin(await headers());
        const svc = await createServiceOrServerClient();
        webhookUrl = origin
            ? `${origin}/api/webhook/whatsapp`
            : await getWebhookUrl(svc);
        verifyToken = await getVerifyToken(svc);
    }

    const businessProfile = orgId
        ? await getBusinessProfile(supabase, orgId)
        : { ...GENERIC_BUSINESS_PROFILE };
    // WhatsApp credentials live in server env, not the DB — and only the
    // default org uses them.
    const waEnvConfigured =
        isDefault &&
        !!process.env.WHATSAPP_PHONE_NUMBER_ID &&
        !!process.env.WHATSAPP_ACCESS_TOKEN;

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
                        <WhatsAppCredentials
                            envConfigured={waEnvConfigured}
                            managedByTeam={!isDefault}
                        />
                        <WebhookSettings
                            webhookUrl={webhookUrl}
                            verifyToken={verifyToken}
                        />
                    </div>
                }
                quickRepliesTab={<QuickRepliesEditor />}
                labelsTab={<LabelsEditor />}
                appearanceTab={<ThemeSettings />}
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
