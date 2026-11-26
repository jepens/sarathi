# Testing WhatsApp Integration

This document provides comprehensive testing procedures for the WhatsApp integration.

## Test Scenarios

### 1. Webhook Verification Test

**Purpose**: Verify that Meta can successfully verify your webhook endpoint.

**Expected Result**: 
- Meta sends a GET request with verification parameters
- Your endpoint returns the challenge string
- Status: 200 OK

**How to Test Locally**:
```bash
curl "http://localhost:3000/api/webhook/whatsapp/<webhook_key>?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=test123"
```

**Expected Response**: `test123`

---

### 2. Message Reception Test

**Purpose**: Verify that incoming WhatsApp messages are received and processed.

**Test Payload**:
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "6281234567890",
          "type": "text",
          "text": {
            "body": "Halo, apa saja produk yang tersedia?"
          }
        }]
      }
    }]
  }]
}
```

**How to Test**: the webhook only accepts deliveries signed with the app
secret (X-Hub-Signature-256) for the app's own number, so an unsigned `curl`
now gets 403. Use the signed script, which reads `.env.local`. The server
uses its own credentials, so the test message is stored in its database and its
AI really tries to answer `TEST_PHONE`: use a number you own.
```bash
WEBHOOK_URL=http://localhost:3000/api/webhook/whatsapp/<webhook_key> TEST_PHONE=<your-number> node --env-file=.env.local scripts/test-webhook.js
```

**Expected Result**:
- Status: 200 OK
- Response: `EVENT_RECEIVED`
- Server logs show:
  - Message received
  - RAG processing started
  - WhatsApp API call attempted

---

### 3. AI Response Generation Test

**Purpose**: Verify that the AI generates appropriate responses based on Knowledge Base.

**Prerequisites**:
- At least one document uploaded to Knowledge Base
- OpenAI API key configured

**Test Cases**:

| User Message | Expected Behavior |
|--------------|-------------------|
| "Halo" | Greeting response |
| "Apa saja produk yang tersedia?" | List products or mention product info |
| "Berapa harga produk X?" | Price information if available in KB |
| "Random gibberish xyz123" | Polite "information not found" message |

---

### 4. WhatsApp API Send Test

**Purpose**: Verify that messages can be sent via WhatsApp Business API.

**Manual Test Script**:

Create `scripts/test-send-message.ts` and run it with a TypeScript runner that resolves the tsconfig `@/` paths. Put NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment, and set TEST_ORG_ID to an org whose number is in Vault (`scripts/wa-provision.mjs --phase=status` lists them; the credentials are read from Vault since Fase 2 task 2.2d):

```javascript
import { sendWhatsAppMessage } from '../lib/whatsapp/client.ts';
import { getOrgWhatsAppCreds } from '../lib/whatsapp/credentials.ts';

const orgId = process.env.TEST_ORG_ID; // an org whose number is in Vault
if (!orgId) throw new Error('Set TEST_ORG_ID to an org with a number in Vault (wa-provision.mjs --phase=status)');
const testNumber = '6281234567890'; // Replace with your test number
const testMessage = 'Halo! Ini adalah pesan test dari Sahabat UMKM.';

try {
    // Every send takes the credentials of one org's number (Fase 2 task 2.2b).
    const creds = await getOrgWhatsAppCreds(orgId);
    const result = await sendWhatsAppMessage(creds, testNumber, testMessage);
    console.log('✅ Message sent successfully:', result);
} catch (error) {
    console.error('❌ Failed to send message:', error);
}
```

**Expected Result**:
- Message appears in WhatsApp on the test number
- API returns success response

---

### 5. End-to-End Integration Test

**Purpose**: Test the complete flow from receiving a message to sending a reply.

**Steps**:
1. Send a real WhatsApp message to your test number
2. Verify webhook receives the message
3. Verify AI processes the query
4. Verify response is sent back
5. Verify response appears in WhatsApp

**Success Criteria**:
- ✅ Message received within 2 seconds
- ✅ AI response generated within 10 seconds
- ✅ Reply sent successfully
- ✅ Reply appears in user's WhatsApp

---

### 6. Dashboard Monitoring Test

**Purpose**: Verify that chats are visible and manageable in the admin dashboard.

**Steps**:
1. Navigate to `/dashboard/chats`
2. Send a message to the bot from a real phone
3. Verify the chat appears in the list
4. Click the chat to view history
5. Type a reply in the dashboard and send
6. Verify the reply is received on the phone

**Success Criteria**:
- ✅ Chat appears in list immediately (or after refresh)
- ✅ Message history is complete
- ✅ Admin reply is delivered successfully

---

## Automated Test Suite

Run the complete local test suite:

```bash
node scripts/test-whatsapp-local.mjs <webhook_key>
```

**This tests**:
- ✅ Webhook verification endpoint
- ✅ Message reception endpoint
- ✅ Basic payload processing

---

## Production Testing Checklist

Before going live:

- [ ] Webhook verified successfully in Meta Dashboard
- [ ] Test message sent and received
- [ ] AI responses are accurate and helpful
- [ ] Error handling works (test with invalid inputs)
- [ ] Rate limiting respected (if implemented)
- [ ] Logs are properly recorded
- [ ] No sensitive data leaked in responses
- [ ] Response time is acceptable (< 10s)

---

## Common Issues and Solutions

### Issue: Webhook verification fails
**Solution**: 
- The Callback URL must be the per-app URL `/api/webhook/whatsapp/<webhook_key>` (the bare URL answers 404)
- The Verify Token in Meta must be the one `scripts/wa-provision.mjs --phase=app` printed; if it is lost, run `--phase=rotate --kind=verify_token`
- Ensure URL is publicly accessible

### Issue: Messages received but no reply
**Solution**:
- Run `scripts/wa-provision.mjs --phase=verify --org=<org uuid>` (Vault token valid, number listed, app subscribed)
- Review server logs for API errors

### Issue: AI responses are irrelevant
**Solution**:
- Upload more relevant documents to Knowledge Base
- Improve document quality and structure
- Adjust RAG parameters (threshold, match_count)

### Issue: Timeout errors
**Solution**:
- Implement async processing with job queue
- Optimize embedding generation
- Cache frequently accessed data

---

## Performance Benchmarks

Target metrics:
- Webhook response time: < 200ms
- AI processing time: < 8s
- Total response time: < 10s
- Success rate: > 95%

---

**Last Updated**: 2025-11-28
