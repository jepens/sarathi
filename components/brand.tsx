import Image from "next/image"

import { cn } from "@/lib/utils"
import { SarathiMark } from "@/components/sarathi-mark"

// "Sarathi by Sailendra" lockup: the Chakra-dial mark chip + the wordmark with a
// small "by <Sailendra logo>" credit. The white logo shows on the dark sidebar
// and the black one in light mode, swapped purely by the `.dark` class via CSS —
// no JS, no hydration concern. The mark chip stays dark in both themes (an "app
// icon" chip), matching the marketing/auth surfaces. Used by both the desktop
// rail and the mobile top bar. `collapsed` drops the wordmark to just the chip
// for the icon-only rail.
export function Brand({ className, collapsed = false }: { className?: string; collapsed?: boolean }) {
    return (
        <div className={cn("flex items-center gap-2.5", className)}>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-brand-brass/40 bg-brand-surface">
                <SarathiMark className="h-[22px] w-[22px]" />
            </span>
            {!collapsed && (
                <span className="flex flex-col gap-1">
                    <span className="text-lg font-semibold leading-none tracking-tight text-sidebar-foreground">
                        Sarathi
                    </span>
                    <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/50">
                        by
                        <Image
                            src="/sailendra-white.png"
                            alt="Sailendra"
                            width={237}
                            height={64}
                            priority
                            className="hidden h-4 w-auto dark:block"
                        />
                        <Image
                            src="/sailendra-black.png"
                            alt="Sailendra"
                            width={237}
                            height={64}
                            priority
                            className="h-4 w-auto dark:hidden"
                        />
                    </span>
                </span>
            )}
        </div>
    )
}
