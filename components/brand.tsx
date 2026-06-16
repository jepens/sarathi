import Image from "next/image"

import { cn } from "@/lib/utils"

// "Helat" wordmark with a small "by <Sailendra logo>" credit beneath it
// (brand is "Helat by Sailendra"). The white logo shows on the dark sidebar and
// the black one in light mode, swapped purely by the `.dark` class via CSS — no
// JS, no hydration concern. Used by both the desktop rail and the mobile top bar.
export function Brand({ className }: { className?: string }) {
    return (
        <div className={cn("flex flex-col gap-1", className)}>
            <span className="text-lg font-semibold leading-none tracking-tight text-sidebar-foreground">
                Helat
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
        </div>
    )
}
