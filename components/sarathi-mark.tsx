import { cn } from "@/lib/utils"

/**
 * Sarathi mark — the "Chakra-dial": a spoked chariot wheel that doubles as a
 * gauge. The rim + spokes render in nila (indigo, via currentColor) while the
 * hub and one "lit" spoke are heritage gold — the active stage on the dial.
 * The mark therefore carries both brand colors (Kanaka & Nila) at once and
 * scales cleanly from a 16px favicon to the hero. Decorative: the adjacent
 * "Sarathi" wordmark is the accessible name, so this is aria-hidden.
 *
 * The PWA app icons mirror this exact geometry — see scripts/generate-icons.mjs.
 */
export function SarathiMark({
    className,
    spokes = 8,
    litSpoke = 1,
}: {
    className?: string
    /** Number of wheel spokes (8 = dharmachakra cadence). */
    spokes?: number
    /** Index of the gold "active" spoke, clockwise from the top. */
    litSpoke?: number
}) {
    const C = 24 // centre of the 48×48 viewBox
    const innerR = 7 // spoke start (clears the hub)
    const outerR = 17 // spoke end (clears the rim)
    const lit = ((litSpoke % spokes) + spokes) % spokes

    return (
        <svg
            viewBox="0 0 48 48"
            fill="none"
            aria-hidden="true"
            className={cn("text-brand-indigo-lit", className)}
        >
            {/* rim */}
            <circle cx={C} cy={C} r={19} stroke="currentColor" strokeWidth={2} opacity={0.9} />
            {/* spokes — one is gold-lit (the active stage on the dial) */}
            {Array.from({ length: spokes }, (_, i) => {
                const angle = ((-90 + (360 / spokes) * i) * Math.PI) / 180
                const isLit = i === lit
                return (
                    <line
                        key={i}
                        x1={C + innerR * Math.cos(angle)}
                        y1={C + innerR * Math.sin(angle)}
                        x2={C + outerR * Math.cos(angle)}
                        y2={C + outerR * Math.sin(angle)}
                        strokeLinecap="round"
                        stroke="currentColor"
                        className={isLit ? "stroke-brand-gold" : undefined}
                        strokeWidth={isLit ? 2.75 : 1.5}
                        opacity={isLit ? 1 : 0.5}
                    />
                )
            })}
            {/* hub */}
            <circle cx={C} cy={C} r={3.4} className="fill-brand-gold" />
        </svg>
    )
}
