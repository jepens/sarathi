import { Store } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ContactType = 'lead' | 'vendor' | 'other';

// Single source of truth for the klien/vendor identity flag, shown next to a
// contact's name across the dashboard (Contacts table + detail, chat list, chat
// header). "lead" gets NO badge — it's the default and the majority, so badging
// it would just add noise. Text + icon (not colour alone) for accessibility.
//
// size: "sm" (default) is compact for dense lists; "md" matches the shadcn
// Badge density used elsewhere (e.g. next to the StageBadge in the CRM card).
export function ContactTypeBadge({
    type,
    size = 'sm',
    className,
}: {
    type: ContactType | string | null | undefined;
    size?: 'sm' | 'md';
    className?: string;
}) {
    const sizeCls = size === 'md' ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-0.5 text-[10px]';
    const iconCls = size === 'md' ? 'h-3 w-3' : 'h-2.5 w-2.5';

    if (type === 'vendor') {
        return (
            <span
                title="Vendor / supplier"
                className={cn(
                    'inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-100 font-medium leading-none text-orange-700',
                    sizeCls,
                    className
                )}
            >
                <Store className={iconCls} />
                Vendor
            </span>
        );
    }
    if (type === 'other') {
        return (
            <span
                title="Lainnya (bukan klien/vendor)"
                className={cn(
                    'inline-flex items-center rounded-full border border-gray-200 bg-gray-100 font-medium leading-none text-gray-600',
                    sizeCls,
                    className
                )}
            >
                Lainnya
            </span>
        );
    }
    return null;
}
