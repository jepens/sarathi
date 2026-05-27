import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api          (API routes — each handler does its own auth;
     *                 webhooks like /api/webhook/whatsapp must not be
     *                 redirected to /login and don't carry user cookies)
     * - _next/static (static files)
     * - _next/image  (image optimization files)
     * - favicon.ico  (favicon file)
     * - image extensions (svg, png, jpg, jpeg, gif, webp)
     */
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
