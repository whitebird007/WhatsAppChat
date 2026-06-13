# Deploying Zaply to Replit

This app is **stateful**: it stores data in a SQLite file (`data.sqlite`) and keeps
your WhatsApp login in `auth/`, and it holds a long-lived WhatsApp socket +
WebSockets to the browser.

➡️ **You MUST deploy as a "Reserved VM" deployment** (persistent disk, always-on).
**Do NOT use "Autoscale"** — Autoscale is stateless and scales to zero, which would
**wipe your database, disconnect WhatsApp, and break live chat.**

Also required: **Node ≥ 22.5** (the app uses the built-in `node:sqlite`). `.replit`
already requests `nodejs-22`.

---

## Option A — Update via GitHub (recommended)

Cleanest, and lets you push future updates with one command.

1. **Push this project to GitHub from your computer**
   ```bash
   cd whatsapp-ai-portal
   git init
   git add .
   git commit -m "Zaply v0.2 — full feature build"
   git branch -M main
   # create an EMPTY repo on github.com first, then:
   git remote add origin https://github.com/<you>/inboxai.git
   git push -u origin main
   ```
   `.gitignore` already excludes `node_modules`, `.env`, `data.sqlite*`, and `auth/`,
   so your secrets and data are never uploaded.

2. **Bring it into Replit** — two ways:
   - **Fresh Repl (simplest, recommended since so much changed):**
     Replit → *Create Repl* → *Import from GitHub* → pick your repo. Then go to step 3.
   - **Update the existing v1 Repl in place:** open the Repl → *Git* pane (or Shell) →
     `git pull`. If it refuses because v1 wasn't a git repo, the fresh-Repl route is easier.

3. Continue to **"Common steps"** below.

---

## Option B — Upload to the existing Repl (no GitHub)

1. On your computer, make a zip of the project **without** `node_modules`, `.env`,
   `data.sqlite*`, and `auth/`.
2. In the existing Repl, open the **Files** panel → ⋮ → *Upload folder/zip* and let it
   overwrite the old files. **Do not delete or overwrite** the Repl's existing
   `auth/` and `data.sqlite` if you want to keep its current WhatsApp connection/data.
3. Continue to **"Common steps"** below.

---

## Common steps (both options)

### 1. Install dependencies
Open the **Shell** in Replit:
```bash
npm install
```

### 2. Set Secrets  (Tools → Secrets — NOT a committed .env)
| Key | Value |
|---|---|
| `JWT_SECRET` | a random string — run `openssl rand -hex 32` |
| `SUPER_ADMIN_EMAILS` | the email you'll sign up with (gives you the `/admin.html` panel) |
| `OPENAI_API_KEY` | *(optional)* global AI key — you can also set this later in the Admin panel |
| `TRIAL_DAYS` | e.g. `7` |
| `STRIPE_SECRET_KEY` etc. | *(optional)* only if you charge agencies for the app itself |

Don't set `PORT` — Replit provides it.

### 3. Run it once to test
Press **Run**. You should see `Portal running...`. Open the webview, sign up with the
email you put in `SUPER_ADMIN_EMAILS`, then connect WhatsApp by scanning the QR.

### 4. Deploy (publish)
1. Click **Deploy** (top right).
2. Choose **Reserved VM** (NOT Autoscale).
3. Build command: `npm install`  ·  Run command: `npm start`
4. Pick the smallest VM size to start; you can scale later.
5. Deploy. You'll get a `https://<name>.replit.app` URL.
6. Set the `BASE_URL` secret to that URL (used for Stripe redirects/links) and redeploy.

### 5. After deploy
- Open the deployed URL, **log in**, and **re-scan the WhatsApp QR** (a deployment is a
  fresh machine, so it needs to link WhatsApp once).
- Your super-admin account sees **Admin Panel** in the org-switcher menu → opens `/admin.html`.

---

## Custom domain (optional, for white-label)
In the Deployment → **Settings → Custom domain**, add your domain and follow the DNS
instructions. For per-agency white-label login pages, point each agency's domain (CNAME)
at the deployment and set that domain in the agency's **Branding** page.

---

## Updating again later
- **GitHub route:** `git add . && git commit -m "update" && git push`, then in Replit
  `git pull` and click **Redeploy**.
- Your `data.sqlite` and `auth/` are git-ignored, so updates never touch live data.
- The database **migrates itself** on boot (new tables/columns are added automatically),
  so upgrading is safe.

---

## Troubleshooting
- **`SQLite is an experimental feature` warning** — harmless, ignore it.
- **`DatabaseSync is not a constructor` / sqlite errors on boot** — Replit is running
  Node < 22.5. Make sure `.replit` has `modules = ["nodejs-22"]` and the Repl restarted.
  If a high-enough Node isn't available, switch the DB driver to `better-sqlite3`
  (small change in `src/db.js`) — ask and it can be swapped.
- **WhatsApp keeps disconnecting / data resets** — you deployed as Autoscale. Redeploy as
  **Reserved VM**.
- **Logo/branding uploads disappear** — same cause; needs the persistent disk of a Reserved VM.
</content>
