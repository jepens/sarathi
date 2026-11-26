import { SettingsTabs } from "./components/SettingsTabs";
import { SystemMessageEditor } from "./components/SystemMessageEditor";
import { TestChatPreview } from "./components/TestChatPreview";
import { KnowledgeCoverageSummary } from "./components/KnowledgeCoverageSummary";
import { BusinessProfileEditor } from "./components/BusinessProfileEditor";
import { GENERIC_BUSINESS_PROFILE, getBusinessProfile } from "@/lib/settings/business-profile";
import { isDefaultOrg, requireOrgContext } from "@/lib/settings/org-context";
import { orgWhatsAppConnected } from "@/lib/whatsapp/credentials";
import { WhatsAppCredentials } from "./components/WhatsAppCredentials";
import { QuickRepliesEditor } from "./components/QuickRepliesEditor";
import { LabelsEditor } from "./components/LabelsEditor";
import { ThemeSettings } from "./components/ThemeSettings";

export default async function SettingsPage() {
    // Same cached org context the dashboard layout resolved (one lookup per
    // render). Non-members still see the page, with generic defaults.
    const access = await requireOrgContext();
    const orgId = access.ok ? access.orgId : null;

    // The Sailendra-only meeting settings (D26).
    const isDefault = await isDefaultOrg(orgId);

    const businessProfile = access.ok
        ? await getBusinessProfile(access.supabase, access.orgId)
        : { ...GENERIC_BUSINESS_PROFILE };
    // Every org's WhatsApp number is set up by the Sarathi team (Vault, 2.2d):
    // the page shows only whether it is active, never a URL or a token.
    const waConnected = orgId ? await orgWhatsAppConnected(orgId) : false;

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
                    <WhatsAppCredentials connected={waConnected} />
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
                systemMessageTab={<SystemMessageEditor profile={businessProfile} meetings={isDefault} />}
            />

            {/* Test Chat Preview */}
            <TestChatPreview />
        </div>
    );
}
