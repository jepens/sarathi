"use client";

import { useCallback, useEffect, useState } from "react"
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
    ListChecks,
    PanelLeftClose,
    PanelLeftOpen,
    type LucideIcon,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { ModeToggle } from "@/components/mode-toggle"
import { Brand } from "@/components/brand"
import { FollowupBadge } from "@/components/followup-badge"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { unsubscribeFromPushOnLogout } from "@/lib/notifications/push"

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
    { href: "/dashboard/followup", label: "Follow-up", icon: ListChecks },
    { href: "/dashboard/calendar", label: "Calendar", icon: Calendar },
    { href: "/dashboard/reports", label: "Laporan", icon: BarChart3 },
    { href: "/dashboard/chat", label: "AI Chat", icon: MessageSquare },
    { href: "/dashboard/chats", label: "WhatsApp Inbox", icon: MessageCircle, match: "startsWith" },
    { href: "/dashboard/contacts", label: "Contacts", icon: Users, match: "startsWith" },
    { href: "/dashboard/vendors", label: "Vendors", icon: Building2, match: "startsWith" },
    { href: "/dashboard/settings", label: "Settings", icon: Settings },
]

// Persisted like shadcn/ui's sidebar: a cookie so the choice survives reloads and,
// read server-side in the dashboard layout, sets the initial width with no
// collapse/expand flash on load.
const COLLAPSE_COOKIE = "sidebar_collapsed"

function isActive(pathname: string, item: NavItem): boolean {
    return item.match === "startsWith"
        ? pathname.startsWith(item.href)
        : pathname === item.href
}

// Active state is a left "you are here" rail (a 2px --primary bar inset on the
// edge) plus a quiet accent fill — a tab-style marker rather than a filled
// button, shared identically by the rail and the drawer. Collapsed centres the
// icon and drops the gap/padding so it reads as a pure icon rail.
function navItemClasses(active: boolean, collapsed: boolean): string {
    return cn(
        "relative w-full font-normal text-sidebar-foreground/70",
        collapsed ? "justify-center gap-0 px-0" : "justify-start gap-2",
        "hover:bg-sidebar-accent hover:text-sidebar-foreground",
        active &&
            "bg-sidebar-accent font-medium text-sidebar-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-gold before:content-['']"
    )
}

/**
 * The nav body shared by the desktop rail and the mobile drawer.
 * `onNavigate` lets the drawer close itself the moment a link is tapped.
 * `collapsed` renders the icon-only rail; `onToggleCollapse` (desktop only) adds
 * the collapse/expand control. Collapsed items expose their label via `title`.
 */
export function SidebarNav({
    onNavigate,
    collapsed = false,
    onToggleCollapse,
}: {
    onNavigate?: () => void
    collapsed?: boolean
    onToggleCollapse?: () => void
}) {
    const pathname = usePathname()
    const router = useRouter()
    const supabase = createClient()

    const handleLogout = async () => {
        onNavigate?.()
        // Drop this device's Web Push subscription BEFORE signOut (the server
        // call needs the session). Best-effort and time-boxed — never blocks
        // logout.
        await unsubscribeFromPushOnLogout()
        await supabase.auth.signOut()
        router.push("/login")
        router.refresh()
    }

    return (
        <div className="flex flex-1 flex-col justify-between overflow-y-auto">
            <div className="space-y-4 py-4">
                <div className={cn("py-2", collapsed ? "px-2" : "px-3")}>
                    <div
                        className={cn(
                            "mb-3 flex items-center",
                            collapsed ? "flex-col gap-2" : "gap-1 px-4"
                        )}
                    >
                        <Brand collapsed={collapsed} />
                        {onToggleCollapse && (
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={collapsed ? "Lebarkan menu" : "Ciutkan menu"}
                                title={collapsed ? "Lebarkan menu (Ctrl/⌘ B)" : "Ciutkan menu (Ctrl/⌘ B)"}
                                onClick={onToggleCollapse}
                                className={cn(
                                    "size-8 shrink-0 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                                    !collapsed && "ml-auto"
                                )}
                            >
                                {collapsed ? (
                                    <PanelLeftOpen className="size-4" />
                                ) : (
                                    <PanelLeftClose className="size-4" />
                                )}
                            </Button>
                        )}
                    </div>
                    <nav className="space-y-1">
                        {NAV_ITEMS.map((item) => {
                            const Icon = item.icon
                            return (
                                <Button
                                    key={item.href}
                                    asChild
                                    variant="ghost"
                                    title={collapsed ? item.label : undefined}
                                    className={navItemClasses(isActive(pathname, item), collapsed)}
                                >
                                    <Link href={item.href} onClick={onNavigate}>
                                        <Icon className="size-4 shrink-0" />
                                        {!collapsed && item.label}
                                        {item.href === "/dashboard/followup" && (
                                            <FollowupBadge collapsed={collapsed} />
                                        )}
                                    </Link>
                                </Button>
                            )
                        })}
                        {process.env.NODE_ENV === "development" && (
                            <Button
                                asChild
                                variant="ghost"
                                title={collapsed ? "Debug Chats" : undefined}
                                className={cn(
                                    navItemClasses(pathname === "/dashboard/debug-chats", collapsed),
                                    "text-orange-500/80 hover:text-orange-500 dark:text-orange-400/80 dark:hover:text-orange-400"
                                )}
                            >
                                <Link href="/dashboard/debug-chats" onClick={onNavigate}>
                                    <Bug className="size-4 shrink-0" />
                                    {!collapsed && "Debug Chats"}
                                </Link>
                            </Button>
                        )}
                    </nav>
                </div>
            </div>
            <div
                className={cn(
                    "space-y-1 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
                    collapsed ? "px-2" : "px-3"
                )}
            >
                {collapsed ? (
                    <div className="flex justify-center">
                        <NotificationBell variant="icon" />
                    </div>
                ) : (
                    <NotificationBell variant="row" />
                )}
                <ModeToggle collapsed={collapsed} />
                <Button
                    variant="ghost"
                    title={collapsed ? "Logout" : undefined}
                    className={cn(
                        "w-full gap-2 text-red-500 hover:bg-red-500/10 hover:text-red-600 dark:hover:bg-red-950/40",
                        collapsed ? "justify-center px-0" : "justify-start"
                    )}
                    onClick={handleLogout}
                >
                    <LogOut className="size-4 shrink-0" />
                    {!collapsed && "Logout"}
                </Button>
            </div>
        </div>
    )
}

type SidebarProps = React.HTMLAttributes<HTMLDivElement> & {
    /** Initial collapsed state, read from the cookie server-side (avoids a flash). */
    defaultCollapsed?: boolean
}

/**
 * Desktop rail. Hidden below md, where <MobileNav /> takes over with a drawer.
 * Collapses to an icon-only rail (WhatsApp-Web style); the choice persists via a
 * cookie and toggles with the control in the header or Cmd/Ctrl+B.
 */
export function Sidebar({ className, defaultCollapsed = false }: SidebarProps) {
    const [collapsed, setCollapsed] = useState(defaultCollapsed)

    const toggle = useCallback(() => {
        setCollapsed((c) => {
            const next = !c
            document.cookie = `${COLLAPSE_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; SameSite=Lax`
            return next
        })
    }, [])

    // Cmd/Ctrl+B toggles the rail — same shortcut shadcn/ui's sidebar uses. The
    // setState lives in a keydown handler (not the effect body), so it stays clear
    // of the repo's no-setState-in-effect rule.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                toggle()
            }
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [toggle])

    return (
        <aside
            className={cn(
                "hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-in-out md:flex md:min-h-dvh",
                collapsed ? "w-16" : "w-64",
                className
            )}
        >
            <SidebarNav collapsed={collapsed} onToggleCollapse={toggle} />
        </aside>
    )
}
