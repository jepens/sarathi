import { cookies } from "next/headers"
import { Sidebar } from "@/components/sidebar"
import { MobileNav } from "@/components/mobile-nav"
import { NavProgress } from "@/components/nav-progress"
import { NotificationProvider } from "@/components/notifications/notification-provider"

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode
}) {
    // Read the persisted collapse choice server-side so the rail renders at its
    // final width immediately (no collapse/expand flash on load).
    const sidebarCollapsed = (await cookies()).get("sidebar_collapsed")?.value === "1"
    return (
        // Stack on mobile (top bar + content), side-by-side rail + content on md+.
        // min-h-dvh so the shell respects mobile browser chrome. The notification
        // provider wraps the shell so the inbound-message notifier + bell control
        // are live on every dashboard page.
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
    )
}
