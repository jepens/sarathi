"use client";

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
    BookOpen,
    Home,
    MessageSquare,
    Settings,
    ShoppingBag,
    MessageCircle,
    LogOut,
    Users,
    ClipboardList,
    Bug,
    Kanban,
    Calendar,
    Building2,
    BarChart3,
    type LucideIcon,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { ModeToggle } from "@/components/mode-toggle"
import { Brand } from "@/components/brand"

type NavItem = {
    href: string
    label: string
    icon: LucideIcon
    // Detail routes (e.g. /dashboard/chats?phone=…) keep the parent active.
    match?: "exact" | "startsWith"
}

// Single source of truth for the nav — consumed by both the desktop rail and the
// mobile drawer so the two can never drift apart.
const NAV_ITEMS: NavItem[] = [
    { href: "/dashboard", label: "Overview", icon: Home },
    { href: "/dashboard/knowledge", label: "Knowledge Base", icon: BookOpen },
    { href: "/dashboard/products", label: "Paket Acara", icon: ShoppingBag },
    { href: "/dashboard/orders", label: "Bookings", icon: ClipboardList },
    { href: "/dashboard/pipeline", label: "Pipeline", icon: Kanban },
    { href: "/dashboard/calendar", label: "Calendar", icon: Calendar },
    { href: "/dashboard/reports", label: "Laporan", icon: BarChart3 },
    { href: "/dashboard/chat", label: "AI Chat", icon: MessageSquare },
    { href: "/dashboard/chats", label: "WhatsApp Inbox", icon: MessageCircle, match: "startsWith" },
    { href: "/dashboard/contacts", label: "Contacts", icon: Users, match: "startsWith" },
    { href: "/dashboard/vendors", label: "Vendors", icon: Building2, match: "startsWith" },
    { href: "/dashboard/settings", label: "Settings", icon: Settings },
]

function isActive(pathname: string, item: NavItem): boolean {
    return item.match === "startsWith"
        ? pathname.startsWith(item.href)
        : pathname === item.href
}

// Active state is a left "you are here" rail (a 2px --primary bar inset on the
// edge) plus a quiet accent fill — a tab-style marker rather than a filled
// button, shared identically by the rail and the drawer.
function navItemClasses(active: boolean): string {
    return cn(
        "relative w-full justify-start gap-2 font-normal text-sidebar-foreground/70",
        "hover:bg-sidebar-accent hover:text-sidebar-foreground",
        active &&
            "bg-sidebar-accent font-medium text-sidebar-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:content-['']"
    )
}

/**
 * The nav body shared by the desktop rail and the mobile drawer.
 * `onNavigate` lets the drawer close itself the moment a link is tapped.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
    const pathname = usePathname()
    const router = useRouter()
    const supabase = createClient()

    const handleLogout = async () => {
        onNavigate?.()
        await supabase.auth.signOut()
        router.push("/login")
        router.refresh()
    }

    return (
        <div className="flex flex-1 flex-col justify-between overflow-y-auto">
            <div className="space-y-4 py-4">
                <div className="px-3 py-2">
                    <div className="mb-3 px-4">
                        <Brand />
                    </div>
                    <nav className="space-y-1">
                        {NAV_ITEMS.map((item) => {
                            const Icon = item.icon
                            return (
                                <Button
                                    key={item.href}
                                    asChild
                                    variant="ghost"
                                    className={navItemClasses(isActive(pathname, item))}
                                >
                                    <Link href={item.href} onClick={onNavigate}>
                                        <Icon className="size-4" />
                                        {item.label}
                                    </Link>
                                </Button>
                            )
                        })}
                        {process.env.NODE_ENV === "development" && (
                            <Button
                                asChild
                                variant="ghost"
                                className={cn(
                                    navItemClasses(pathname === "/dashboard/debug-chats"),
                                    "text-orange-500/80 hover:text-orange-500 dark:text-orange-400/80 dark:hover:text-orange-400"
                                )}
                            >
                                <Link href="/dashboard/debug-chats" onClick={onNavigate}>
                                    <Bug className="size-4" />
                                    Debug Chats
                                </Link>
                            </Button>
                        )}
                    </nav>
                </div>
            </div>
            <div className="space-y-1 px-3 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <ModeToggle />
                <Button
                    variant="ghost"
                    className="w-full justify-start gap-2 text-red-500 hover:bg-red-500/10 hover:text-red-600 dark:hover:bg-red-950/40"
                    onClick={handleLogout}
                >
                    <LogOut className="size-4" />
                    Logout
                </Button>
            </div>
        </div>
    )
}

type SidebarProps = React.HTMLAttributes<HTMLDivElement>

/**
 * Desktop rail. Hidden below md, where <MobileNav /> takes over with a drawer.
 */
export function Sidebar({ className }: SidebarProps) {
    return (
        <aside
            className={cn(
                "hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex md:min-h-dvh",
                className
            )}
        >
            <SidebarNav />
        </aside>
    )
}
