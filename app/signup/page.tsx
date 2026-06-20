import { redirect } from 'next/navigation';

// Single-tenant: public self-serve signup is disabled. The owner account is
// pre-provisioned (created by an admin in Supabase), so /signup just sends
// people to the login page.
export default function SignupPage() {
    redirect('/login');
}
