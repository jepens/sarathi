import { isAuthApiError, isAuthRetryableFetchError } from '@supabase/supabase-js'

/**
 * True when Auth could not answer right now (network failure, a retryable
 * fetch error, a 5xx) — as opposed to "this session is invalid / missing".
 * Callers must not treat this as a sign-out: redirecting to /login on an Auth
 * outage can loop with the proxy (KEA-2).
 */
export function isSessionCheckUnavailable(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true
  return isAuthApiError(error) && error.status >= 500
}
