# Sahabat UMKM - README

**AI-Powered Sales Assistant for Indonesian MSMEs**

Sahabat UMKM adalah asisten penjualan cerdas yang membantu UMKM Indonesia meningkatkan penjualan melalui WhatsApp dengan kekuatan AI.

## 🚀 Features

### ✅ Phase 1: Knowledge Base
- 📄 Upload dan kelola dokumen bisnis (TXT, MD)
- 🔍 Vector search untuk pencarian semantik
- 🤖 Auto-embedding dengan OpenAI
- 📊 Real-time statistics dashboard

### ✅ Phase 2: Chat Interface
- 💬 Web-based chat interface dengan Linear aesthetic
- 🧠 RAG (Retrieval Augmented Generation)
- 📚 Context-aware responses dari Knowledge Base
- 🔗 Source citations untuk transparansi

### ✅ Phase 3: Product Management
- 🛍️ Full CRUD untuk manajemen produk
- 🔢 Inventory tracking
- 🤖 Auto-embedding untuk AI product search
- ✨ Linear-style dashboard UI

### ✅ Phase 4: WhatsApp Integration
- 📱 WhatsApp Business Cloud API integration
- 🔄 Webhook untuk menerima dan membalas pesan
- 🧠 AI-powered responses menggunakan RAG
- ⚙️ Settings dashboard untuk monitoring status
- 🔒 **Production-Ready**:
  - Webhook signature verification
  - Rate limiting (10 msg/min per user)
  - Message queue with retry logic
  - Structured logging
- 📈 **Multi-Instance Scalable**:
  - Database-based state (Supabase)
  - Horizontal scaling support
  - No Redis needed

### ✅ Phase 5: Shipping Cost Integration
- 📦 **RajaOngkir API Integration**
  - Real-time shipping cost calculation
  - Multiple courier support (JNE, SiCepat, J&T, dll)
  - Automatic destination search
- 💬 **Integrated with Chat**
  - Natural language queries: "Berapa ongkir ke Bandung?"
  - Automatic intent detection
  - Smart city name extraction
  - No additional UI needed
- 🔧 **Easy Configuration**
  - Configurable origin, weight, couriers
  - Simple setup via environment variables
  - Production ready

--- 🛠️ Tech Stack

- **Frontend**: Next.js 14+ (App Router), Tailwind CSS, shadcn/ui
- **Backend**: Next.js API Routes (Serverless)
- **Database**: Supabase (PostgreSQL + Vector Storage)
- **AI**: OpenAI GPT-4o + Embeddings
- **Messaging**: WhatsApp Business Cloud API
- **Styling**: Linear-inspired dark mode design

## 📦 Installation

### Prerequisites
- Node.js 18+
- npm atau yarn
- Supabase account
- OpenAI API key
- WhatsApp Business API access (untuk Phase 4)

### Setup

1. **Clone repository**
```bash
git clone <repository-url>
cd sahabat-umkm
```

2. **Install dependencies**
```bash
npm install
```

3. **Setup environment variables**
```bash
cp .env.example .env.local
```

Edit `.env.local` dengan credentials Anda:
```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
OPENAI_API_KEY=your-openai-api-key
WHATSAPP_ACCESS_TOKEN=your-whatsapp-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_VERIFY_TOKEN=your-verify-token
SHIPPING_COST_KOMERCE_API_KEY=your-rajaongkir-api-key
```

4. **Setup database**

Jalankan SQL schema di Supabase SQL Editor:
```sql
-- Lihat file: database/schema.sql
```

5. **Run development server**
```bash
npm run dev
```

Buka [http://localhost:3000](http://localhost:3000)

## 📚 Documentation

### Setup & Configuration
- [WhatsApp Setup Guide](./docs/WHATSAPP_SETUP.md) - Panduan lengkap setup WhatsApp Business API
- [WhatsApp Testing Guide](./docs/WHATSAPP_TESTING.md) - Prosedur testing WhatsApp integration
- [VPS Deployment Guide](./docs/VPS_DEPLOYMENT.md) - Deploy ke VPS dengan Nixpacks
- [RajaOngkir Integration](./docs/RAJAONGKIR_INTEGRATION.md) - API documentation untuk shipping cost
- [Shipping Feature Guide](./docs/SHIPPING_FEATURE_GUIDE.md) - User & developer guide untuk fitur ongkir

### Production & Scaling
- [Production Enhancements](./docs/PRODUCTION_ENHANCEMENTS.md) - Security, rate limiting, queue, logging
- [Scalability Guide](./docs/SCALABILITY.md) - Multi-instance scaling dengan Supabase

### Project Status
- [Progress Report](./PROGRESS.md) - Development progress dan status
- [PRD](./PRD.md) - Product Requirements Document

--- 🧪 Testing

### Test WhatsApp Integration (Local)
```bash
node scripts/test-whatsapp-local.mjs
```

### Test Product API
```bash
node scripts/test-products.mjs
```

### Build for Production
```bash
npm run build
```

## 📱 WhatsApp Integration

Untuk mengaktifkan WhatsApp integration:

1. Ikuti panduan di [WHATSAPP_SETUP.md](./docs/WHATSAPP_SETUP.md)
2. Dapatkan credentials dari Meta for Developers
3. Update `.env.local` dengan credentials
4. Deploy atau gunakan ngrok untuk testing
5. Configure webhook di Meta Dashboard

## 🎨 Design System

Aplikasi ini menggunakan **Linear-inspired design**:
- Dark mode first
- Minimalist components
- Subtle borders dan glassmorphism
- Micro-interactions dengan Framer Motion
- Bento Grid layouts

Preview design system: [http://localhost:3000/design-system](http://localhost:3000/design-system)

## 📊 Project Structure

```
sahabat-umkm/
├── app/
│   ├── api/              # API routes
│   │   ├── chat/         # Web chat endpoint
│   │   ├── documents/    # Document management
│   │   ├── products/     # Product CRUD
│   │   └── webhook/      # WhatsApp webhook
│   └── dashboard/        # Dashboard pages
├── components/           # React components
├── lib/
│   ├── ai/              # AI utilities (RAG, embeddings)
│   ├── shipping/        # Shipping cost integration (RajaOngkir)
│   ├── supabase/        # Database clients
│   └── whatsapp/        # WhatsApp client
├── docs/                # Documentation
└── scripts/             # Test scripts
```

## 🚀 Deployment

### VPS with Nixpacks (Recommended)

**Why Nixpacks?**
- ✅ Auto-detect Next.js
- ✅ Zero configuration
- ✅ Modern & fast
- ✅ No Docker knowledge needed

**Quick Start:**
1. Push code to GitHub
2. Connect repo to VPS (Coolify/similar)
3. Select **Nixpacks** as build method
4. Set environment variables
5. Deploy!

**Detailed Guide**: [VPS_DEPLOYMENT.md](./docs/VPS_DEPLOYMENT.md)

### Alternative: Vercel
```bash
vercel deploy --prod
```

**Important**: 
- Set all environment variables in deployment platform
- Setup cron job for queue processing (see [VPS_DEPLOYMENT.md](./docs/VPS_DEPLOYMENT.md))

--- 🔐 Security Notes

- ⚠️ Jangan commit `.env.local` ke repository
- ✅ Gunakan System User token untuk production WhatsApp
- ✅ Implement rate limiting untuk production
- ✅ Review Supabase RLS policies sebelum production

## 📈 Roadmap

- [x] Phase 1: Knowledge Base
- [x] Phase 2: Chat Interface
- [x] Phase 3: Product Management
- [x] Phase 4: WhatsApp Integration (Core)
- [x] Phase 5: Advanced Features
  - [x] Product search via WhatsApp
  - [x] **Shipping cost calculation (RajaOngkir)** ✨ NEW!
  - [ ] Order management
  - [ ] Payment integration
  - [ ] Analytics dashboard

## 🤝 Contributing

Contributions are welcome! Please read the contributing guidelines first.

## 📄 License

[Your License Here]

## 💬 Support

Untuk pertanyaan atau bantuan, silakan buka issue di repository ini.

---

**Built with ❤️ for Indonesian MSMEs**
