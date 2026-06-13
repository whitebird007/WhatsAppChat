# How to update your Replit app from GitHub (read this carefully)

GitHub (`whitebird007/WhatsAppChat`) is now the **single source of truth** and
contains the complete, working app. Your Replit workspace may have its own
separate edits (e.g. made by Replit's AI agent). To avoid merge conflicts, the
safest path is to make Replit **match GitHub exactly**.

> ✅ Your live data is safe. `data.sqlite` (all your chats/contacts) and `auth/`
> (your WhatsApp login) are git-ignored, so the steps below **never touch them**.
> You will NOT have to re-scan the QR, and you won't lose any data.

---

## What's new in this update
1. **Voice messages now actually deliver.** Browser recordings are converted to
   true WhatsApp OGG/Opus format before sending (the reason they weren't arriving).
2. **Send & receive all media** — photos, videos, voice notes, documents — shown
   inline (image previews, audio players, download cards).
3. **Delivery status ticks** on every message you send:
   - 🕓 sending → ✓ sent to WhatsApp → ✓✓ delivered → ✓✓ (blue) read → ✕ failed
   - Now you can SEE whether WhatsApp actually accepted/delivered each message.
4. **Human-like AI replies** — the AI agent shows "typing…" and waits ~3–10s
   (scaled to message length) instead of replying instantly.

New dependency: **`ffmpeg-static`** (audio conversion) — installed by `npm install`.

---

## Steps in Replit

### Option A — sync to GitHub (recommended, conflict-free)
Open the **Shell** in Replit and run, one line at a time:

```bash
git fetch origin
git reset --hard origin/main
npm install
```

- `git reset --hard origin/main` makes Replit's code identical to GitHub.
  ⚠️ This **discards any edits made directly in Replit** (including changes by
  Replit's AI agent). That's intentional — everything important is already in this
  GitHub version, including the voice fix, delivery ticks, and the AI typing delay.
- `npm install` installs the new `ffmpeg-static` package.

Then click **Run** to test, and **Redeploy** to publish.

### Option B — keep Replit's edits too (advanced, may conflict)
Only if you have Replit-side changes you must keep:
```bash
git stash
git pull origin main
npm install
git stash pop   # may produce merge conflicts you'll have to resolve by hand
```
If you're not sure, use **Option A** — it's clean and you lose nothing meaningful.

---

## After updating
1. **Run** → confirm `Portal running…`.
2. Open the app — your WhatsApp should still be connected (no re-scan needed).
3. **Redeploy** (Reserved VM).
4. Send yourself a **voice message** and a **photo** from the app → confirm they
   arrive on your phone, and watch the tick turn ✓✓.

## If messages still don't deliver after this
The delivery ticks will tell us where it's failing:
- Stuck on ✓ (single tick) = WhatsApp received it but didn't deliver → connection
  or recipient issue.
- Shows ✕ = the send was rejected → send me a screenshot + the Replit logs.
- Never leaves 🕓 = the WhatsApp socket isn't connected → reconnect (scan QR).
</content>
