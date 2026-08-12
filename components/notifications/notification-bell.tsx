'use client';

import { Bell, BellRing, BellOff, Volume2, VolumeX, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useNotifications } from './notification-provider';

/**
 * Bell control for enabling desktop notifications + muting the chime.
 *  - variant="row"  → full-width row for the sidebar rail / mobile drawer
 *  - variant="icon" → compact icon button for the mobile top bar
 */
export function NotificationBell({ variant = 'row' }: { variant?: 'row' | 'icon' }) {
    const { supported, permission, active, pushConfigured, soundOn, enable, disable, toggleSound } =
        useNotifications();

    const Icon = !supported || permission === 'denied' ? BellOff : active ? BellRing : Bell;

    const trigger =
        variant === 'icon' ? (
            <Button
                variant="ghost"
                size="icon"
                aria-label="Notifikasi pesan masuk"
                className="relative text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
                <Icon className="size-5" />
                {active && (
                    <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-emerald-500" />
                )}
            </Button>
        ) : (
            <Button
                variant="ghost"
                className="relative w-full justify-start gap-2 font-normal text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
                <Icon className="size-4" />
                Notifikasi
                <span
                    className={cn(
                        'ml-auto text-[11px]',
                        active ? 'text-emerald-500' : 'text-sidebar-foreground/50',
                    )}
                >
                    {!supported ? 'N/A' : active ? 'Aktif' : 'Mati'}
                </span>
            </Button>
        );

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            <DropdownMenuContent align={variant === 'icon' ? 'end' : 'start'} className="w-64">
                <div className="px-2 py-1.5 text-sm font-medium">Notifikasi pesan masuk</div>
                <DropdownMenuSeparator />

                {!supported ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        Browser ini tidak mendukung notifikasi.
                    </div>
                ) : permission === 'denied' ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        Notifikasi diblokir. Izinkan lewat ikon gembok di address bar, lalu muat
                        ulang.
                    </div>
                ) : active ? (
                    <DropdownMenuItem onClick={disable}>
                        <BellOff className="mr-2 size-4" />
                        Nonaktifkan notifikasi
                    </DropdownMenuItem>
                ) : (
                    <DropdownMenuItem onClick={enable}>
                        <BellRing className="mr-2 size-4" />
                        Aktifkan notifikasi
                    </DropdownMenuItem>
                )}

                {/* Keep the menu open so the operator can flip the chime and read state. */}
                <DropdownMenuItem onSelect={(e) => e.preventDefault()} onClick={toggleSound}>
                    {soundOn ? (
                        <Volume2 className="mr-2 size-4" />
                    ) : (
                        <VolumeX className="mr-2 size-4" />
                    )}
                    Suara
                    {soundOn && <Check className="ml-auto size-4 text-emerald-500" />}
                </DropdownMenuItem>

                <DropdownMenuSeparator />
                <div className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                    Notifikasi desktop muncul saat tab tidak aktif — persis seperti WhatsApp Web.
                    {pushConfigured && active
                        ? ' Dengan Web Push, notifikasi tetap masuk walau tab/aplikasi ditutup.'
                        : ' Berlaku selama dashboard terbuka.'}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
