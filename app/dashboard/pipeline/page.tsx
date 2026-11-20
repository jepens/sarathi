import { PipelineBoard } from './components/PipelineBoard';
import { GENERIC_BUSINESS_PROFILE, getBusinessProfile } from '@/lib/settings/business-profile';
import { requireOrgContext } from '@/lib/settings/org-context';

export default async function PipelinePage() {
    // The org's own hand-off contact and name label the hand-off action and
    // the proposal intro, never another business's (F10). Same cached org
    // context the dashboard layout resolved.
    const access = await requireOrgContext();
    const profile = access.ok
        ? await getBusinessProfile(access.supabase, access.orgId)
        : { ...GENERIC_BUSINESS_PROFILE };
    return (
        // Bounded viewport height (main has p-8 → 4rem vertical padding) so the
        // board's flex chain resolves: columns scroll vertically inside their own
        // height and the horizontal scrollbar sits at the bottom of the viewport
        // instead of being pushed off-screen by the tallest column.
        <div className="space-y-6 flex flex-col h-[calc(100dvh-5.5rem)] md:h-[calc(100dvh-4rem)]">
            <div className="flex-shrink-0">
                <h1 className="text-2xl font-bold tracking-tight">Sales Pipeline</h1>
                <p className="text-muted-foreground">
                    Drag lead ke kolom lain untuk update stage-nya. Stage tersimpan otomatis.
                </p>
            </div>
            <div className="flex-1 min-h-0">
                <PipelineBoard handoffName={profile.handoffName} businessName={profile.businessName} />
            </div>
        </div>
    );
}
