# WhatsApp Business API Integration Guide

## Prerequisites

1. **Meta Developer Account**: https://developers.facebook.com/
2. **WhatsApp Business App** created in Meta for Developers
3. **Public URL** for webhook (use ngrok for local testing or deploy to production)

## Step 1: Get Your Credentials

### 1.1 Access Token
1. Go to your App Dashboard → WhatsApp → API Setup
2. Create a **System User** (recommended for production)
3. Generate a **Permanent Token** with `whatsapp_business_messaging` permission
4. Copy the token → This is your `WHATSAPP_ACCESS_TOKEN`

### 1.2 Phone Number ID
1. In the same API Setup page, you'll see your test phone number
2. Click on the phone number to see details
3. Copy the **Phone Number ID** (format: `668003893055590`)
4. This is your `WHATSAPP_PHONE_NUMBER_ID`

### 1.3 Verify Token
1. Create your own secure random string (e.g., `my_secure_token_12345`)
2. This is your `WHATSAPP_VERIFY_TOKEN`
3. You'll use this when configuring the webhook in Meta Dashboard

## Step 2: Database Setup

1. Open your Supabase Dashboard
2. Go to SQL Editor
3. Run the script from `database/whatsapp_monitoring.sql`
4. This creates the necessary tables for chat history and monitoring

## Step 3: Configure Environment Variables

Update your `.env.local`:

```env
WHATSAPP_ACCESS_TOKEN=your-actual-token-here
WHATSAPP_PHONE_NUMBER_ID=668003893055590
WHATSAPP_VERIFY_TOKEN=my_secure_token_12345
```

## Step 4: Deploy or Expose Your Webhook

### Option A: Local Testing with ngrok

```bash
# Install ngrok (if not already installed)
# Download from https://ngrok.com/

# Start your Next.js server
npm run dev

# In another terminal, expose port 3000
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

### Option B: Deploy to Production

Deploy to Vercel, Netlify, or your VPS. Get your production URL (e.g., `https://your-app.vercel.app`)

## Step 5: Configure Webhook in Meta Dashboard

1. Go to your App Dashboard → WhatsApp → Configuration
2. Click **Edit** next to Webhook
3. Enter your webhook details:
   - **Callback URL**: `https://your-url.com/api/webhook/whatsapp`
   - **Verify Token**: (the same token from your `.env.local`)
4. Click **Verify and Save**
5. Subscribe to webhook fields:
   - ✅ `messages` (required)

## Step 6: Test the Integration

### Local Test (Simulated)

```bash
node scripts/test-whatsapp-local.mjs
```

### Live Test (Real WhatsApp)

1. Send a message to your WhatsApp test number from your personal WhatsApp
2. The bot should reply with an AI-generated response based on your Knowledge Base

## Troubleshooting

### Webhook Verification Fails
- ✅ Check that `WHATSAPP_VERIFY_TOKEN` matches exactly in both `.env.local` and Meta Dashboard
- ✅ Ensure your webhook URL is publicly accessible (use ngrok for local testing)
- ✅ Check server logs for errors

### Bot Doesn't Reply
- ✅ Check that `WHATSAPP_ACCESS_TOKEN` is valid and has correct permissions
- ✅ Verify `WHATSAPP_PHONE_NUMBER_ID` is correct
- ✅ Check server logs for API errors
- ✅ Ensure you have documents in your Knowledge Base

### API Rate Limits
- Free tier has limited messages per day
- Upgrade to Business Account for production use

## Production Checklist

- [ ] Use System User token (not temporary token)
- [ ] Add proper error handling and logging
- [ ] Implement message queue for high volume (optional)
- [ ] Set up monitoring and alerts
- [ ] Review WhatsApp Business Policy compliance
- [ ] Test with multiple users
- [ ] Implement conversation state management (if needed)

## Next Steps

Once WhatsApp is working:
1. Add product search capabilities
2. Implement order flow
3. Add shipping cost calculation (RajaOngkir API)
4. Create conversation analytics

---

**Need Help?** Check the [Meta WhatsApp Business Platform Documentation](https://developers.facebook.com/docs/whatsapp)
