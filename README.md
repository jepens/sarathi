# Sailendra Assistant

**AI-powered assistant & CRM for Event Organizers** — built for **Sailendra Organizer** (team building, capacity building, company gathering).

Originally "Sahabat UMKM" (a generic retail/MSME sales assistant), the app was pivoted to a specialized Event Organizer platform. The AI persona is **Nindra**; human hand-off goes to **MJ (Mang Jajang)**.

> Legacy retail features (RajaOngkir shipping, stock-based products) have been removed. Older docs under `docs/` describe the pre-pivot app and are kept for historical reference only.

## ✨ Features

### AI WhatsApp Assistant (Nindra)
- WhatsApp Business Cloud API integration (webhook + Cloud API send)
- RAG responses from a Knowledge Base + event package catalog
- OpenAI **function tools** (not prompt tags): `save_lead_info`, `update_lead_stage`, `schedule_meeting`, `handoff_to_human`, `create_order`, `check_availability`, `list_products`
- Production hardening: webhook signature verification, DB-backed rate limiting, message queue with retries, structured logging, multi-instance safe (no Redis)

### CRM & Sales Ops
- **Pipeline** — kanban over 7 lead stages (`new → qualifying → quoted → scheduled → booked → won/lost`), HTML5 drag-and-drop
- **Calendar** — events & meetings via Schedule X v4 (Temporal API)
- **Dashboard** — EO KPIs (active leads, bookings, revenue)
- **Vendors** — contact directory (catering, venue, transport, etc.)
- **Contacts** — lead/customer records

### Proposals (admin-approved)
- Generate a PDF from a template (`@react-pdf/renderer`) **or** upload a custom PDF
- Preview inline, then send via email (Resend) — **the AI never sends autonomously**; an admin approves & sends from the pipeline
- Audit trail in the `proposals` table + private Supabase Storage bucket

### WhatsApp messaging reliability
- **Delivery status tracking** — every outbound message stores Meta's `wamid`; status callbacks update it to sent / delivered / read / failed. The chat UI shows WhatsApp-style check marks and surfaces failures (e.g. error 131047) with a clear reason.
- **Template messages** — re-engage customers outside the 24-hour window via approved templates, with a variable-fill dialog.
- **24-hour window badge** — the chat list flags conversations where free-form replies are blocked, so an admin knows to use a template.
- **Business-Scoped User IDs (BSUID)** — hybrid identity model that captures Meta's `user_id`, handles `user_id_update`, and recovers phone numbers (`verified_phone`) ahead of the June 2026 username rollout. See [memory/meta_bsuid_migration] notes / migrations `0013`–`0014`.

## 🛠️ Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack) + React 19
- **Database**: Supabase (PostgreSQL + pgvector + Storage + RLS)
- **AI**: OpenAI (GPT models + `text-embedding-3-small`)
- **Messaging**: WhatsApp Business Cloud API (Graph v21)
- **PDF**: `@react-pdf/renderer` · **Email**: Resend (requires Node ≥ 22)
- **Calendar**: Schedule X v4 (`temporal-polyfill`)
- **UI**: Tailwind CSS + shadcn/ui

## 📦 Setup

### Prerequisites
- **Node.js ≥ 22** (Resend v6 requirement)
- Supabase project, OpenAI API key, WhatsApp Business API access

### Steps
```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).

### Environment variables
See [.env.example](./.env.example) for the full list with inline docs. Key groups:
- **Supabase**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **OpenAI**: `OPENAI_API_KEY`
- **WhatsApp**: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` (for templates), `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`
- **Email (proposals)**: `RESEND_API_KEY`, `SAILENDRA_FROM_EMAIL`

### Database migrations
Idempotent SQL lives in [`supabase/migrations/`](./supabase/migrations) and is applied via the Supabase MCP / CLI. Highlights:
- `0002` EO pivot schema (CRM/event fields) · `0003`/`0004` proposals table + storage bucket · `0004` vendors
- `0005`–`0009` security hardening (drop anon RLS, pin `search_path`, revoke `verify_webhook_token`, move extensions)
- `0010` realtime publication · `0011` message delivery status · `0012` `last_inbound_at` (24h badge)
- `0013` `bsuid` · `0014` `verified_phone` (BSUID adoption)

## 🔐 Security

- Never commit `.env.local`.
- `whatsapp_chats` / `whatsapp_messages` are authenticated-only (RLS); the webhook writes via the service role. Anon clients have no access.
- Webhook enforces `X-Hub-Signature-256` (set `WHATSAPP_APP_SECRET`); `WHATSAPP_WEBHOOK_SKIP_SIGNATURE=true` is local-dev only.
- Use a Meta System User token in production.

## 🚀 Deployment

- VPS via Nixpacks (Coolify/similar) or Vercel.
- Set all env vars on the platform; pin Node ≥ 22.
- Configure a cron/worker to call the queue processor for WhatsApp message handling. See [docs/VPS_DEPLOYMENT.md](./docs/VPS_DEPLOYMENT.md) (deployment mechanics still apply; ignore its retail-feature references).

## 📊 Project Structure
```
app/
  api/            # chat, chat/send, chat/templates, chat/send-template,
                  # webhook/whatsapp, leads, events, proposals, vendors, ...
  dashboard/      # pipeline, calendar, chats, contacts, vendors, products, ...
components/       # UI + dashboard widgets
lib/
  ai/             # RAG, tools, embeddings, system message
  proposals/      # PDF render + send pipeline
  whatsapp/       # client, templates, queue, history, security
  supabase/       # server / client / service-role helpers
  vendors/        # shared category constants
supabase/migrations/   # idempotent SQL
```

---

**Built for Sailendra Organizer.**
