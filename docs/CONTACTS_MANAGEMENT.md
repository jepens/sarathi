## 5.7. Phase 5 - Contacts Management (NEW - 2025-11-29)

### Overview
Provides a centralized contact management system that automatically captures and displays WhatsApp user names. The AI assistant can automatically extract names from conversations, and administrators can manually edit contact names as needed.

### Key Features

#### 5.7.1. Database Schema
- **Table**: `whatsapp_chats` (existing table extended)
- **New Field**: 
  - `contact_name` (TEXT): Stores the friendly name for each contact
- **Foreign Key**: Referenced by `whatsapp_messages` table

#### 5.7.2. Automatic Name Extraction
- **AI-Driven**: The AI assistant automatically asks for the user's name during conversations
- **Tag-Based System**: Uses hidden `[UPDATE_NAME: ...]` tag in AI responses
- **Backend Processing**: 
  - Tag detected in `lib/ai/rag.ts`
  - Name extracted and saved to database
  - Tag removed from user-facing response
- **System Message Integration**: Default system message includes name extraction instructions

#### 5.7.3. Admin Interface
- **Location**: `/dashboard/contacts`
- **Features**:
  - Contact list with search functionality
  - Display: Name, Phone Number, Last Active timestamp
  - Manual edit via Dialog modal
  - Remove name functionality (preserves chat history)
  - User avatar icons
  - Responsive table layout

#### 5.7.4. Chat Integration
- **Chat List**: Displays contact name instead of phone number when available
- **Chat Window**: Shows contact name in header
- **Search Enhancement**: Search by both name and phone number
- **Real-time Updates**: Contact name changes reflect immediately in chat interface

### Technical Implementation

**Database Migration**:
```sql
ALTER TABLE whatsapp_chats 
ADD COLUMN IF NOT EXISTS contact_name TEXT;
```

**AI Integration** (`lib/ai/rag.ts`):
- `updateContactName()` helper function
- Regex pattern matching for `[UPDATE_NAME: ...]` tag
- Automatic database update when name detected
- Tag removal from final response

**System Message** (`lib/ai/system-message.ts`):
- Instructions for AI to ask for user's name
- Tag usage guidelines
- Example conversation flow

**Components**:
- `ContactList.tsx`: Main contact management interface
- `ChatList.tsx`: Updated to display contact names
- `ChatWindow.tsx`: Updated to show contact name in header

**UI Components Used**:
- Dialog (for edit/delete modals)
- Button, Input, Label (shadcn/ui)
- Toast notifications (sonner)

### User Flow

1. **Automatic Extraction**:
   ```
   User: "Halo"
   AI: "Halo! Boleh tahu dengan siapa saya bicara?"
   User: "Saya Budi"
   AI: "[UPDATE_NAME: Budi] Halo Kak Budi, ada yang bisa saya bantu?"
   → Backend saves "Budi" to database
   → User sees: "Halo Kak Budi, ada yang bisa saya bantu?"
   ```

2. **Manual Edit**:
   - Admin navigates to `/dashboard/contacts`
   - Clicks edit icon next to contact
   - Dialog opens with name input field
   - Saves changes → Updates database and UI

3. **Chat Display**:
   - Chat list shows "Budi" instead of "6281234567890"
   - Chat window header shows "Budi"
   - Search works with both name and number

### Benefits
1. **User Experience**: Personalized conversations with named contacts
2. **Admin Efficiency**: Quickly identify and manage contacts
3. **Automatic**: No manual data entry required for most contacts
4. **Fallback**: Manual edit available if AI extraction fails
5. **Non-Destructive**: Removing name preserves chat history
6. **Integration**: Seamlessly works with existing chat monitoring

### Security & Data Integrity
- **Foreign Key Constraint**: Prevents orphaned messages
- **Null-Safe**: System handles contacts without names gracefully
- **Update-Only Delete**: "Delete" action only removes name, not chat history
- **Authentication Required**: All contact operations require admin login

### Documentation
- **Migration Script**: `database/add_contact_name.sql`
- **Implementation Guide**: Included in verification walkthrough
- **System Message**: Default instructions in `lib/ai/system-message.ts`

---
