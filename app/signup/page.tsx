import { AuthShell } from '@/components/auth/auth-shell';
import { SignupForm } from './SignupForm';

export default function SignupPage() {
    return (
        <AuthShell
            eyebrow="Buat akun"
            title="Daftar EO baru"
            subtitle="Akun gratis untuk Event Organizer Anda — siap dalam semenit."
        >
            <SignupForm />
        </AuthShell>
    );
}
