"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Loader2 } from "lucide-react";

export default function SignupPage() {
    const [orgName, setOrgName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const router = useRouter();
    const supabase = createClient();

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setInfo(null);

        try {
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    // org_name -> raw_user_meta_data, read by the handle_new_user
                    // trigger to name the new org.
                    data: { org_name: orgName },
                    // The "Confirm signup" email template already routes through
                    // /auth/confirm (…&next={{ .RedirectTo }}); so this must be the
                    // FINAL landing page, not another /auth/confirm URL — otherwise
                    // the confirm route redirects back into itself with no token.
                    emailRedirectTo: `${window.location.origin}/dashboard/settings`,
                },
            });

            if (error) {
                setError(error.message);
                return;
            }

            // When email confirmation is ON, signUp with an already-registered
            // email returns an obfuscated success with an empty identities array.
            if (data.user && data.user.identities && data.user.identities.length === 0) {
                setError("Email ini sudah terdaftar. Silakan masuk.");
                return;
            }

            if (data.session) {
                // Email confirmation OFF -> signed in immediately. Send to
                // onboarding (fill the Business Profile).
                router.push("/dashboard/settings");
                router.refresh();
            } else {
                // Confirmation ON -> no session yet; org is already created by
                // the trigger, user just needs to confirm their email.
                setInfo(
                    "Akun dibuat! Cek email Anda untuk mengonfirmasi, lalu masuk."
                );
            }
        } catch {
            setError("Terjadi kesalahan. Coba lagi.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-50 dark:bg-black p-4">
            <span className="text-2xl font-bold tracking-tight">Helat</span>
            <Card className="w-full max-w-md">
                <CardHeader className="space-y-1">
                    <CardTitle className="text-2xl font-bold text-center">
                        Daftar EO baru
                    </CardTitle>
                    <CardDescription className="text-center">
                        Buat akun untuk Event Organizer Anda.
                    </CardDescription>
                </CardHeader>
                <form onSubmit={handleSignup}>
                    <CardContent className="space-y-4">
                        {error && (
                            <div className="bg-destructive/15 text-destructive text-sm p-3 rounded-md">
                                {error}
                            </div>
                        )}
                        {info && (
                            <div className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-sm p-3 rounded-md">
                                {info}
                            </div>
                        )}
                        <div className="space-y-2">
                            <Label htmlFor="orgName">Nama bisnis / EO</Label>
                            <Input
                                id="orgName"
                                placeholder="Sailendra Organizer"
                                value={orgName}
                                onChange={(e) => setOrgName(e.target.value)}
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
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="password">Password</Label>
                            <Input
                                id="password"
                                type="password"
                                minLength={6}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />
                        </div>
                    </CardContent>
                    <CardFooter className="flex flex-col gap-3">
                        <Button className="w-full" type="submit" disabled={loading}>
                            {loading ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Mendaftarkan...
                                </>
                            ) : (
                                "Daftar"
                            )}
                        </Button>
                        <p className="text-sm text-muted-foreground">
                            Sudah punya akun?{" "}
                            <Link
                                href="/login"
                                className="font-medium text-foreground underline underline-offset-4"
                            >
                                Masuk
                            </Link>
                        </p>
                    </CardFooter>
                </form>
            </Card>
        </div>
    );
}
