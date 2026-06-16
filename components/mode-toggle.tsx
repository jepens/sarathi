"use client"

import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

// Light / Dark / System switcher. The trigger shows a Sun and Moon stacked and
// toggled purely by the `.dark` class via CSS (no read of the JS theme value in
// render), so it renders identically on the server and the first client paint —
// no hydration mismatch and no setState-in-effect mounted guard (which the repo
// lints against). setTheme runs only from the click handlers.
export function ModeToggle({ className }: { className?: string }) {
    const { setTheme } = useTheme()

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    className={cn(
                        "w-full justify-start gap-2 font-normal text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                        className
                    )}
                >
                    <span className="relative size-4 shrink-0">
                        <Sun className="absolute inset-0 size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                        <Moon className="absolute inset-0 size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                    </span>
                    Tema
                    <span className="sr-only">Ganti tema terang / gelap</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => setTheme("light")}>
                    <Sun className="mr-2 size-4" /> Terang
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}>
                    <Moon className="mr-2 size-4" /> Gelap
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                    <span className="mr-2 flex size-4 items-center justify-center text-xs">⌘</span>
                    Sistem
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
