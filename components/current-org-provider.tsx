'use client';

import { createContext, useContext } from 'react';

// The signed-in user's org for client components. The dashboard layout (a server
// component) resolves it ONCE with requireOrgContext() — the same membership-based
// resolver every API route uses — and hands it down here, so browser writes
// stamp exactly the org the server would (no client-side guess, no loading
// state). null = signed in but not a member of any org; writes must refuse.

const CurrentOrgContext = createContext<string | null>(null);

export function CurrentOrgProvider({
    orgId,
    children,
}: {
    orgId: string | null;
    children: React.ReactNode;
}) {
    return <CurrentOrgContext.Provider value={orgId}>{children}</CurrentOrgContext.Provider>;
}

/** The current org id, or null when the user has no org membership. */
export function useCurrentOrgId(): string | null {
    return useContext(CurrentOrgContext);
}
