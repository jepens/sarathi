# WhatsApp Business API Integration Guide

Since Fase 2 (task 2.2d) the Sarathi team connects each client's WhatsApp number ("Dikelola tim Sarathi"). No WhatsApp credential is an environment variable of the app any more (only the optional switches `WHATSAPP_OTHER_NUMBER_EVENTS` and `WHATSAPP_DEBOUNCE_SECONDS` stay env, see `.env.example`):

- the app secret and the System User token live in Supabase Vault, stored with `scripts/wa-provision.mjs`;
- every Meta app has its own webhook URL, `https://<app domain>/api/webhook/whatsapp/<webhook_key>`, and its own verify token. The bare `/api/webhook/whatsapp` answers 404.

The full onboarding checklist for a new client (paperwork, Meta portfolio, templates, smoke test) is planned in step 16 of "Rollout (migration plan)" in `docs/FASE2_DESIGN.md`. Some phases it names (`sync`, `settings`) are not built yet; the phases below are the ones that exist.

## Prerequisites

1. **Meta assets**: a Business-type app with the WhatsApp product, a WhatsApp Business Account (WABA) and a verified number.
2. **System User**: an admin System User that has the app and the WABA assigned, with a permanent token that has `whatsapp_business_messaging` and `whatsapp_business_management`.
3. **The org** exists in Sarathi (you need its id).
4. **Operator `.env.local`** with `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_APP_URL` (used to print the callback URL).

## Step 1: Collect the IDs

These are not secret and go on the command line:

- **Meta app id**: App Dashboard → App settings → Basic
- **Phone Number ID** and **WABA id**: App Dashboard → WhatsApp → API Setup

The two secrets, the **app secret** (App settings → Basic) and the **System User token**, are typed only into the script's hidden prompt. Never put them in a file, an argument, an environment variable or a chat.

## Step 2: Database

The schema comes from `supabase/migrations` (see `supabase/README.md`). There is nothing to run by hand.

## Step 3: Provision the app and the number into Vault

Every writing phase is a dry-run without `--confirm`. The phases that take a secret (`app`, `rotate`) refuse to run without an interactive terminal.

```bash
# Read-only overview
node --env-file=.env.local scripts/wa-provision.mjs --expect-ref=<project ref> --phase=status

# The app: asks for the app secret and the System User token (hidden input)
node --env-file=.env.local scripts/wa-provision.mjs --expect-ref=<project ref> --phase=app --org=<org uuid> --meta-app-id=<digits>
node --env-file=.env.local scripts/wa-provision.mjs --expect-ref=<project ref> --phase=app --org=<org uuid> --meta-app-id=<digits> --confirm

# The number
node --env-file=.env.local scripts/wa-provision.mjs --expect-ref=<project ref> --phase=number --org=<org uuid> --phone-number-id=<digits> --waba-id=<digits> --display-phone=<text> --confirm
```

`--phase=app` prints the callback URL and the verify token. The verify token is shown **once**; keep the terminal open until Step 4 is done.

## Step 4: Configure the webhook in Meta

1. App Dashboard → WhatsApp → Configuration → **Edit** next to Webhook
2. Enter:
   - **Callback URL**: the URL `--phase=app` printed (`https://<app domain>/api/webhook/whatsapp/<webhook_key>`)
   - **Verify Token**: the token `--phase=app` printed
3. Click **Verify and Save**
4. Subscribe to webhook fields:
   - ✅ `messages` (required)
   - ✅ `user_id_update` (subscribe WHEN AVAILABLE) — keeps a contact threaded
     when they change number or adopt a WhatsApp username (Business-Scoped User
     ID / BSUID). Meta is still rolling this field out, so it may not appear in
     your Webhook Fields list yet — subscribe it once it does. The handler is
     already wired; until the field is available + subscribed, Meta doesn't
     deliver the event (BSUID-change continuity is simply inactive — low risk).
5. Subscribe the app to the WABA's webhooks: `--phase=subscribe --org=<org uuid>` (dry-run, then `--confirm`)

Do **not** turn on "Require App Secret" in the app's advanced settings (owner decision D33): Sarathi does not send `appsecret_proof` yet, so every send would fail.

## Step 5: Verify

```bash
node --env-file=.env.local scripts/wa-provision.mjs --expect-ref=<project ref> --phase=verify --org=<org uuid>
```

Read-only. With the Vault token and an `appsecret_proof` it checks that the number answers (which also proves the stored app secret belongs to the token's app), that the WABA lists the number, and that the app is subscribed. Then Settings → WhatsApp of the org shows "Dikelola tim Sarathi · Terhubung".

## Step 6: Test the Integration

### Local Test (Simulated)

Only for a separate test app on a local database (see `docs/DEBUGGING_TOOLS.md`): the script signs with that test app's `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` from your own `.env.local`. Never use it with a client's secrets; for a client, use `--phase=verify` and the live test below.

```bash
node scripts/test-whatsapp-local.mjs <webhook_key>
```

### Live Test (Real WhatsApp)

1. Send a message to the client's number from your personal WhatsApp
2. The bot should reply with an AI-generated response based on the Knowledge Base

## Rotating a Secret

```bash
node --env-file=.env.local scripts/wa-provision.mjs --expect-ref=<project ref> --phase=rotate --org=<org uuid> --kind=<app_secret|access_token|verify_token> --confirm
```

- **App secret**: reset it in the App Dashboard first, then store the new one here at once. Webhooks signed with the new secret fail until then; Meta retries them.
- **Access token**: Meta revokes System User tokens per System User (`DELETE /<system-user-id>/access_tokens` invalidates all of them), so revoking the old token that way also kills a new token of the same System User. The single-token `oauth/revoke` call needs the app secret and tokens in a URL: do not use it. For no gap, generate the new token from a second System User that has the app and the WABA assigned, rotate, run `--phase=verify`, and only then revoke the first System User's tokens. With one System User: revoke first, then at once generate the new token, rotate and verify; sends fail with `whatsapp_token_invalid` in between.
- **Verify token**: a new one is generated and shown once; enter it in the Meta webhook settings.

## Troubleshooting

### Webhook Verification Fails
- ✅ The Callback URL must carry the org's `webhook_key`; the bare `/api/webhook/whatsapp` answers 404
- ✅ The Verify Token must be the one `--phase=app` (or `--phase=rotate --kind=verify_token`) printed; if it is lost, rotate it
- ✅ Ensure the URL is publicly accessible (use ngrok for local testing)

### Bot Doesn't Reply
- ✅ Run `--phase=verify` (token valid, number listed, app subscribed)
- ✅ Check the ops alert emails (`whatsapp_token_invalid`, `whatsapp_not_configured`)
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
