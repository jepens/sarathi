import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from './LoginForm';

export default async function LoginPage({
    searchParams,
}: {
    searchParams: Promise<{ error?: string }>;
}) {
    const { error } = await searchParams;
    const initialError =
        error === 'confirm'
            ? 'Link konfirmasi tidak valid atau sudah dipakai. Coba masuk, atau daftar ulang.'
            : null;

    return (
        <AuthShell
            eyebrow="Masuk"
            title="Selamat datang kembali"
            subtitle="Lanjutkan mengelola lead dan acara Anda."
        >
            <LoginForm initialError={initialError} />
        </AuthShell>
    );
}
