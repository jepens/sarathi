"use client";

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { BookOpen, Home, MessageSquare, Settings, ShoppingBag, MessageCircle, LogOut, Users } from "lucide-react"
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
                        Sahabat UMKM
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
                                Products
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
                                WhatsApp Monitor
                            </Button>
                        </Link>
                        <Link href="/dashboard/contacts">
                            <Button variant={pathname.startsWith("/dashboard/contacts") ? "secondary" : "ghost"} className="w-full justify-start">
                                <Users className="mr-2 h-4 w-4" />
                                Contacts
                            </Button>
                        </Link>
                        <Link href="/dashboard/settings">
                            <Button variant={pathname === "/dashboard/settings" ? "secondary" : "ghost"} className="w-full justify-start">
                                <Settings className="mr-2 h-4 w-4" />
                                Settings
                            </Button>
                        </Link>
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
