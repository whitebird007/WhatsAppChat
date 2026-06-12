# WhatsApp AI Portal — Phase 2 (Multi-tenant SaaS)

A self-hosted WhatsApp inbox — the same core model as TimelinesAI / DM Champ's Pro tier:

- **QR pairing**: connect any existing WhatsApp number via Linked Devices (no Business API approval needed)
- **Web inbox**: see and answer all customer chats from a browser portal
- **Keyword auto-replies**: instant canned responses ("price" → price list), free, run before AI
- **AI agent**: Claude or GPT replies using your business instructions, with per-chat toggle, handoff keywords, human-like delay, and an hourly rate limit
- **Live updates** over WebSocket

## Important: read this first

- This uses the **WhatsApp Web protocol (Baileys)**, not the official Business API. WhatsApp's terms don't permit automation on regular accounts, and numbers can get banned — every tool in this category (TimelinesAI's QR mode, DM Champ's WhatsApp Web tier, Wassenger) carries the same risk. **Test on a spare SIM/number first, not your main business number.**
- Keep volume human-like. The built-in AI rate limit and reply delay help, but bulk blasting will get a number flagged fast.
- Phase 2 is now built in: customer signup/login (JWT), one isolated WhatsApp session per customer, Stripe subscriptions (Starter $29 / Pro $49 / Agency $199), 7-day free trial, AI reply quotas per plan, and a premium animated landing page at /landing.html.

## Run it

Requirements: Node.js 18+, a server that stays on (any $5–6/mo VPS — Hetzner, DigitalOcean).

```bash
npm install
cp .env.example .env     # edit: set PORTAL_PASS and your AI API key
npm start
```

Open `http://your-server:3000`, log in with the user/pass from `.env`, and scan the QR with WhatsApp → Settings → Linked devices → Link a device.

For production, put it behind HTTPS (Caddy or nginx + Let's Encrypt) and run it with pm2:

```bash
npm i -g pm2
pm2 start src/server.js --name wa-portal
pm2 save && pm2 startup
```

## How the auto-reply pipeline works

Inbound customer message →
1. **Keyword rules** (Auto-replies tab) — first active match wins, sends instantly.
2. **AI agent** — only if the master switch (AI Settings) AND the per-chat toggle are both on. Uses the last 20 messages as context. Stays silent if the customer used a handoff keyword or the hourly limit is hit.

Group chats are ignored on purpose (MVP scope).

## Files

```
src/server.js     Express API + WebSocket + basic auth
src/whatsapp.js   Baileys session, QR, message pipeline
src/ai.js         Claude/GPT reply generation
src/rules.js      Keyword matcher
src/db.js         SQLite schema + queries
public/           The portal UI (no build step)
```

## Phase 2 roadmap (turning this into the SaaS)

1. **Multi-tenant**: one Baileys session per customer (session manager keyed by tenant id), Postgres instead of SQLite, proper auth (email + password, JWT).
2. **Billing**: Stripe subscriptions — e.g. $29 Starter / $49 Pro / $199 Agency (white-label).
3. **Funnels**: multi-step flows (welcome → qualify → book) on top of the rules engine.
4. **Official API upgrade path**: let customers graduate to the WhatsApp Business API (via a BSP) when they outgrow QR mode — this is the de-risking move.
5. **Urdu/Roman Urdu presets**: shipped system prompts per industry (boutique, clinic, property dealer) — the differentiator nobody else has.


## Phase 2: what's new

- **Multi-tenant**: each customer gets an isolated WhatsApp session (`auth/<tenant-id>/`), isolated chats, rules, and AI settings. Sessions auto-resume on server restart.
- **Auth**: signup/login at `/login.html`, scrypt password hashing, 30-day JWT tokens. Set a strong `JWT_SECRET` in `.env`.
- **Billing**: Stripe Checkout + customer portal + webhooks.
  1. In the Stripe dashboard, create three recurring products and copy their price IDs into `.env`.
  2. Add a webhook endpoint pointing to `https://yourdomain.com/webhooks/stripe` with events: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
- **Plans & quotas**: trial 100 AI replies, Starter 500/mo, Pro 3,000/mo, Agency unlimited. Keyword rules are unlimited everywhere. Expired trial = inbox still readable, automation off.
- **Landing page**: `/landing.html` — animated chat demo hero, scroll motion, pricing, FAQ. Point your root domain at it (or rename it `index.html` on your marketing host) and run the app on `app.yourdomain.com`.

## Hero image

A Higgsfield-generated hero render was created for the brand. To use it as background art, save it to `public/assets/hero.jpg` and add it to the hero section's CSS — or keep the animated chat demo as the hero visual (it converts better because it shows the product working).


## Phase 3: flows, integrations, conversation pricing

**Conversation-based quotas (new pricing model).** A "conversation" = one unique customer chat that used any automation (flow, rule, or AI) in a calendar month. Replies inside a counted conversation are unlimited (the hourly fair-use limit still applies). Trial 50 / Starter 300 / Pro 1,500 / Agency unlimited conversations per month. This matches how Meta itself bills and feels far more generous than reply-counting.

**Flow builder (Flows tab).** Visual node sequences like Make.com modules: Trigger keyword → Message → Question with branches (match on customer reply) → Message / Handoff to human / AI agent / End. Branches can loop back (e.g. show the menu again). Flows run FIRST in the pipeline, then keyword rules, then the AI. Abandoned flows expire after 24h. Definitions are validated server-side.

**Integrations (Integrations tab).**
- *Outgoing webhook*: POSTs `message.received` and `handoff.requested` events to any https URL — paste a Make.com Custom Webhook URL and every WhatsApp message can drive a Make scenario (CRM, Sheets, Slack...).
- *Send API*: `POST /api/v1/send` with `X-API-Key` header and `{ "to": "923001234567", "text": "..." }` — lets Make.com (HTTP module), Zapier, or any backend send WhatsApp messages through the connected number.

**In-app guide.** A 4-step animated onboarding tour (scan QR → teach the AI → rules → flows) with motion-graphic SVG illustrations, auto-shown on first login and reopenable any time from "✦ Guide" in the sidebar.

### Automation pipeline order
Inbound message → outgoing webhook fires → conversation quota check → 1) Flows → 2) Keyword rules → 3) AI agent.
