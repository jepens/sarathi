
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
  - Real-time conversation monitoring (Supabase Realtime + Polling fallback)
  - Admin manual reply capability
  - Chat history storage
  - WhatsApp Web-like interface
  - Auto-refresh: Chat list (30s), Messages (10s)
  - No manual refresh required

### Phase 5: Advanced Features & AI Configuration ✅ (Partial)
- ✅ **Product Search Integration** (RAG-based)
- ✅ **Shipping Cost Calculator** (RajaOngkir API)
- ✅ **System Message Configuration** (2025-11-29)
  - Dynamic AI persona configuration via admin dashboard
  - Database-driven system messages
  - No code deployment needed for AI behavior changes
- ✅ **Contacts Management** (2025-11-29)
  - Automatic name extraction from conversations
  - Manual contact editing via dashboard
- ✅ **Settings Management** (2025-11-29)
  - Centralized configuration dashboard
  - WhatsApp, AI, and Shipping settings
  - Secure input with password masking
- ✅ **Order Management Flow** (2025-11-29)
  - AI-driven order creation from conversations
  - Admin dashboard for order management
  - Support for products and services
- ✅ **Chat Memory** (2025-11-29)
  - Conversation history retrieval
  - Context-aware AI responses
  - No repeated questions
- ✅ **Authentication System**
  - Admin login with Supabase Auth
  - Route protection via middleware
  - Logout functionality
- ✅ **API Security**
  - All admin endpoints require authentication
  - Public endpoints secured with tokens/signatures
- ✅ **Landing Page**
  - Modern, animated design with Framer Motion
  - Consistent centered layout
  - Professional UI/UX
- ✅ **Security Best Practices**
  - Manual admin creation
  - Disabled public signups
  - Server-side validation


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
  - **Template Selection**: Dropdown with presets (Default, UMKM Produk, UMKM Jasa)
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

## 5.7. Phase 5 - Contacts Management (NEW - 2025-11-29)

### Overview
Provides a centralized contact management system that automatically captures and displays WhatsApp user names. The AI assistant can automatically extract names from conversations, and administrators can manually edit contact names as needed.

### Key Features

#### 5.7.1. Automatic Name Extraction
- **AI-Driven**: The AI automatically asks for the user's name during conversations
- **Tag-Based System**: Uses hidden `[UPDATE_NAME: Name]` tag in AI responses
- **Backend Processing**: Tag detected in `lib/ai/rag.ts`, name saved to database, tag removed from response
- **System Message Integration**: Default system message includes name extraction instructions

#### 5.7.2. Admin Interface
- **Location**: `/dashboard/contacts`
- **Features**:
  - Contact list with search (by name or phone number)
  - Display: Name, Phone Number, Last Active timestamp
  - Manual edit via Dialog modal
  - Remove name functionality (preserves chat history)
  - Responsive table layout with user avatars

#### 5.7.3. Chat Integration
- **Chat List**: Displays contact name instead of phone number when available
- **Chat Window**: Shows contact name in header
- **Real-time Updates**: Contact name changes reflect immediately

### Technical Implementation

**Database**:
- Extended `whatsapp_chats` table with `contact_name` column
- Migration script: `database/add_contact_name.sql`

**Components**:
- `ContactList.tsx`: Contact management interface with Dialog modals
- `ChatList.tsx`: Updated to display contact names
- `ChatWindow.tsx`: Updated header with contact name

**Benefits**:
1. **Personalized Conversations**: Named contacts improve user experience
2. **Automatic Extraction**: No manual data entry required
3. **Fallback**: Manual edit available if AI extraction fails
4. **Non-Destructive**: Removing name preserves chat history
5. **Seamless Integration**: Works with existing chat monitoring

**Documentation**: `docs/CONTACTS_MANAGEMENT.md`

## 5.8. Phase 5 - Settings Management (NEW - 2025-11-29)

### Overview
Provides a centralized, user-friendly interface for managing all application credentials and configurations without requiring code deployment or environment variable changes. Administrators can configure WhatsApp, AI, and Shipping integrations directly from the dashboard.

### Key Features

#### 5.8.1. Tabs-Based Organization
- **Location**: `/dashboard/settings`
- **4 Main Tabs**:
  1. **WhatsApp** - WhatsApp Business API credentials
  2. **AI** - OpenAI API configuration
  3. **Shipping** - Shipping cost API (optional)
  4. **System** - AI System Message configuration

#### 5.8.2. WhatsApp Configuration Tab
- **Fields**:
  - Webhook URL (read-only, auto-generated)
  - Verify Token (with random generator)
  - Access Token 🔐 (secure input)
  - Phone Number ID
  - App Secret 🔐 (optional, for signature validation)
- **Features**:
  - Copy buttons for URL and tokens
  - Random token generator
  - Status badge (Active/Inactive)
  - Edit mode protection

#### 5.8.3. AI Configuration Tab
- **Fields**:
  - OpenAI API Key 🔐 (secure input)
- **Features**:
  - Status badge (Active/Inactive)
  - Link to OpenAI Platform
  - Show/hide password toggle

#### 5.8.4. Shipping Configuration Tab
- **Fields**:
  - Komerce API Key 🔐 (secure input)
- **Features**:
  - Status badge (Optional)
  - Marked as optional feature
  - Show/hide password toggle

#### 5.8.5. Security Features
- **Secure Input Component**: Password-style masking with show/hide toggle (eye icon)
- **Edit Mode Protection**: Must click "Edit Configuration" before changes
- **Cancel Functionality**: Rollback changes without saving
- **Database Storage**: All settings stored in `app_settings` table with RLS
- **No Fallback**: Settings must be configured via dashboard (database-first approach)

### Technical Implementation

**Database Schema**:
- Extended `app_settings` table with new keys:
  - `whatsapp_access_token`
  - `whatsapp_phone_number_id`
  - `whatsapp_app_secret`
  - `openai_api_key`
  - `shipping_api_key`

**Components**:
- `SettingsTabs.tsx`: Tabs navigation component
- `SecureInput.tsx`: Reusable password input with show/hide
- `WebhookSettings.tsx`: Enhanced WhatsApp configuration (expanded)
- `AISettings.tsx`: OpenAI API key management
- `ShippingSettings.tsx`: Shipping API configuration
- `components/ui/tabs.tsx`: Radix UI tabs component

**Helper Functions** (`lib/settings/app-settings.ts`):
- `getWhatsAppAccessToken()` - Throws error if not configured
- `getWhatsAppPhoneNumberId()` - Throws error if not configured
- `getWhatsAppAppSecret()` - Returns null if not configured (optional)
- `getOpenAIApiKey()` - Throws error if not configured
- `getShippingApiKey()` - Returns null (optional)
- `isWhatsAppConfigured()` - Check all required WhatsApp fields
- `isAIConfigured()` - Check OpenAI key

**Server Actions** (`app/dashboard/settings/actions.ts`):
- `updateWebhookSettings()` - Save WhatsApp credentials
- `updateAISettings()` - Save OpenAI API key
- `updateShippingSettings()` - Save Shipping API key

**Backend Integration**:
All files updated to use database settings instead of environment variables:
- `lib/whatsapp/client.ts` - WhatsApp message sending
- `lib/whatsapp/security.ts` - Webhook signature verification
- `lib/ai/embedding.ts` - OpenAI embeddings
- `lib/ai/rag.ts` - RAG responses
- `app/api/webhook/whatsapp/route.ts` - Webhook handling

### Benefits
1. **No Redeploy**: Update credentials instantly without redeployment
2. **User Friendly**: Admin can manage settings via clean UI
3. **Secure**: Password masking, edit mode, RLS policies
4. **Organized**: Tabs group settings by category
5. **Simple**: Straightforward implementation, not overly complex
6. **Clear Status**: Visual badges for configuration status
7. **Flexible**: Easy to add more settings in the future

### Migration Process
1. Run `database/add_app_settings.sql` to create new settings
2. Run `database/migrate_env_to_settings.sql` to migrate existing env vars
3. Configure settings via `/dashboard/settings`
4. Optionally remove migrated env vars from `.env.local`

### Documentation
- **Implementation Guide**: `docs/SETTINGS_IMPLEMENTATION.md`
- **Migration Guide**: `docs/SETTINGS_MIGRATION.md`
- **Database Migrations**: `database/add_app_settings.sql`, `database/migrate_env_to_settings.sql`

## 5.9. Phase 5 - Order Management Flow (NEW - 2025-11-29)

### Overview
Enables AI to automatically create orders from WhatsApp conversations when customers provide sufficient information (product/service name, quantity, and delivery address). Orders are stored in the database and can be managed through an admin dashboard.

### Key Features

#### 5.9.1. AI-Driven Order Creation
- **Tag System**: AI generates hidden `[CREATE_ORDER: {...}]` tag in responses
- **Automatic Detection**: Backend parses tag and creates order in database
- **Tag Removal**: Tag is stripped from user-facing response
- **Validation**: Order data validated before insertion

#### 5.9.2. Database Schema
- **Table**: `orders` in Supabase
- **Fields**:
  - `id` (UUID): Unique order identifier
  - `customer_phone` (TEXT): Customer's WhatsApp number
  - `customer_name` (TEXT): Customer name
  - `items` (JSONB): Array of order items with name, quantity, price
  - `total_amount` (NUMERIC): Total order value
  - `delivery_info` (TEXT): Delivery address or service location
  - `order_type` (TEXT): 'product' or 'service'
  - `status` (TEXT): Order status (pending, paid, shipped, completed, cancelled)
  - `created_at`, `updated_at`: Timestamps
- **Foreign Key**: References `whatsapp_chats(phone_number)`
- **RLS**: Enabled for security

#### 5.9.3. Auto-Contact Creation
- **Smart Handling**: Creates new contact in `whatsapp_chats` if doesn't exist
- **Prevents Errors**: Avoids foreign key constraint violations
- **Default Name**: Sets "New Customer" for new contacts

#### 5.9.4. Admin Dashboard
- **Location**: `/dashboard/orders`
- **Features**:
  - Order list with real-time updates (Supabase subscriptions)
  - Status management dropdown
  - Display customer details, items, total, delivery info
  - Responsive table layout
  - Empty state handling

### Technical Implementation

**AI Logic** (`lib/ai/rag.ts`):
- Detects `[CREATE_ORDER]` tag using `indexOf`/`lastIndexOf` parsing
- Uses Service Role key for database operations (bypasses RLS)
- Validates order structure before insertion

**System Message**:
- Updated with order creation instructions
- AI generates order when user provides: product name, quantity, address
- Clear JSON format specification

**Order Format**:
```json
{
  "type": "product",
  "items": [
    {"name": "Kopi Arabica", "qty": 2, "price": 50000}
  ],
  "total_amount": 100000,
  "delivery_info": "Jl. Sudirman No 10, Jakarta"
}
```

### Configuration Required
- `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`
- OpenAI API Key configured in `/dashboard/settings`

### Benefits
1. **Automated**: No manual order entry needed
2. **Seamless**: Orders created during natural conversation
3. **Flexible**: Supports both products and services
4. **Trackable**: All orders stored and manageable in dashboard
5. **Real-time**: Instant updates via Supabase subscriptions

## 5.10. Phase 5 - Chat Memory (Conversation History) (NEW - 2025-11-29)

### Overview
Provides AI with conversation context by retrieving recent message history from the database. This prevents the AI from losing context and repeating questions, creating a more natural and efficient conversation flow.

### Key Features

#### 5.10.1. History Retrieval
- **Automatic**: Fetches last 10 messages before each AI response
- **Per-User**: Retrieves history specific to each phone number
- **Chronological**: Orders messages from oldest to newest
- **Lightweight**: Only 10 messages for performance

#### 5.10.2. AI Integration
- **Context-Aware**: AI receives full conversation history
- **No Repetition**: AI remembers names, addresses, products discussed
- **Natural Flow**: Conversations feel continuous and coherent

#### 5.10.3. Database Storage
- **Existing Table**: Uses `whatsapp_messages` table (already implemented)
- **User Messages**: Saved in webhook handler
- **AI Responses**: Saved in queue processor
- **Indexed**: Fast retrieval with `phone_number` and `created_at` indexes

### Technical Implementation

**Queue Processor** (`lib/whatsapp/queue-db.ts`):
```typescript
// Fetch recent conversation history (last 10 messages)
const { data: historyData } = await supabase
    .from('whatsapp_messages')
    .select('role, content')
    .eq('phone_number', job.phone_number)
    .order('created_at', { ascending: false })
    .limit(10);

// Reverse to chronological order
const history = (historyData || []).reverse().map(msg => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.content
}));

// Pass to AI
const aiResponse = await generateRAGResponse(
    job.message_text, 
    history, 
    job.phone_number
);
```

### Benefits
1. **Better UX**: Users don't need to repeat information
2. **Natural Conversations**: AI maintains context across messages
3. **Simple**: Uses existing database tables, no caching needed
4. **Fast**: Indexed queries, minimal overhead
5. **Reliable**: All history permanently stored in database

### Performance
- Query time: < 50ms (indexed)
- Memory usage: Minimal (10 messages × ~200 chars avg)
- No caching required: Direct database query


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
