'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Eye, EyeOff, AlertCircle, CheckCircle2 } from 'lucide-react';

// Brand-styled field — matches the landing's charcoal/brass system (raised
// #16161C surface, brass hairline, gold focus) rather than the neutral shadcn
// theme tokens, so the auth pages read as the same product as the marketing site.
export const FIELD =
    'h-11 bg-brand-surface dark:bg-brand-surface border-brand-brass/30 text-brand-bone ' +
    'placeholder:text-brand-muted/60 focus-visible:border-brand-gold/60 focus-visible:ring-brand-gold/25';

export function FormAlert({
    kind,
    children,
}: {
    kind: 'error' | 'success';
    children: React.ReactNode;
}) {
    const error = kind === 'error';
    const Icon = error ? AlertCircle : CheckCircle2;
    return (
        <div
            className={`flex items-start gap-2.5 rounded-md border p-3 text-sm ${
                error
                    ? 'border-[#F87171]/30 bg-[#F87171]/10 text-[#F87171]'
                    : 'border-[#34D399]/30 bg-[#34D399]/10 text-[#34D399]'
            }`}
        >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{children}</span>
        </div>
    );
}

export function PasswordInput({
    id,
    value,
    onChange,
    autoComplete,
    invalid,
    placeholder,
}: {
    id: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    autoComplete: string;
    invalid?: boolean;
    placeholder?: string;
}) {
    const [show, setShow] = useState(false);
    return (
        <div className="relative">
            <Input
                id={id}
                type={show ? 'text' : 'password'}
                value={value}
                onChange={onChange}
                autoComplete={autoComplete}
                placeholder={placeholder}
                aria-invalid={invalid}
                className={`${FIELD} pr-10`}
                required
            />
            <button
                type="button"
                tabIndex={-1}
                onClick={() => setShow((v) => !v)}
                aria-label={show ? 'Sembunyikan password' : 'Tampilkan password'}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-brand-muted transition-colors hover:text-brand-bone"
            >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
        </div>
    );
}

// Shared gold CTA — the one bold action on each auth page.
export const CTA =
    'h-11 w-full bg-brand-gold font-semibold text-brand-ink hover:bg-brand-gold/90 ' +
    'focus-visible:ring-brand-gold/70 disabled:opacity-50';
