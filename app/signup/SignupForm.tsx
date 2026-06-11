'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Check, X, ArrowRight, Lock } from 'lucide-react';
import { Turnstile, TURNSTILE_ENABLED } from '@/components/auth/turnstile';
import { FIELD, CTA, FormAlert, PasswordInput } from '@/components/auth/form-ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Core requirements mirror Supabase's recommended policy (min 8 + upper + lower
// + digit). Symbol is a bonus toward "Sangat kuat" but not required, matching
// the default server policy so the client never promises what the server rejects.
function passwordChecks(pw: string) {
    return {
        length: pw.length >= 8,
        lower: /[a-z]/.test(pw),
        upper: /[A-Z]/.test(pw),
        digit: /[0-9]/.test(pw),
        symbol: /[^A-Za-z0-9]/.test(pw),
    };
}

const STRENGTH = [
    { label: 'Terlalu pendek', bar: 'bg-[#1F1F26]', text: 'text-[#8B8A94]' },
    { label: 'Lemah', bar: 'bg-[#F87171]', text: 'text-[#F87171]' },
    { label: 'Cukup', bar: 'bg-[#FBBF24]', text: 'text-[#FBBF24]' },
    { label: 'Kuat', bar: 'bg-[#34D399]', text: 'text-[#34D399]' },
    { label: 'Sangat kuat', bar: 'bg-[#34D399]', text: 'text-[#34D399]' },
] as const;

export function SignupForm() {
    const [orgName, setOrgName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [agree, setAgree] = useState(false);
    const [captchaToken, setCaptchaToken] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const router = useRouter();
    const supabase = createClient();

    const checks = useMemo(() => passwordChecks(password), [password]);
    const coreMet = checks.length && checks.lower && checks.upper && checks.digit;
    const score = password
        ? Math.min(
              4,
              (checks.length ? 1 : 0) +
                  (checks.lower && checks.upper ? 1 : 0) +
                  (checks.digit ? 1 : 0) +
                  (checks.symbol ? 1 : 0),
          )
        : 0;
    const emailValid = EMAIL_RE.test(email.trim());
    const confirmValid = confirm.length > 0 && confirm === password;

    const canSubmit =
        orgName.trim().length > 1 &&
        emailValid &&
        coreMet &&
        confirmValid &&
        agree &&
        (!TURNSTILE_ENABLED || captchaToken.length > 0) &&
        !loading;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        setLoading(true);
        setError(null);
        setInfo(null);
        try {
            const { data, error } = await supabase.auth.signUp({
                email: email.trim().toLowerCase(),
                password,
                options: {
                    data: { org_name: orgName.trim() },
                    // Land new EOs on the dashboard Overview (with the onboarding
                    // checklist), not deep in Settings.
                    emailRedirectTo: `${window.location.origin}/dashboard`,
                    ...(captchaToken ? { captchaToken } : {}),
                },
            });

            if (error) {
                setError(error.message);
                return;
            }
            if (data.user && data.user.identities && data.user.identities.length === 0) {
                setError('Email ini sudah terdaftar. Silakan masuk.');
                return;
            }
            if (data.session) {
                router.push('/dashboard');
                router.refresh();
            } else {
                setInfo('Akun dibuat. Cek email Anda untuk konfirmasi, lalu masuk.');
            }
        } catch {
            setError('Terjadi kesalahan. Coba lagi.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {error && <FormAlert kind="error">{error}</FormAlert>}
            {info && <FormAlert kind="success">{info}</FormAlert>}

            <div className="space-y-2">
                <Label htmlFor="orgName">Nama bisnis / EO</Label>
                <Input
                    id="orgName"
                    placeholder="Sailendra Organizer"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    autoComplete="organization"
                    className={FIELD}
                    required
                />
            </div>

            <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                    id="email"
                    type="email"
                    placeholder="kamu@bisnis.co.id"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    aria-invalid={email.length > 0 && !emailValid}
                    className={FIELD}
                    required
                />
                {email.length > 0 && !emailValid && (
                    <p className="text-xs text-[#F87171]">Format email belum valid.</p>
                )}
            </div>

            <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <PasswordInput id="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                {password.length > 0 && (
                    <div className="space-y-2 pt-1">
                        <div className="flex items-center gap-2">
                            <div className="flex h-1.5 flex-1 gap-1">
                                {[0, 1, 2, 3].map((i) => (
                                    <div
                                        key={i}
                                        className={`h-full flex-1 rounded-full transition-colors ${
                                            i < score ? STRENGTH[score].bar : 'bg-[#1F1F26]'
                                        }`}
                                    />
                                ))}
                            </div>
                            <span className={`font-rail text-[10px] tracking-[0.1em] uppercase ${STRENGTH[score].text}`}>
                                {STRENGTH[score].label}
                            </span>
                        </div>
                        <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                            <Req ok={checks.length} label="Min. 8 karakter" />
                            <Req ok={checks.upper} label="Huruf besar" />
                            <Req ok={checks.lower} label="Huruf kecil" />
                            <Req ok={checks.digit} label="Angka" />
                        </ul>
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <Label htmlFor="confirm">Konfirmasi password</Label>
                <PasswordInput
                    id="confirm"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    invalid={confirm.length > 0 && !confirmValid}
                />
                {confirm.length > 0 && !confirmValid && (
                    <p className="text-xs text-[#F87171]">Password tidak sama.</p>
                )}
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-[#8B8A94]">
                <input
                    type="checkbox"
                    checked={agree}
                    onChange={(e) => setAgree(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-[#B8862F]/40 accent-[#E6B450]"
                />
                <span>
                    Saya setuju dengan <span className="font-medium text-[#F4F1E9]">Syarat &amp; Ketentuan</span> dan{' '}
                    <span className="font-medium text-[#F4F1E9]">Kebijakan Privasi</span> Helat.
                </span>
            </label>

            {TURNSTILE_ENABLED && <Turnstile onToken={setCaptchaToken} />}

            <Button type="submit" disabled={!canSubmit} className={CTA}>
                {loading ? (
                    <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Mendaftarkan...
                    </>
                ) : (
                    <>
                        Buat akun <ArrowRight className="ml-1 h-4 w-4" />
                    </>
                )}
            </Button>

            <p className="font-rail flex items-center justify-center gap-1.5 text-[10px] tracking-[0.16em] text-[#8B8A94] uppercase">
                <Lock className="h-3 w-3" /> Terenkripsi · konfirmasi via email
            </p>

            <p className="text-center text-sm text-[#8B8A94]">
                Sudah punya akun?{' '}
                <Link href="/login" className="font-medium text-[#F4F1E9] underline-offset-4 hover:text-[#E6B450] hover:underline">
                    Masuk
                </Link>
            </p>
        </form>
    );
}

function Req({ ok, label }: { ok: boolean; label: string }) {
    return (
        <li className={`flex items-center gap-1.5 ${ok ? 'text-[#34D399]' : 'text-[#8B8A94]'}`}>
            {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3 opacity-40" />}
            {label}
        </li>
    );
}
