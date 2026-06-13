# How to update your Replit app from GitHub (read this carefully)

GitHub (`whitebird007/WhatsAppChat`) is the **single source of truth** and has the
complete, working app. To avoid merge conflicts, make Replit **match GitHub exactly**.

> ✅ Your data is safe. `data.sqlite` (chats/contacts) and `auth/` (your WhatsApp
> login) are git-ignored, so the steps below **never touch them**. You do NOT lose
> data. (You *may* need to re-scan the QR once — see note below.)

---

## What changed (latest version)
1. **Voice messages now deliver** — recordings are converted to true WhatsApp
   OGG/Opus before sending (via `ffmpeg-static`).
2. **Send & receive all media** — photos, video, voice notes, documents, shown inline.
3. **Delivery ticks** on sent messages: 🕓 sending → ✓ sent → ✓✓ delivered →
   ✓✓ (blue) read → ✕ failed.
4. **Delivery-failure banner** — if WhatsApp rejects a message, a red banner shows
   the error code (e.g. 463) with a plain-language reason.
5. **`getMessage` callback** — lets Baileys re-send on retry requests (a common cause
   of "looks sent but never arrives").
6. **Baileys upgraded to 7.0.0-rc13** — current WhatsApp protocol + proper `@lid` support.
7. **Reply in-thread, no JID conversion** — replies go to the exact address the
   customer used (`@lid` or phone), so WhatsApp sees a real reply, not a new
   conversation. This is the key delivery fix.
8. **No more duplicate chats** — messages are normalized by phone so one contact = one thread.
9. **Human-like AI replies** — shows "typing…" and waits ~3–10s instead of replying instantly.

New dependencies installed by `npm install`: **`ffmpeg-static`** + **`@whiskeysockets/baileys@7.0.0-rc13`**.

---

## Steps in Replit (the only commands you need)

Open the **Shell** and run these, one line at a time:

```bash
git fetch origin
git reset --hard origin/main
npm install
```

Then click **Run** to test, and **Redeploy** (Reserved VM) to publish.

- `git reset --hard origin/main` makes Replit identical to GitHub.
  ⚠️ This **discards any code edits made directly in Replit** (including changes by
  Replit's own AI agent). That is intentional — everything needed is already in
  this GitHub version.
- `npm install` installs the new packages.

> 🔑 **Rule going forward:** make ALL code changes through GitHub only. On Replit,
> just `git fetch` + `git reset --hard origin/main` + redeploy. Do **not** ask
> Replit's AI to edit the code — that's what causes conflicts.

---

## After updating — test in this order
1. **Replies (the real test):** have someone message your WhatsApp first, then reply
   from the app. It should deliver — watch the tick turn ✓✓.
2. **Voice & photo:** send a voice note and a photo in that same chat → confirm they arrive.
3. **Cold outbound (expected to be limited):** "New chat" to a number that never
   messaged you may still fail (463). That's a WhatsApp restriction on
   unofficial accounts, not a bug — reliable cold outbound needs the official Cloud API.

## Notes
- We upgraded the WhatsApp engine (Baileys 6 → 7). If the app shows "disconnected"
  after deploy, just **re-scan the QR once**. Chats/contacts are untouched.
- If a message fails, the red banner + ✕ tick now tell you the exact WhatsApp code.
</content>
