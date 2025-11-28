
-----

# Product Requirement Document (PRD)

**Project Name:** Sahabat UMKM (AI-Powered Sales Assistant)  
**Version:** 1.5  
**Date:** 2025-11-29  
**Status:** In Development

## 1. Project Overview

**Sahabat UMKM** is a smart sales assistant for Indonesian MSMEs. Unlike standard chatbots, it actively drives sales by parsing unstructured business data, checking real-time inventory, calculating shipping costs, employing persuasive sales techniques via WhatsApp, and featuring **dynamic AI persona configuration**.

## 2. Technical Architecture & Stack

* **Frontend:** Next.js 14+ (App Router).
* **Styling:** Tailwind CSS.
* **UI Component Library:** **shadcn/ui** (Crucial for Linear look).
* **Animations:** **Framer Motion** (For smooth interactions).
* **Icons:** Lucide React.
* **Fonts:** Geist Sans / Inter (Clean, modern typography).
* **Backend:** Next.js API Routes (Serverless).
* **Database:** Supabase (PostgreSQL).
* **AI/LLM:** OpenAI API (`gpt-4o`).
* **Logistics:** RajaOngkir API.
* **Messaging:** WhatsApp Business Cloud API.

## 3. Core Features Roadmap

### Phase 1: Knowledge Base Management ✅
- Document upload and parsing
- Vector embeddings and search
- RAG-based AI responses

### Phase 2: AI Chat Interface ✅
- Chat UI with Linear aesthetic
- Real-time AI responses
- Shipping cost integration

### Phase 3: Product Management ✅
- Product CRUD operations
- Inventory tracking
- Product embeddings

### Phase 4: WhatsApp Integration ✅
- WhatsApp Business API integration
- Message queue and rate limiting
- **WhatsApp Chat Monitoring Dashboard**
  - Real-time conversation monitoring
  - Admin manual reply capability
  - Chat history storage
  - WhatsApp Web-like interface

### Phase 5: Advanced Features & AI Configuration ✅ (Partial)
- ✅ **Product Search Integration** (RAG-based)
- ✅ **Shipping Cost Calculator** (RajaOngkir API)
- ✅ **System Message Configuration** (NEW - 2025-11-29)
  - Dynamic AI persona configuration via admin dashboard
  - Database-driven system messages
  - No code deployment needed for AI behavior changes
  - Multiple persona profiles support
  - A/B testing ready
- ✅ **Webhook Settings Configuration** (NEW - 2025-11-29)
  - Configure WhatsApp Webhook URL and Verify Token via UI
  - Secure database storage
  - No environment variable changes needed
- **Order Management** flow (Planned)
- **Payment Integration** (Planned)
- **Analytics Dashboard** (Planned)

### Phase 6: Transaction Engine (Planned)
- Order processing
- Payment integration
- Order tracking

## 4. Phase 1 Detailed Specifications

*(Same as v1.2)*

## 5. Phase 2 & 4 Detailed Specifications

*(Same as v1.2)*

## 5.5. Phase 5 - System Message Configuration (NEW)

### Overview
Allows administrators to configure AI persona and behavior dynamically without code changes. System messages define how the AI responds, its tone, conversation flow, and sales approach.

### Key Features

#### 5.5.1. Database-Driven Configuration
- **Table**: `system_message` in Supabase
- **Fields**: 
  - `id` (UUID): Unique identifier
  - `name` (VARCHAR): Profile name (e.g., 'default', 'aggressive', 'support')
  - `content` (TEXT): The system message content (max 50,000 chars)
  - `is_active` (BOOLEAN): Only one can be active at a time
  - `description` (TEXT): Description of the persona
  - `created_at`, `updated_at`: Timestamps

#### 5.5.2. Admin Interface
- **Location**: `/dashboard/settings`
- **Features**:
  - Large textarea for editing system message
  - Real-time validation (empty check, length limit)
  - Save/Reset functionality
  - Last updated timestamp display
  - Profile name display
  - Toast notifications (sonner)

#### 5.5.3. RAG Integration
- System message loaded from database on each AI request
- Fallback to hardcoded default if database fails
- Combined with context (products, documents, shipping info) before sending to OpenAI
- No caching (ensures fresh updates)

#### 5.5.4. Default Persona
The default system message configures AI as:
- **Identity**: "Sahabat UMKM" - friendly sales assistant
- **Tone**: Polite, uses "Kak", conversational Indonesian
- **Focus**: Product search, pricing, shipping, sales conversion
- **Flow**: Greeting → Product Inquiry → Shipping → Checkout → Payment

### Technical Implementation

**API Endpoints**:
- `GET /api/system-message` - Fetch active or specific system message
- `PUT /api/system-message` - Update content or activate different profile
- `POST /api/system-message` - Create new profile

**Input Validation**:
- Content cannot be empty
- Max length: 50,000 characters
- Name format validation (lowercase, numbers, underscores)
- Duplicate name detection

**Helper Function**:
- `getActiveSystemMessage()` in `lib/ai/system-message.ts`
- Used by RAG engine to load persona
- Automatic fallback mechanism

**UI Component**:
- `SystemMessageEditor` in `app/dashboard/settings/components/`
- Uses `sonner` for toast notifications
- Real-time enable/disable of Save button
- Loading states and error handling

### Benefits
1. **No Code Deployment**: Change AI behavior instantly
2. **A/B Testing Ready**: Create multiple personas, test performance
3. **Flexible**: Adapt to different business needs or customer segments
4. **Version Control**: Track changes via timestamps
5. **Fail-Safe**: Automatic fallback if database unavailable
6. **Production Ready**: Comprehensive validation and error handling

### Documentation
- **Full docs**: `docs/SYSTEM_MESSAGE.md`
- **Setup guide**: `database/SYSTEM_MESSAGE_SETUP.md`
- **Test script**: `scripts/test-system-message.ts`
- **Test results**: `TEST_RESULTS_SYSTEM_MESSAGE.md`

## 5.6. Phase 5 - Webhook Settings Configuration (NEW)

### Overview
Simplifies the management of WhatsApp Webhook configuration by allowing administrators to update the Webhook URL and Verify Token directly from the dashboard. This removes the need to redeploy the application or modify environment variables when switching between development (ngrok) and production (VPS) environments.

### Key Features

#### 5.6.1. Database Storage
- **Table**: `app_settings` in Supabase
- **Fields**:
  - `key` (TEXT): Unique setting key (e.g., `whatsapp_webhook_url`)
  - `value` (TEXT): The setting value
  - `description` (TEXT): Optional description
- **Security**:
  - Row Level Security (RLS) restricts read/write to authenticated users (admins).
  - Secure RPC function (`verify_webhook_token`) allows the webhook route to verify tokens without exposing the actual token value to anonymous users.

#### 5.6.2. Admin Interface
- **Location**: `/dashboard/settings`
- **Features**:
  - View current Webhook URL and Verify Token
  - Edit and Save configuration
  - "Copy to Clipboard" buttons
  - "Generate Random Token" button
  - Visual status indicator (Active/Inactive)

#### 5.6.3. Webhook Integration
- **Route**: `/api/webhook/whatsapp`
- **Logic**:
  - Fetches verify token from database via secure RPC.
  - Fallback to environment variables if database setting is missing.
  - Supports seamless transition between environments.

### Technical Implementation

**Database Schema**:
- `app_settings` table with RLS policies.
- `verify_webhook_token` SECURITY DEFINER function.

**Components**:
- `WebhookSettings.tsx`: Client component with form handling and toast notifications.
- `app-settings.ts`: Server-side utility functions for data access.
- `actions.ts`: Server Actions for secure updates.

**Benefits**:
1.  **Ease of Use**: No need to access server console or env files.
2.  **Flexibility**: Quickly switch webhook URLs (e.g., from ngrok to domain).
3.  **Security**: Token verification happens securely in the database.


-----

## 6. UI/UX Guidelines: The "Linear" Aesthetic

The application must follow a high-quality, product-focused design language similar to Linear.app.

### 6.1. Visual Style Principles

* **Theme:** Dark mode first (preferred) or high-contrast clean light mode.
* **Colors:**
  * Backgrounds: Rich blacks (`#000000`), Dark Greys (`#121212`).
  * Borders: Subtle, translucent borders (`border-white/10` or `border-neutral-800`).
  * Accents: Electric violet or Primary Blue/White glow for active states.
* **Typography:**
  * Sans-serif, highly legible (Inter or Geist).
  * Use slightly tighter tracking for headings.
  * Muted text colors (`text-muted-foreground`) for secondary info.
* **Effects:**
  * **Glassmorphism:** Subtle backdrop blur on sticky headers and modals.
  * **Micro-interactions:** Buttons should have subtle scale/brightness changes on hover.
  * **Gradients:** Very subtle radial gradients to highlight sections (like "Bento Grids").

### 6.2. Component Instructions (for AI Generation)

* **Buttons:** Minimalist, no heavy drop shadows. Outline or Ghost variants for secondary actions.
* **Inputs:** Minimal borders, focus rings should be subtle glows, not harsh outlines.
* **Cards:** Use "Bento Grid" style layout—cards with thin borders and distinct content hierarchy.
* **Feedback:** Use `sonner` for toast notifications (fits Linear style perfectly).

-----

## 7. Development Priority (Step-by-Step)

1. **Step 1 (Setup):** Initialize Project with **shadcn/ui** to establish the Linear look immediately.
2. **Step 2 (Database):** Setup Supabase Tables.
3. **Step 3 (UI Implementation):** Build the "Knowledge Base" Upload page using the Linear design system.
4. **Step 4 (Logic):** Implement AI Parsing logic.
5. **Step 5 (Connections):** Integrate WhatsApp & Tools.
6. **Step 6 (AI Configuration):** Implement System Message Configuration.

-----
