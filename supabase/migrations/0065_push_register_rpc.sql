-- Fase 1 — push device registration through an RPC (tracker 1.5, owner
-- decision D19; audit KUA-5 rec. 3 / 4, KEA-23).
--
-- Why. A Web Push endpoint identifies one browser profile, and D19 decided
-- that a device follows whoever is signed in on it NOW: when user B signs in
-- on a browser that user A registered, the device (and its message previews)
-- moves to B and A's org stops pushing to it. The global unique key
-- push_subscriptions_endpoint_key (0046) is what enforces one owner per
-- device, so it STAYS as a reviewed exception to "unique keys include org_id"
-- (070 guard 13; 0062 left it alone on purpose). A (user_id, endpoint) key
-- would let one device keep a row per user and org and show previews of
-- several tenants.
--
-- Under RLS ("own subscriptions in member orgs", 0058) B can neither see nor
-- update A's row, so B's ON CONFLICT (endpoint) DO UPDATE fails with 42501
-- (USING expression). /api/push/subscribe therefore wrote with the
-- service-role client. This function moves that reassignment into the
-- database, so the route can call it with the user's own session (auth.uid()
-- stays the actor; lib/supabase/service.ts):
--   * 42501 unless the caller is signed in (auth.uid()) and a member of p_org;
--   * 22023 unless the input passes its own cheap checks: an endpoint that
--     starts with https:// (any letter case) followed by a host character,
--     at most 2048 characters, and non-empty keys of at most 256 characters.
--     The function is reachable directly through PostgREST, so it validates
--     on its own. This is close to, not identical with, the URL parsing of
--     lib/notifications/push-targets.ts, which the route applies first (real
--     PushSubscription endpoints are canonical https URLs, so both accept
--     them); the route answers 400 for a 22023;
--   * upsert ON CONFLICT (endpoint): org_id and user_id always come from the
--     caller (p_org checked above, auth.uid()), never from another row; keys,
--     user agent (first 400 characters) and last_used_at are refreshed.
-- Accepted: a member who knows another device's endpoint can move it to
-- themselves; the victim stops receiving pushes, no content leaks (endpoints
-- are only exposed to the browser that owns them).
--
-- Deploy order: additive. Apply BEFORE deploying the route change of the same
-- PR (app/api/push/subscribe/route.ts calls register_push_subscription); the
-- route on main keeps working meanwhile (service-role upsert, no function
-- needed). No data change: once the route change is live, the single
-- production row is re-stamped through the RPC on the next dashboard load.
--
-- Rollback: redeploy the previous build first if the route change is live
-- (it needs no function), then
--   drop function public.register_push_subscription(uuid, text, text, text, text);
-- and refresh fingerprint/production.txt.
--
-- No explicit begin/commit: the migration runner wraps the file in a transaction.

create function public.register_push_subscription(
    p_org uuid,
    p_endpoint text,
    p_p256dh text,
    p_auth text,
    p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
    v_user uuid := (select auth.uid());
begin
    -- SECURITY DEFINER bypasses RLS: gate on the caller explicitly.
    if v_user is null or not private.is_org_member(p_org) then
        raise exception 'not authorized to register push devices for this org'
            using errcode = '42501';
    end if;

    -- Cheap checks close to parsePushSubscriptionBody (push-targets.ts): an
    -- https scheme (any case) and a host character, length limits, keys set.
    if coalesce(p_endpoint, '') !~* '^https://[^/?#[:space:]]'
       or length(p_endpoint) > 2048
       or coalesce(p_p256dh, '') = '' or length(p_p256dh) > 256
       or coalesce(p_auth, '') = '' or length(p_auth) > 256
    then
        raise exception 'invalid push subscription'
            using errcode = '22023';
    end if;

    insert into public.push_subscriptions (org_id, user_id, endpoint, p256dh, auth, user_agent, last_used_at)
    values (p_org, v_user, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 400), now())
    on conflict (endpoint) do update
        set org_id       = excluded.org_id,
            user_id      = excluded.user_id,
            p256dh       = excluded.p256dh,
            auth         = excluded.auth,
            user_agent   = excluded.user_agent,
            last_used_at = excluded.last_used_at;
end;
$function$;

-- Signed-in dashboard users only (never anon); the body re-checks membership.
-- Revoke from anon explicitly: the default privileges grant it EXECUTE on new
-- public functions (same pattern as 0047).
revoke all on function public.register_push_subscription(uuid, text, text, text, text) from public, anon;
grant execute on function public.register_push_subscription(uuid, text, text, text, text) to authenticated;
