import { isAuthApiError, isAuthError, isAuthRetryableFetchError } from '@supabase/supabase-js'

/**
 * True when Auth could not answer right now — as opposed to "this session is
 * invalid / missing". Callers must not treat this as a sign-out: redirecting
 * to /login on an Auth outage can loop with the proxy (KEA-2).
 *
 * Covers:
 * - AuthRetryableFetchError: network failure, 502/503/504;
 * - AuthApiError with status >= 500, or 429 (rate limited);
 * - AuthUnknownError: auth-js turns any non-JSON error response (an HTML 500
 *   page, a Cloudflare 52x, a JWKS fetch answered with HTML) into this class.
 *   It is matched by name: auth-js exports no type guard for it.
 */
export function isSessionCheckUnavailable(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true
  if (isAuthApiError(error)) return error.status >= 500 || error.status === 429
  return isAuthError(error) && error.name === 'AuthUnknownError'
}
