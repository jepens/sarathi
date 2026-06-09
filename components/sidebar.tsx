"use client";

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { BookOpen, Home, MessageSquare, Settings, ShoppingBag, MessageCircle, LogOut, Users, ClipboardList, Bug, Kanban, Calendar, Building2 } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"

type SidebarProps = React.HTMLAttributes<HTMLDivElement>

export function Sidebar({ className }: SidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const supabase = createClient();

    const handleLogout = async () => {
        await supabase.auth.signOut();
        router.push("/login");
        router.refresh();
    };

    return (
        <div className={cn("pb-12 w-64 border-r min-h-screen bg-sidebar flex flex-col justify-between", className)}>
            <div className="space-y-4 py-4">
                <div className="px-3 py-2">
                    <h2 className="mb-2 px-4 text-lg font-semibold tracking-tight text-sidebar-foreground">
                        Helat
                    </h2>
                    <div className="space-y-1">
                        <Link href="/dashboard">
                            <Button variant={pathname === "/dashboard" ? "secondary" : "ghost"} className="w-full justify-start">
                                <Home className="mr-2 h-4 w-4" />
                                Overview
                            </Button>
                        </Link>
                        <Link href="/dashboard/knowledge">
                            <Button variant={pathname === "/dashboard/knowledge" ? "secondary" : "ghost"} className="w-full justify-start">
                                <BookOpen className="mr-2 h-4 w-4" />
                                Knowledge Base
                            </Button>
                        </Link>
                        <Link href="/dashboard/products">
                            <Button variant={pathname === "/dashboard/products" ? "secondary" : "ghost"} className="w-full justify-start">
                                <ShoppingBag className="mr-2 h-4 w-4" />
                                Paket Acara
                            </Button>
                        </Link>
                        <Link href="/dashboard/orders">
                            <Button variant={pathname === "/dashboard/orders" ? "secondary" : "ghost"} className="w-full justify-start">
                                <ClipboardList className="mr-2 h-4 w-4" />
                                Bookings
                            </Button>
                        </Link>
                        <Link href="/dashboard/pipeline">
                            <Button variant={pathname === "/dashboard/pipeline" ? "secondary" : "ghost"} className="w-full justify-start">
                                <Kanban className="mr-2 h-4 w-4" />
                                Pipeline
                            </Button>
                        </Link>
                        <Link href="/dashboard/calendar">
                            <Button variant={pathname === "/dashboard/calendar" ? "secondary" : "ghost"} className="w-full justify-start">
                                <Calendar className="mr-2 h-4 w-4" />
                                Calendar
                            </Button>
                        </Link>
                        <Link href="/dashboard/chat">
                            <Button variant={pathname === "/dashboard/chat" ? "secondary" : "ghost"} className="w-full justify-start">
                                <MessageSquare className="mr-2 h-4 w-4" />
                                AI Chat
                            </Button>
                        </Link>
                        <Link href="/dashboard/chats">
                            <Button variant={pathname.startsWith("/dashboard/chats") ? "secondary" : "ghost"} className="w-full justify-start">
                                <MessageCircle className="mr-2 h-4 w-4" />
                                WhatsApp Inbox
                            </Button>
                        </Link>
                        <Link href="/dashboard/contacts">
                            <Button variant={pathname.startsWith("/dashboard/contacts") ? "secondary" : "ghost"} className="w-full justify-start">
                                <Users className="mr-2 h-4 w-4" />
                                Contacts
                            </Button>
                        </Link>
                        <Link href="/dashboard/vendors">
                            <Button variant={pathname.startsWith("/dashboard/vendors") ? "secondary" : "ghost"} className="w-full justify-start">
                                <Building2 className="mr-2 h-4 w-4" />
                                Vendors
                            </Button>
                        </Link>
                        <Link href="/dashboard/settings">
                            <Button variant={pathname === "/dashboard/settings" ? "secondary" : "ghost"} className="w-full justify-start">
                                <Settings className="mr-2 h-4 w-4" />
                                Settings
                            </Button>
                        </Link>
                        {process.env.NODE_ENV === 'development' && (
                            <Link href="/dashboard/debug-chats">
                                <Button variant={pathname === "/dashboard/debug-chats" ? "secondary" : "ghost"} className="w-full justify-start text-orange-600 dark:text-orange-400">
                                    <Bug className="mr-2 h-4 w-4" />
                                    Debug Chats
                                </Button>
                            </Link>
                        )}
                    </div>
                </div>
            </div>
            <div className="px-3 py-4">
                <Button variant="ghost" className="w-full justify-start text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50" onClick={handleLogout}>
                    <LogOut className="mr-2 h-4 w-4" />
                    Logout
                </Button>
            </div>
        </div>
    )
}
