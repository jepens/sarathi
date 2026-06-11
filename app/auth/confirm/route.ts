import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolvePublicOrigin } from "@/lib/utils/public-url";

// Email-confirmation callback. The "Confirm signup" email template points here
// with a token hash, e.g.:
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next={{ .RedirectTo }}
// On success the SSR client sets the session cookie and we redirect onward.
//
// Two things this route must get right behind the Easypanel/Traefik proxy:
//   - The redirect host: `request.url` is the INTERNAL address (localhost:80),
//     so we resolve the public origin from env / X-Forwarded-Host instead — else
//     the confirm link bounces the user to localhost.
//   - `next` is whatever the signup put in emailRedirectTo (a full URL). We only
//     trust its same-origin PATH (open-redirect guard), defaulting to /dashboard.

// Reduce an incoming `next` (full URL or path) to a safe same-origin path.
function safeNextPath(next: string | null): string {
    if (!next) return "/dashboard";
    try {
        // Protocol-relative ("//host") would be an open redirect → reject.
        if (next.startsWith("//")) return "/dashboard";
        if (next.startsWith("/")) return next;
        const u = new URL(next);
        return u.pathname + u.search || "/dashboard";
    } catch {
        return "/dashboard";
    }
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const token_hash = searchParams.get("token_hash");
    const type = searchParams.get("type") as EmailOtpType | null;

    const origin = resolvePublicOrigin(request.headers) || new URL(request.url).origin;
    const next = safeNextPath(searchParams.get("next"));

    if (token_hash && type) {
        const supabase = await createClient();
        const { error } = await supabase.auth.verifyOtp({ type, token_hash });
        if (!error) {
            return NextResponse.redirect(`${origin}${next}`);
        }
    }

    return NextResponse.redirect(`${origin}/login?error=confirm`);
}
