import { cookies } from "next/headers"
import { Sidebar } from "@/components/sidebar"
import { MobileNav } from "@/components/mobile-nav"
import { NavProgress } from "@/components/nav-progress"
import { NotificationProvider } from "@/components/notifications/notification-provider"
import { CurrentOrgProvider } from "@/components/current-org-provider"
import { redirect } from "next/navigation"
import { requireOrgContext } from "@/lib/settings/org-context"

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode
}) {
    // Read the persisted collapse choice server-side so the rail renders at its
    // final width immediately (no collapse/expand flash on load).
    const sidebarCollapsed = (await cookies()).get("sidebar_collapsed")?.value === "1"
    // Defense in depth behind the proxy redirect: no verified session → login.
    // The same cached context (React cache) is reused by pages below, and
    // gives client components that write tenant rows the user's org — the
    // same resolver as the API routes. A signed-in non-member gets orgId null
    // (writes refuse with a clear message).
    const access = await requireOrgContext()
    // Redirect ONLY when there is genuinely no session (401). If the session
    // could not be verified right now (503: Auth unreachable / retryable
    // error) the proxy may still see the user as signed in and bounce /login
    // back here — a redirect loop. Throw instead so Next renders the error
    // page (app/error.tsx — the boundary above this layout — offers a retry).
    if (!access.ok && access.status === 401) redirect("/login")
    if (!access.ok && access.status === 503) throw new Error(access.error)
    const orgId = access.ok ? access.orgId : null
    return (
        // Stack on mobile (top bar + content), side-by-side rail + content on md+.
        // min-h-dvh so the shell respects mobile browser chrome. The notification
        // provider wraps the shell so the inbound-message notifier + bell control
        // are live on every dashboard page.
        <CurrentOrgProvider orgId={orgId}>
            <NotificationProvider>
                <div className="flex min-h-dvh flex-col bg-background md:flex-row">
                    <NavProgress />
                    <Sidebar defaultCollapsed={sidebarCollapsed} />
                    <div className="flex min-w-0 flex-1 flex-col">
                        <MobileNav />
                        <main className="flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-8">
                            {children}
                        </main>
                    </div>
                </div>
            </NotificationProvider>
        </CurrentOrgProvider>
    )
}
