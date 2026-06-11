'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, ArrowRight } from 'lucide-react';
import { Turnstile, TURNSTILE_ENABLED } from '@/components/auth/turnstile';
import { FIELD, CTA, FormAlert, PasswordInput } from '@/components/auth/form-ui';

export function LoginForm({ initialError }: { initialError?: string | null }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [captchaToken, setCaptchaToken] = useState('');
    const [error, setError] = useState<string | null>(initialError ?? null);
    const [loading, setLoading] = useState(false);
    const router = useRouter();
    const supabase = createClient();

    const canSubmit =
        email.trim().length > 0 &&
        password.length > 0 &&
        (!TURNSTILE_ENABLED || captchaToken.length > 0) &&
        !loading;

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        setLoading(true);
        setError(null);
        try {
            const { error } = await supabase.auth.signInWithPassword({
                email: email.trim().toLowerCase(),
                password,
                options: captchaToken ? { captchaToken } : undefined,
            });
            if (error) {
                setError(error.message);
            } else {
                router.push('/dashboard');
                router.refresh();
            }
        } catch {
            setError('Terjadi kesalahan. Coba lagi.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleLogin} className="space-y-5" noValidate>
            {error && <FormAlert kind="error">{error}</FormAlert>}

            <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                    id="email"
                    type="email"
                    placeholder="kamu@bisnis.co.id"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    className={FIELD}
                    required
                />
            </div>

            <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <PasswordInput
                    id="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                />
            </div>

            {TURNSTILE_ENABLED && <Turnstile onToken={setCaptchaToken} />}

            <Button type="submit" disabled={!canSubmit} className={CTA}>
                {loading ? (
                    <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Memproses...
                    </>
                ) : (
                    <>
                        Masuk <ArrowRight className="ml-1 h-4 w-4" />
                    </>
                )}
            </Button>

            <p className="text-center text-sm text-[#8B8A94]">
                Belum punya akun?{' '}
                <Link href="/signup" className="font-medium text-[#F4F1E9] underline-offset-4 hover:text-[#E6B450] hover:underline">
                    Daftar
                </Link>
            </p>
        </form>
    );
}
