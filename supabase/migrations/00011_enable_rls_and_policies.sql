-- Replay of production migration 20260526101729 'enable_rls_and_policies'
-- (audit KUA-1, tracker 1.1).
--
-- This migration was applied to production through the dashboard/MCP but never
-- committed. The statements below are copied verbatim from production's
-- supabase_migrations.schema_migrations (read 2026-10-16) so a fresh database
-- passes through the same state. Every "auth full access" policy created here
-- is later replaced by the org-scoped policies of 0028/0029.
--
-- Fresh databases only — production already recorded it under its timestamp.

-- Enable RLS on tables previously without it
ALTER TABLE public.message_queue   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_message  ENABLE ROW LEVEL SECURITY;

-- Policies for authenticated admin dashboard access
-- message_queue & rate_limits intentionally have NO policy (service_role bypasses RLS)

CREATE POLICY "auth full access" ON public.documents
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth full access" ON public.products
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth full access" ON public.system_message
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth full access" ON public.app_settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth full access" ON public.whatsapp_chats
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth full access" ON public.whatsapp_messages
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth full access" ON public.orders
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
