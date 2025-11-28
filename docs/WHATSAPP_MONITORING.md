# WhatsApp Chat Monitoring - Feature Documentation

## Overview
The WhatsApp Chat Monitoring feature provides a dashboard interface for administrators to view and manage all WhatsApp conversations with customers. This feature enables real-time monitoring and manual intervention when needed.

## Features

### 1. Chat List
- **Location**: `/dashboard/chats`
- **Functionality**:
  - Displays all active conversations
  - Shows last message and timestamp
  - Search functionality to find specific chats
  - Real-time updates when new messages arrive
  - WhatsApp Web-inspired design

### 2. Chat Window
- **Functionality**:
  - View complete message history
  - Messages grouped by date
  - Displays user messages (white bubbles)
  - Displays AI responses (green bubbles)
  - Displays system messages (yellow bubbles for errors/warnings)
  - Auto-scroll to latest message
  - Real-time message updates

### 3. Admin Manual Reply
- **Functionality**:
  - Send manual messages to users from dashboard
  - Messages sent via WhatsApp Business API
  - Stored in database as 'assistant' role
  - Useful for:
    - Following up on conversations
    - Handling complex queries
    - Customer service escalation

## Database Schema

### `whatsapp_chats` Table
```sql
- phone_number (PRIMARY KEY)
- last_message
- last_message_at
- unread_count
- created_at
- updated_at
```

### `whatsapp_messages` Table
```sql
- id (UUID, PRIMARY KEY)
- phone_number (FOREIGN KEY)
- role ('user' | 'assistant' | 'system')
- content
- created_at
- metadata (JSONB)
```

## Implementation Details

### Message Flow
1. **Incoming Message**:
   - Webhook receives message → Stores in `whatsapp_messages` (role: 'user')
   - Updates `whatsapp_chats` with latest message
   - Enqueues for AI processing

2. **AI Response**:
   - Queue processor generates response
   - Sends via WhatsApp API
   - Stores in `whatsapp_messages` (role: 'assistant')
   - Updates `whatsapp_chats`

3. **Admin Reply**:
   - Admin types message in dashboard
   - Sent via `/api/chat/send`
   - Delivered to WhatsApp
   - Stored in `whatsapp_messages` (role: 'assistant')

### Real-time Updates
- Uses Supabase Realtime subscriptions
- Chat list updates when `whatsapp_chats` changes
- Chat window updates when new messages inserted
- No polling required

## UI/UX Design

### Colors (WhatsApp Web Theme)
- Background: `#efeae2` (chat area)
- Header: `#f0f2f5`
- User messages: `#ffffff` (white)
- AI messages: `#d9fdd3` (light green)
- System messages: `#ffeecd` (yellow)
- Text colors: `#111b21`, `#667781`, `#54656f`

### Components
- **ChatList**: Sidebar with search and conversation list
- **ChatWindow**: Main chat area with messages and input
- **Layout**: Split view (1/3 list, 2/3 window)

## Usage

### For Admins
1. Navigate to `/dashboard/chats`
2. Select a conversation from the list
3. View message history
4. Type a reply and press Enter or click Send
5. Message is delivered to user's WhatsApp

### For Developers
- **Database Setup**: Run `database/whatsapp_monitoring.sql`
- **Components**: Located in `app/dashboard/chats/components/`
- **API**: `/api/chat/send` for manual replies
- **Helper**: `lib/whatsapp/history.ts` for system messages

## Testing

### Manual Test
1. Send a message to the WhatsApp bot
2. Check `/dashboard/chats` - conversation should appear
3. Click the conversation to view history
4. Send a reply from dashboard
5. Verify reply is received on WhatsApp

### System Messages
- Rate limit exceeded: Yellow bubble in chat
- Processing errors: Yellow bubble with error details

## Security

### Current Implementation (MVP)
- RLS policies set to public for simplicity
- Webhook and cron jobs can write without auth
- Admin send API checks authentication

### Production Recommendations
- Restrict RLS policies to authenticated users
- Add role-based access control
- Implement audit logging
- Add message encryption at rest

## Future Enhancements
- [ ] Typing indicators
- [ ] Read receipts
- [ ] Message search within conversation
- [ ] Export chat history
- [ ] Conversation tags/labels
- [ ] Automated response templates
- [ ] Analytics dashboard

## Related Files
- `app/dashboard/chats/page.tsx` - Main page
- `app/dashboard/chats/components/ChatList.tsx` - Chat list
- `app/dashboard/chats/components/ChatWindow.tsx` - Chat window
- `app/api/chat/send/route.ts` - Admin send API
- `database/whatsapp_monitoring.sql` - Database schema
- `lib/whatsapp/history.ts` - System message helper

## Last Updated
2025-11-29
