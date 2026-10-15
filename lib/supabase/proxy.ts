import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Responses that set auth cookies must never be cached by a CDN / reverse
// proxy, or one user's session could be served to another. @supabase/ssr
// >= 0.10 hands these headers to setAll(); the installed 0.8 does not, so the
// proxy applies them itself whenever it writes session cookies.
const NO_STORE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
  Expires: '0',
  Pragma: 'no-cache',
}

/**
 * Session refresh + page-level redirects for the Next.js proxy (proxy.ts).
 *
 * This is a UX gate, not the security boundary: API routes are excluded from
 * the proxy matcher and every route handler, server action and the dashboard
 * layout re-check the caller via requireOrgContext() (lib/settings/org-context).
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })
  let cookiesWritten = false

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
          cookiesWritten = true
        },
      },
    }
  )

  // Do not run code between createServerClient and supabase.auth.getClaims().
  // getClaims() refreshes an expired session (writing the new cookies through
  // setAll above) and verifies the JWT signature — locally when the project
  // uses asymmetric signing keys, otherwise via the Auth server. Removing it
  // makes users randomly logged out of server-rendered pages.
  const { data } = await supabase.auth.getClaims()
  const signedIn = !!data?.claims?.sub

  const { pathname } = request.nextUrl
  let response: NextResponse = supabaseResponse

  if (pathname.startsWith('/dashboard') && !signedIn) {
    response = redirectKeepingCookies(new URL('/login', request.url), supabaseResponse)
  } else if (
    (pathname.startsWith('/login') || pathname.startsWith('/signup')) &&
    signedIn
  ) {
    response = redirectKeepingCookies(new URL('/dashboard', request.url), supabaseResponse)
  }

  if (cookiesWritten) {
    for (const [key, value] of Object.entries(NO_STORE_HEADERS)) {
      response.headers.set(key, value)
    }
  }

  // IMPORTANT: always return the response carrying supabaseResponse's cookies.
  // A fresh NextResponse without them desyncs browser and server and ends the
  // user's session prematurely.
  return response
}

// A redirect that still carries any refreshed session cookies.
function redirectKeepingCookies(url: URL, from: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(url)
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie))
  return redirect
}
