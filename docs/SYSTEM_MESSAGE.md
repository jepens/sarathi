# System Message Configuration

## Overview

The System Message feature allows administrators to configure the AI persona and behavior for Sahabat UMKM without modifying code. This provides flexibility to adapt the AI's character, tone, and conversation flow based on business needs.

## Features

- **Dynamic Configuration**: Change AI persona from admin dashboard
- **Database-Driven**: System messages stored in Supabase for easy management
- **Version Control**: Track when system messages were last updated
- **Multiple Profiles**: Support for multiple system message configurations (only one active at a time)
- **Real-time Updates**: Changes apply immediately to new conversations

## Architecture

### Database Schema

Table: `system_message`

```sql
- id: UUID (primary key)
- name: VARCHAR(100) (unique identifier, e.g., 'default', 'sales', 'support')
- content: TEXT (the actual system message/prompt)
- is_active: BOOLEAN (only one can be active at a time)
- description: TEXT (description of this system message)
- created_at: TIMESTAMPTZ
- updated_at: TIMESTAMPTZ
```

### Components

1. **Database Layer** (`database/system_message_schema.sql`)
   - Table structure
   - Trigger to ensure single active message
   - Default system message insert

2. **API Layer** (`app/api/system-message/route.ts`)
   - GET: Fetch active or specific system message
   - PUT: Update system message content or activate different profile
   - POST: Create new system message configuration

3. **Service Layer** (`lib/ai/system-message.ts`)
   - Helper function to retrieve active system message
   - Fallback to default if none found
   - Used by RAG engine

4. **UI Layer** (`app/dashboard/settings/components/SystemMessageEditor.tsx`)
   - Admin interface for editing system messages
   - **Template Selection**: Dropdown with presets (Default, UMKM Produk, UMKM Jasa)
   - Real-time preview of changes
   - Save/Reset functionality

### Integration with RAG

The RAG engine (`lib/ai/rag.ts`) automatically fetches the active system message from the database before generating responses:

```typescript
// Old approach (hardcoded)
const systemPrompt = `Anda adalah asisten AI...`;

// New approach (dynamic from database)
const baseSystemMessage = await getActiveSystemMessage();
const systemPrompt = `${baseSystemMessage}\n\nKonteks:\n${contextText}`;
```

## Usage

### For Administrators

1. Navigate to **Dashboard → Settings**
2. Scroll to **AI System Message** section
3. Edit the system message content in the textarea
4. Click **Save Changes** when done
5. Changes apply immediately to new conversations

### For Developers

#### Get Active System Message

```typescript
import { getActiveSystemMessage } from '@/lib/ai/system-message';

const systemMessage = await getActiveSystemMessage();
```

#### Create New System Message Profile

```typescript
const response = await fetch('/api/system-message', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'support',
    content: 'You are a helpful support assistant...',
    description: 'Customer support persona',
    is_active: false, // Set to true to activate immediately
  }),
});
```

#### Update Existing System Message

```typescript
const response = await fetch('/api/system-message', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 'uuid-here',
    content: 'Updated system message content...',
  }),
});
```

#### Activate Different Profile

```typescript
const response = await fetch('/api/system-message', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 'uuid-of-profile-to-activate',
    is_active: true,
  }),
});
```

## Default System Message

The default system message for Sahabat UMKM includes:

- **Identity**: AI sales assistant for Indonesian MSMEs
- **Goals**: Help customers find products, provide info, calculate shipping, guide purchases
- **Communication Rules**: Friendly, polite, use "Kak", concise, no bullet lists
- **Conversation Flow**: Greeting → Product Inquiry → Shipping → Checkout → Payment
- **Special Handling**: Out of stock, product not found, incomplete information

## Best Practices

1. **Be Specific**: Clearly define AI's role and objectives
2. **Use Structure**: Organize system message with headers and sections
3. **Provide Examples**: Include example responses for common scenarios
4. **Test Thoroughly**: Test changes in chat before deploying to WhatsApp
5. **Keep Context Separate**: System message defines behavior, context provides data
6. **Version History**: Keep backup of working system messages before major changes

## Template Presets
 
 The editor includes 3 built-in templates to quickly configure the AI for different business types:
 
 1. **Default**: General purpose assistant. Handles products, documents, and shipping.
 2. **UMKM Produk**: Specialized for selling physical goods.
    - Focuses on product details, stock, and shipping.
    - Sales flow: Greeting → Needs → Product Info → Shipping → Closing.
 3. **UMKM Jasa**: Specialized for service-based businesses.
    - Focuses on service details, packages, and consultation.
    - Sales flow: Greeting → Needs → Service Info → Packages → Closing.
    - Removes shipping logic.
 
 ## Example System Messages

### Sales-Focused

```markdown
## Identitas
Anda adalah Sahabat UMKM, asisten penjualan AI yang ramah dan persuasif.

## Tujuan
- Bantu pelanggan menemukan produk yang tepat
- Dorong konversi penjualan dengan teknik upselling
- Berikan pengalaman berbelanja yang menyenangkan

## Gaya Komunikasi
- Ramah dan antusias
- Gunakan emoji dengan bijak 😊
- Fokus pada manfaat produk
```

### Support-Focused

```markdown
## Identitas
Anda adalah Sahabat UMKM, asisten customer support yang helpful dan sabar.

## Tujuan
- Membantu pelanggan menyelesaikan masalah
- Memberikan informasi yang akurat
- Memastikan kepuasan pelanggan

## Gaya Komunikasi
- Sabar dan empati
- Jelaskan langkah demi langkah
- Hindari jargon teknis
```

## Troubleshooting

### System Message Not Loading

Check:
1. Database connection to Supabase
2. Table `system_message` exists
3. At least one message has `is_active = true`
4. API endpoint `/api/system-message` is accessible

### Changes Not Applying

- System messages are fetched per request
- Try refreshing the page
- Check if the correct message is marked as active
- Review browser console for errors

### Fallback Behavior

If system message cannot be loaded from database:
- RAG engine uses hardcoded fallback message
- No error shown to user
- Error logged in server console

## Migration

To set up the system message feature:

```bash
# Run SQL migration in Supabase SQL Editor
# File: database/system_message_schema.sql
```

This will:
- Create `system_message` table
- Create trigger for single active message
- Insert default system message
- Set up indexes

## Security Considerations

- Only admins should access Settings page
- Input validation on API endpoints
- SQL injection protected by Supabase client
- No user-facing exposure of system message content

## Future Enhancements

- [ ] A/B testing different system messages
- [ ] Analytics on system message performance
- [ ] Template library for common use cases
- [ ] Version history and rollback capability
- [ ] Multi-language support
- [ ] Role-based system messages (sales vs support)
