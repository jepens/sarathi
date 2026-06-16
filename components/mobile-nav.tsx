"use client"

import { useState } from "react"
import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { SidebarNav } from "@/components/sidebar"

/**
 * Mobile-only top bar + slide-in nav drawer. Below md the desktop rail is hidden
 * (see <Sidebar />), so this is the only navigation. The drawer reuses the exact
 * same <SidebarNav /> as the rail and closes itself on every route change as a
 * backstop to the per-link onNavigate.
 */
export function MobileNav() {
    const pathname = usePathname()
    const [open, setOpen] = useState(false)

    // Close the drawer when the route changes (e.g. browser back/forward while
    // it's open), without an effect — the repo avoids setState-in-effect. This
    // is React's "adjust state during render" pattern, guarded so it only fires
    // on an actual change.
    const [lastPath, setLastPath] = useState(pathname)
    if (lastPath !== pathname) {
        setLastPath(pathname)
        if (open) setOpen(false)
    }

    return (
        <>
            <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-sidebar-border bg-sidebar/80 px-3 text-sidebar-foreground backdrop-blur supports-[backdrop-filter]:bg-sidebar/70 md:hidden">
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Buka menu navigasi"
                    className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    onClick={() => setOpen(true)}
                >
                    <Menu className="size-5" />
                </Button>
                <span className="text-lg font-semibold tracking-tight">Helat</span>
            </header>

            <Sheet open={open} onOpenChange={setOpen}>
                <SheetContent
                    side="left"
                    showClose
                    aria-describedby={undefined}
                    className="w-[82%] max-w-xs border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
                >
                    <SheetTitle className="sr-only">Navigasi Helat</SheetTitle>
                    <SidebarNav onNavigate={() => setOpen(false)} />
                </SheetContent>
            </Sheet>
        </>
    )
}
