'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Eye, EyeOff, Check, X, ArrowRight, ShieldCheck } from 'lucide-react';
import { Turnstile, TURNSTILE_ENABLED } from '@/components/auth/turnstile';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Core requirements mirror Supabase's recommended password policy (min 8 +
// upper + lower + digit). Symbol is surfaced as a bonus toward "Sangat kuat"
// but not required, matching the default server policy so the client never
// promises something the server then rejects.
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
    { label: 'Terlalu pendek', color: 'bg-muted', text: 'text-muted-foreground' },
    { label: 'Lemah', color: 'bg-rose-500', text: 'text-rose-400' },
    { label: 'Cukup', color: 'bg-amber-500', text: 'text-amber-400' },
    { label: 'Kuat', color: 'bg-emerald-500', text: 'text-emerald-400' },
    { label: 'Sangat kuat', color: 'bg-emerald-400', text: 'text-emerald-300' },
] as const;

export function SignupForm() {
    const [orgName, setOrgName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [showPw, setShowPw] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
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
                    // Land new EOs on the dashboard Overview (which shows the
                    // onboarding checklist), not deep in Settings.
                    emailRedirectTo: `${window.location.origin}/dashboard`,
                    ...(captchaToken ? { captchaToken } : {}),
                },
            });

            if (error) {
                setError(error.message);
                return;
            }

            // Email confirmation ON + already-registered email returns an
            // obfuscated success with an empty identities array.
            if (data.user && data.user.identities && data.user.identities.length === 0) {
                setError('Email ini sudah terdaftar. Silakan masuk.');
                return;
            }

            if (data.session) {
                router.push('/dashboard');
                router.refresh();
            } else {
                setInfo('Akun dibuat! Cek email Anda untuk konfirmasi, lalu masuk.');
            }
        } catch {
            setError('Terjadi kesalahan. Coba lagi.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {error && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    <X className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}
            {info && (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-400">
                    <Check className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{info}</span>
                </div>
            )}

            <div className="space-y-2">
                <Label htmlFor="orgName">Nama bisnis / EO</Label>
                <Input
                    id="orgName"
                    placeholder="Sailendra Organizer"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    autoComplete="organization"
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
                    required
                />
                {email.length > 0 && !emailValid && (
                    <p className="text-xs text-rose-400">Format email belum valid.</p>
                )}
            </div>

            <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                    <Input
                        id="password"
                        type={showPw ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                        className="pr-10"
                        required
                    />
                    <button
                        type="button"
                        onClick={() => setShowPw((v) => !v)}
                        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                        aria-label={showPw ? 'Sembunyikan password' : 'Tampilkan password'}
                        tabIndex={-1}
                    >
                        {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                </div>

                {password.length > 0 && (
                    <div className="space-y-2 pt-1">
                        <div className="flex items-center gap-2">
                            <div className="flex h-1.5 flex-1 gap-1">
                                {[0, 1, 2, 3].map((i) => (
                                    <div
                                        key={i}
                                        className={`h-full flex-1 rounded-full transition-colors ${
                                            i < score ? STRENGTH[score].color : 'bg-muted'
                                        }`}
                                    />
                                ))}
                            </div>
                            <span className={`text-xs font-medium ${STRENGTH[score].text}`}>
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
                <div className="relative">
                    <Input
                        id="confirm"
                        type={showConfirm ? 'text' : 'password'}
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        autoComplete="new-password"
                        className="pr-10"
                        aria-invalid={confirm.length > 0 && !confirmValid}
                        required
                    />
                    <button
                        type="button"
                        onClick={() => setShowConfirm((v) => !v)}
                        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                        aria-label={showConfirm ? 'Sembunyikan password' : 'Tampilkan password'}
                        tabIndex={-1}
                    >
                        {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                </div>
                {confirm.length > 0 && !confirmValid && (
                    <p className="text-xs text-rose-400">Password tidak sama.</p>
                )}
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-muted-foreground">
                <input
                    type="checkbox"
                    checked={agree}
                    onChange={(e) => setAgree(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-[#e7c16a]"
                />
                <span>
                    Saya setuju dengan <span className="font-medium text-foreground">Syarat &amp; Ketentuan</span> dan{' '}
                    <span className="font-medium text-foreground">Kebijakan Privasi</span> Helat.
                </span>
            </label>

            {TURNSTILE_ENABLED && <Turnstile onToken={setCaptchaToken} />}

            <Button type="submit" disabled={!canSubmit} className="w-full">
                {loading ? (
                    <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Mendaftarkan...
                    </>
                ) : (
                    <>
                        Daftar <ArrowRight className="ml-1 h-4 w-4" />
                    </>
                )}
            </Button>

            <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" /> Koneksi terenkripsi · konfirmasi via email
            </p>

            <p className="text-center text-sm text-muted-foreground">
                Sudah punya akun?{' '}
                <Link
                    href="/login"
                    className="font-medium text-foreground underline underline-offset-4 hover:text-[#e7c16a]"
                >
                    Masuk
                </Link>
            </p>
        </form>
    );
}

function Req({ ok, label }: { ok: boolean; label: string }) {
    return (
        <li className={`flex items-center gap-1.5 ${ok ? 'text-emerald-400' : 'text-muted-foreground'}`}>
            {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3 opacity-50" />}
            {label}
        </li>
    );
}
