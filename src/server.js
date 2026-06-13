import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import { q, getSetting, convQuota, tenantActive, PLANS, getPlans, newId, LIFECYCLE_LABELS, ensureStages, DATA_DIR } from "./db.js";
import { validateFlow } from "./flows.js";
import { signup, login, authMiddleware, verifyToken, createOrganization, switchOrg, hashPassword, verifyPassword, signToken } from "./auth.js";
import {
  startSession, stopSession, getSessionStatus,
  sendText, sendMedia, sendToPhone, onEvent, resumeAllSessions,
  isConnected, connectedCount,
} from "./sessions.js";
import { createCheckout, createPortal, webhookHandler, billingEnabled } from "./billing.js";
import { improveMessage, suggestReplies, summarizeChat, learnOwnerStyle, learnChatBehaviour, learnChatBehaviourFromExport, draftAgentField, learnOwnerStyleFromExports, testAgentReply } from "./ai.js";
import { packSummary, installPack } from "./packs.js";
import QRCode from "qrcode";
import {
  startAutomationScheduler, onAutomationEvent,
  enrollInSequence, onLifecycleChange,
} from "./automation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Must be set before any route/middleware so the router compiles with it:
// keeps "/app" (serves the app) and "/app/" (redirect) distinct.
app.enable("strict routing");

// Multer for file uploads (memory storage, 20 MB limit)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Stripe webhook needs the raw body — mount BEFORE express.json()
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), webhookHandler);

app.use(express.json({ limit: "10mb" }));

const PUBLIC_DIR = path.join(__dirname, "..", "public");
// Marketing landing page is the public root; the app lives at /app.
// index:false stops express.static from auto-serving index.html (the app) at "/".
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "landing.html")));
app.get("/app/", (req, res) => res.redirect(301, "/app"));
app.get("/app", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// Per-tenant uploads (chat media + contact avatars) are PRIVATE. They live under
// public/media/<tenant>/ and public/avatars/<tenant>/, but must never be readable
// by another org. Since <img>/<audio> tags can't send an Authorization header, the
// token is passed as ?t=<jwt>; we verify it and confirm the caller is a member of
// that exact tenant before serving the file. This route is registered BEFORE
// express.static, so static never serves these paths unauthenticated.
const SAFE = /^[a-z0-9._-]+$/i;
app.get("/:kind(media|avatars)/:tenant/:file", (req, res) => {
  const { kind, tenant, file } = req.params;
  if (!SAFE.test(tenant) || !SAFE.test(file) || file.includes("..")) return res.status(400).end();
  const payload = req.query.t && verifyToken(String(req.query.t));
  if (!payload) return res.status(401).end();
  if (!q.getMembership.get(payload.uid, tenant)) return res.status(403).end();
  const base = process.env.DATA_DIR ? DATA_DIR : PUBLIC_DIR;
  res.sendFile(path.join(base, kind, tenant, file));
});
app.use(express.static(PUBLIC_DIR, { index: false }));

/* ============================================================
   PUBLIC ROUTES
   ============================================================ */
app.post("/api/auth/signup", (req, res) => {
  try {
    const { token, tenant } = signup(req.body || {});
    res.json({ token, tenant: publicTenant(tenant) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const { token, tenant } = login(req.body || {});
    res.json({ token, tenant: publicTenant(tenant) });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

/* Public branding lookup — lets a white-label login page theme itself by domain */
app.get("/api/branding/public", (req, res) => {
  const host = String(req.query.host || "").toLowerCase().replace(/:\d+$/, "");
  const row = host ? q.settingByKeyValue.get("brand_custom_domain", host) : null;
  if (!row) return res.json(brandingDefaults());
  res.json(brandingFor(row.tenant_id));
});

/* ============================================================
   PUBLIC REST API (API-key auth — Make.com / Zapier / n8n)
   ============================================================ */

/** Send a WhatsApp message */
app.post("/api/v1/send", async (req, res) => {
  const tenant = apiKeyAuth(req);
  if (!tenant) return res.status(401).json({ error: "Invalid API key" });
  if (!tenantActive(tenant)) return res.status(402).json({ error: "Subscription inactive" });
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: "'to' and 'text' required" });
  try {
    await sendToPhone(tenant.id, to, text, "api");
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Get chat list */
app.get("/api/v1/chats", (req, res) => {
  const tenant = apiKeyAuth(req);
  if (!tenant) return res.status(401).json({ error: "Invalid API key" });
  const chats = q.listChats.all(tenant.id);
  res.json(chats);
});

/** Get messages for a chat */
app.get("/api/v1/chats/:jid/messages", (req, res) => {
  const tenant = apiKeyAuth(req);
  if (!tenant) return res.status(401).json({ error: "Invalid API key" });
  const jid = decodeURIComponent(req.params.jid);
  res.json(q.listMessages.all(tenant.id, jid));
});

/** Update chat lifecycle */
app.patch("/api/v1/chats/:jid", (req, res) => {
  const tenant = apiKeyAuth(req);
  if (!tenant) return res.status(401).json({ error: "Invalid API key" });
  const jid = decodeURIComponent(req.params.jid);
  if (req.body?.lifecycle) q.setChatLifecycle.run(req.body.lifecycle, tenant.id, jid);
  res.json({ ok: true });
});

/**
 * Inbound webhook — accepts data from other apps (Make.com, Zapier, etc.)
 * and sends a WhatsApp message to the specified phone number.
 *
 * POST /api/v1/inbound  (X-API-Key header required)
 * Body: { to: "+17162145420", message: "Your appointment is confirmed for..." }
 * Or for custom data: { to: "+17162145420", template: "appointment_confirm", data: {...} }
 */
app.post("/api/v1/inbound", async (req, res) => {
  const tenant = apiKeyAuth(req);
  if (!tenant) return res.status(401).json({ error: "Invalid API key" });
  if (!tenantActive(tenant)) return res.status(402).json({ error: "Subscription inactive" });

  const { to, message, template_name, data } = req.body || {};
  if (!to) return res.status(400).json({ error: "'to' phone number is required" });

  // Log the webhook event
  q.logWebhookEvent.run(newId(), tenant.id, JSON.stringify(req.body), Date.now());

  let text = message;

  // If a template name was specified, find and populate it
  if (!text && template_name) {
    const templates = q.listTemplates.all(tenant.id);
    const tpl = templates.find((t) => t.name === template_name || t.shortcut === template_name);
    if (tpl) {
      text = tpl.body;
      if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data)) {
          text = text.replaceAll(`{{${k}}}`, v);
        }
      }
    }
  }

  if (!text) return res.status(400).json({ error: "'message' or valid 'template_name' required" });

  try {
    await sendToPhone(tenant.id, to, text, "api");
    res.json({ ok: true, to });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Public e-commerce abandoned-cart webhook (API-key auth) — sends a WhatsApp recovery message */
app.post("/api/v1/ecommerce/abandoned-cart", async (req, res) => {
  const tenant = apiKeyAuth(req);
  if (!tenant) return res.status(401).json({ error: "Invalid API key" });
  if (!tenantActive(tenant)) return res.status(402).json({ error: "Subscription inactive" });
  const { phone, name, cart_value, currency, checkout_url, items } = req.body || {};
  if (!phone) return res.status(400).json({ error: "'phone' required" });
  const first = String(name || "there").split(" ")[0];
  const cur = (currency || "USD").toUpperCase();
  const lines = [
    `Hi ${first}! 👋 You left some items in your cart${items ? ` (${items})` : ""}.`,
    cart_value ? `Your cart total: ${cur} ${Number(cart_value).toLocaleString()}` : "",
    checkout_url ? `\nComplete your order here:\n${checkout_url}` : "",
    `\nNeed help? Just reply here and we'll sort it out. 🛍`,
  ].filter(Boolean);
  try {
    await sendToPhone(tenant.id, phone, lines.join("\n"), "human");
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ============================================================
   AUTHENTICATED ROUTES
   ============================================================ */
app.use("/api", authMiddleware);

app.get("/api/me", (req, res) => {
  res.json({
    user: { id: req.user.id, email: req.user.email, name: req.user.name, is_admin: !!req.user.is_admin },
    role: req.role,
    tenant: publicTenant(req.tenant),
    orgs: q.listOrgsForUser.all(req.user.id).map(publicOrg),
    branding: brandingFor(req.tenant.id),
    quota: convQuota(req.tenant),
    active: tenantActive(req.tenant),
    billingEnabled: billingEnabled(),
  });
});

/* ============================================================
   WHITE-LABEL BRANDING
   ============================================================ */
app.get("/api/branding", (req, res) => res.json(brandingFor(req.tenant.id)));

app.post("/api/branding", (req, res) => {
  if (!["owner", "admin"].includes(req.role)) return res.status(403).json({ error: "Only owners/admins can change branding" });
  const b = req.body || {};
  const set = (k, v) => q.setSetting.run(req.tenant.id, k, String(v ?? ""));
  if ("app_name" in b) set("brand_app_name", b.app_name);
  if ("hue" in b) set("brand_hue", b.hue);
  if ("login_subtitle" in b) set("brand_login_subtitle", b.login_subtitle);
  if ("powered_by" in b) set("brand_powered_by", b.powered_by ? "1" : "0");
  if ("custom_domain" in b) set("brand_custom_domain", String(b.custom_domain || "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  res.json({ ok: true, branding: brandingFor(req.tenant.id) });
});

app.post("/api/branding/logo", upload.single("file"), (req, res) => {
  if (!["owner", "admin"].includes(req.role)) return res.status(403).json({ error: "Only owners/admins can change branding" });
  if (!req.file) return res.status(400).json({ error: "No image provided" });
  const dir = path.join(__dirname, "..", "public", "branding");
  fs.mkdirSync(dir, { recursive: true });
  const ext = (req.file.mimetype.split("/")[1] || "png").replace("svg+xml", "svg").replace(/[^a-z0-9]/gi, "") || "png";
  const file = `${req.tenant.id}.${ext}`;
  // clear older logo variants for this org
  try { for (const f of fs.readdirSync(dir)) if (f.startsWith(req.tenant.id + ".")) fs.rmSync(path.join(dir, f)); } catch {}
  fs.writeFileSync(path.join(dir, file), req.file.buffer);
  const url = `/branding/${file}?v=${Date.now()}`;
  q.setSetting.run(req.tenant.id, "brand_logo", url);
  res.json({ ok: true, logo: url });
});

app.delete("/api/branding/logo", (req, res) => {
  if (!["owner", "admin"].includes(req.role)) return res.status(403).json({ error: "Only owners/admins can change branding" });
  q.setSetting.run(req.tenant.id, "brand_logo", "");
  res.json({ ok: true });
});

/* ============================================================
   SUPER-ADMIN PANEL (application owner)
   ============================================================ */
// Seed the admin passcode from env on first boot (optional convenience).
if (process.env.ADMIN_PASSCODE && !q.getApp.get("admin_passcode_hash")?.value) {
  q.setApp.run("admin_passcode_hash", hashPassword(process.env.ADMIN_PASSCODE));
}

// Two-factor gate for the admin console:
//   1) the user must be a super-admin (is_admin), AND
//   2) they must have unlocked this session with the admin passcode.
// The unlock / status endpoints need only (1) so the admin can authenticate.
app.use("/api/admin", (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: "Admin access only" });
  if (req.path === "/unlock" || req.path === "/lock-status") return next();
  const tok = req.headers["x-admin-token"];
  const p = tok && verifyToken(tok);
  if (!p || !p.admin_unlock || p.uid !== req.user.id) {
    return res.status(401).json({ error: "Admin locked", code: "ADMIN_LOCKED" });
  }
  next();
});

// Whether an admin passcode has been set yet (first-time setup vs login)
app.get("/api/admin/lock-status", (req, res) => {
  res.json({ passcodeSet: !!q.getApp.get("admin_passcode_hash")?.value });
});

// Unlock the admin console. First time (no passcode set) creates one.
app.post("/api/admin/unlock", (req, res) => {
  const { passcode, newPasscode } = req.body || {};
  const stored = q.getApp.get("admin_passcode_hash")?.value;
  const issue = () => res.json({ token: signToken({ uid: req.user.id, admin_unlock: true }, 60 * 60 * 8) });
  if (!stored) {
    if (!newPasscode || newPasscode.length < 6) return res.status(400).json({ error: "Choose an admin passcode of at least 6 characters." });
    q.setApp.run("admin_passcode_hash", hashPassword(newPasscode));
    return issue();
  }
  if (!passcode || !verifyPassword(passcode, stored)) return res.status(401).json({ error: "Incorrect admin passcode." });
  issue();
});

// Change the admin passcode (already unlocked)
app.post("/api/admin/passcode", (req, res) => {
  const { currentPasscode, newPasscode } = req.body || {};
  const stored = q.getApp.get("admin_passcode_hash")?.value;
  if (stored && (!currentPasscode || !verifyPassword(currentPasscode, stored))) {
    return res.status(401).json({ error: "Current passcode is incorrect." });
  }
  if (!newPasscode || newPasscode.length < 6) return res.status(400).json({ error: "New passcode must be at least 6 characters." });
  q.setApp.run("admin_passcode_hash", hashPassword(newPasscode));
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => res.json({ admin: true, email: req.user.email, name: req.user.name }));

app.get("/api/admin/overview", (req, res) => {
  const now = Date.now(), day = 86400000;
  const planRows = q.countTenantsByPlan.all();
  const plansCfg = getPlans();
  const byPlan = {}; let mrr = 0;
  for (const r of planRows) {
    byPlan[r.plan] = r.n;
    const price = plansCfg[r.plan]?.price || 0;
    if (r.plan !== "trial") mrr += price * r.n;
  }
  const recent = q.recentTenants.all().map((t) => {
    const owner = q.ownerOfOrg.get(t.id);
    return { id: t.id, name: t.business_name, plan: t.plan, status: t.status, created: t.created, owner: owner?.email || "—" };
  });
  res.json({
    agencies: q.countAllTenants.get().n,
    users: q.countAllUsers.get().n,
    activeSessions: countConnectedSessions(),
    mrr,
    byPlan,
    plans: plansCfg,
    recent,
    signups: q.signupsSince.all(now - 30 * day),
  });
});

app.get("/api/admin/orgs", (req, res) => {
  const orgs = q.allTenants.all().map((t) => {
    const owner = q.ownerOfOrg.get(t.id);
    return {
      id: t.id, name: t.business_name || "Untitled", plan: t.plan, status: t.status,
      trial_ends: t.trial_ends, created: t.created,
      owner: owner?.email || "—", ownerId: owner?.id || null,
      members: q.memberCountOrg.get(t.id).n,
      messages: q.msgCountOrg.get(t.id).n,
      chats: q.chatCountOrg.get(t.id).n,
      connected: isSessionConnected(t.id),
    };
  });
  res.json(orgs);
});

app.post("/api/admin/orgs/:id/status", (req, res) => {
  const status = ["active", "suspended"].includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: "status must be active or suspended" });
  q.setStatus.run(status, req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/orgs/:id/plan", (req, res) => {
  const plan = req.body?.plan;
  if (!getPlans()[plan]) return res.status(400).json({ error: "Unknown plan" });
  q.setPlan.run(plan, q.tenantById.get(req.params.id)?.stripe_sub_id || null, req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/orgs/:id/impersonate", (req, res) => {
  const owner = q.ownerOfOrg.get(req.params.id);
  if (!owner) return res.status(404).json({ error: "No owner found for this organization" });
  try {
    const { token } = switchOrg(owner.id, req.params.id);
    res.json({ ok: true, token });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete("/api/admin/orgs/:id", (req, res) => {
  q.deleteOrgMembers.run(req.params.id);
  q.deleteTenant.run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/admin/users", (req, res) => {
  res.json(q.allUsers.all().map((u) => ({
    id: u.id, email: u.email, name: u.name, is_admin: !!u.is_admin, created: u.created,
    orgs: q.listOrgsForUser.all(u.id).length,
  })));
});

app.post("/api/admin/users/:id/admin", (req, res) => {
  if (req.params.id === req.user.id && !req.body?.is_admin) return res.status(400).json({ error: "You can't remove your own admin access" });
  q.setUserAdmin.run(req.body?.is_admin ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.get("/api/admin/plans", (req, res) => res.json(getPlans()));
app.post("/api/admin/plans", (req, res) => {
  const plans = req.body?.plans;
  if (!plans || typeof plans !== "object") return res.status(400).json({ error: "plans object required" });
  // normalize unlimited → -1 for storage
  const out = {};
  for (const k of Object.keys(plans)) {
    out[k] = {
      label: String(plans[k].label || k),
      price: Number(plans[k].price) || 0,
      convPerMonth: plans[k].convPerMonth === "unlimited" || plans[k].convPerMonth == null || Number(plans[k].convPerMonth) < 0 ? -1 : Number(plans[k].convPerMonth),
    };
  }
  q.setApp.run("plans", JSON.stringify(out));
  res.json({ ok: true, plans: getPlans() });
});

app.get("/api/admin/settings", (req, res) => {
  const g = (k) => q.getApp.get(k)?.value || "";
  const mask = (v) => v ? v.slice(0, 6) + "••••" + v.slice(-4) : "";
  res.json({
    global_openai_key_set: !!g("global_openai_key"),
    global_openai_key_hint: mask(g("global_openai_key")),
    global_anthropic_key_set: !!g("global_anthropic_key"),
    default_trial_days: g("default_trial_days") || String(process.env.TRIAL_DAYS || 7),
    signups_enabled: g("signups_enabled") !== "0",
  });
});
app.post("/api/admin/settings", (req, res) => {
  const b = req.body || {};
  if (typeof b.global_openai_key === "string" && b.global_openai_key.trim()) q.setApp.run("global_openai_key", b.global_openai_key.trim());
  if (b.clear_openai_key) q.setApp.run("global_openai_key", "");
  if (typeof b.global_anthropic_key === "string" && b.global_anthropic_key.trim()) q.setApp.run("global_anthropic_key", b.global_anthropic_key.trim());
  if (b.default_trial_days != null) q.setApp.run("default_trial_days", String(parseInt(b.default_trial_days, 10) || 7));
  if ("signups_enabled" in b) q.setApp.run("signups_enabled", b.signups_enabled ? "1" : "0");
  res.json({ ok: true });
});

/* ============================================================
   ORGANIZATIONS & TEAM
   ============================================================ */
// List organizations the logged-in user belongs to
app.get("/api/orgs", (req, res) => {
  res.json(q.listOrgsForUser.all(req.user.id).map(publicOrg));
});

// Create a new organization (the creator becomes its owner)
app.post("/api/orgs", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Organization name required" });
  const org = createOrganization(req.user.id, name);
  const { token } = switchOrg(req.user.id, org.id); // hand back a token already scoped to the new org
  res.json({ ok: true, org: publicOrg({ ...org, member_role: "owner" }), token });
});

// Switch the active organization → returns a fresh token
app.post("/api/orgs/switch", (req, res) => {
  try {
    const { token, tenant, role } = switchOrg(req.user.id, req.body?.orgId);
    res.json({ ok: true, token, org: publicOrg({ ...tenant, member_role: role }) });
  } catch (err) { res.status(403).json({ error: err.message }); }
});

// Rename the current organization (owner/admin)
app.patch("/api/orgs/current", (req, res) => {
  if (!["owner", "admin"].includes(req.role)) return res.status(403).json({ error: "Only owners/admins can rename" });
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name required" });
  q.renameOrg.run(name, req.tenant.id);
  res.json({ ok: true });
});

// ── Team members of the current org ──
app.get("/api/orgs/members", (req, res) => {
  res.json(q.listMembersForOrg.all(req.tenant.id));
});

// Add a teammate: creates their login (or attaches an existing user) and grants access
app.post("/api/orgs/members", (req, res) => {
  if (!["owner", "admin"].includes(req.role)) return res.status(403).json({ error: "Only owners/admins can add members" });
  let email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const role = ["admin", "agent"].includes(req.body?.role) ? req.body.role : "agent";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Valid email required" });

  let user = q.userByEmail.get(email);
  if (!user) {
    if (!password || password.length < 8) return res.status(400).json({ error: "New members need a password of at least 8 characters" });
    const uid = newId();
    q.createUser.run(uid, email, hashPassword(password), null, Date.now());
    user = q.userById.get(uid);
  }
  if (q.getMembership.get(user.id, req.tenant.id)) return res.status(409).json({ error: "That person is already a member" });
  q.addMember.run(user.id, req.tenant.id, role, Date.now());
  res.json({ ok: true });
});

// Change a member's role (owner only)
app.patch("/api/orgs/members/:userId", (req, res) => {
  if (req.role !== "owner") return res.status(403).json({ error: "Only the owner can change roles" });
  const role = ["owner", "admin", "agent"].includes(req.body?.role) ? req.body.role : null;
  if (!role) return res.status(400).json({ error: "Invalid role" });
  if (!q.getMembership.get(req.params.userId, req.tenant.id)) return res.status(404).json({ error: "Not a member" });
  q.setMemberRole.run(role, req.params.userId, req.tenant.id);
  res.json({ ok: true });
});

// Remove a member (owner/admin). Can't remove the last owner or yourself if last owner.
app.delete("/api/orgs/members/:userId", (req, res) => {
  if (!["owner", "admin"].includes(req.role)) return res.status(403).json({ error: "Only owners/admins can remove members" });
  const target = q.getMembership.get(req.params.userId, req.tenant.id);
  if (!target) return res.status(404).json({ error: "Not a member" });
  if (target.role === "owner" && q.countOwners.get(req.tenant.id).n <= 1)
    return res.status(400).json({ error: "Can't remove the last owner" });
  q.removeMember.run(req.params.userId, req.tenant.id);
  res.json({ ok: true });
});

/* --- WhatsApp session --- */
app.get("/api/status", (req, res) => res.json(getSessionStatus(req.tenant.id)));

app.post("/api/connect", async (req, res) => {
  if (!tenantActive(req.tenant)) return res.status(402).json({ error: "Trial expired — upgrade to connect" });
  try { await startSession(req.tenant.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/logout", async (req, res) => {
  await stopSession(req.tenant.id, { logout: true });
  res.json({ ok: true });
});

/* --- Chats --- */
app.get("/api/chats", (req, res) => {
  const unreadOnly = req.query.unread === "1";
  const chats = unreadOnly
    ? q.listUnreadChats.all(req.tenant.id)
    : q.listChats.all(req.tenant.id);
  // Attach tags to each chat
  const withTags = chats.map((c) => ({
    ...c,
    tags: q.listChatTags.all(req.tenant.id, c.jid).map((r) => r.tag),
  }));
  res.json(withTags);
});

app.get("/api/messages", (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: "jid required" });
  q.clearUnread.run(req.tenant.id, jid);
  res.json(q.listMessages.all(req.tenant.id, jid));
});

app.post("/api/send", async (req, res) => {
  const { jid, text } = req.body || {};
  if (!jid || !text) return res.status(400).json({ error: "jid and text required" });
  try { await sendText(req.tenant.id, jid, text, "human"); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/* Send to arbitrary phone number (creates new chat) */
app.post("/api/send-to-phone", async (req, res) => {
  const { phone, text } = req.body || {};
  if (!phone || !text) return res.status(400).json({ error: "phone and text required" });
  try { await sendToPhone(req.tenant.id, phone, text, "human"); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/* Send media attachment (set voice=1 for a true WhatsApp voice message) */
app.post("/api/send-media", upload.single("file"), async (req, res) => {
  const { jid, caption, voice } = req.body || {};
  if (!jid || !req.file) return res.status(400).json({ error: "jid and file required" });
  try {
    const isVoice = voice === "1" || voice === "true";
    const mime = isVoice ? "audio/ogg; codecs=opus" : req.file.mimetype;
    await sendMedia(req.tenant.id, jid, req.file.buffer, mime, req.file.originalname, caption || "", isVoice);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* AI message improvement */
app.post("/api/ai/improve", async (req, res) => {
  const { draft, jid } = req.body || {};
  if (!draft) return res.status(400).json({ error: "draft required" });
  try {
    const improved = await improveMessage(req.tenant.id, draft, jid || null);
    if (!improved) return res.status(503).json({ error: "AI unavailable — check your API key in AI Agents" });
    res.json({ improved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// AI-assist for authoring an agent's instructions / playbook / rules
app.post("/api/ai/draft-agent-field", async (req, res) => {
  const { field, draft, agentName } = req.body || {};
  if (!["instructions", "playbook", "rules", "style"].includes(field)) return res.status(400).json({ error: "invalid field" });
  try {
    const text = await draftAgentField(req.tenant.id, { field, draft: draft || "", agentName: agentName || "" });
    if (!text) return res.status(503).json({ error: "AI unavailable — check your API key" });
    res.json({ text });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Learn a writing style from uploaded chat files WITHOUT persisting it —
// used by the agent modal to fill a specific agent's style field.
app.post("/api/ai/learn-style-from-files", upload.array("files", 20), async (req, res) => {
  const texts = (req.files || []).map((f) => f.buffer.toString("utf8")).filter((t) => t.trim());
  if (!texts.length) return res.status(400).json({ error: "Upload at least one chat .txt file." });
  try {
    const { style, imported } = await learnOwnerStyleFromExports(req.tenant.id, texts, req.body?.ownerName || "");
    res.json({ style, imported });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* Chat settings */
app.post("/api/chats/ai", (req, res) => {
  const { jid, enabled } = req.body || {};
  if (!jid) return res.status(400).json({ error: "jid required" });
  // enabled -> opt-in (ai_enabled=1, clear opt-out); disabled -> hard opt-out
  // (ai_off=1) so it stays off even when "AI on all chats" is active.
  q.setChatAiState.run(enabled ? 1 : 0, enabled ? 0 : 1, req.tenant.id, jid);
  res.json({ ok: true });
});

// Global "AI on every chat" switch (sleep mode). When on, every chat is
// answered except those individually opted out. Per-chat opt-outs persist.
app.post("/api/ai/all-chats", (req, res) => {
  q.setSetting.run(req.tenant.id, "ai_all_chats", req.body?.enabled ? "1" : "0");
  res.json({ ok: true, enabled: !!req.body?.enabled });
});

/* Delete a conversation (and its messages, tags, notes) from the portal.
   Note: this only removes it here — it does not delete anything on WhatsApp. */
app.delete("/api/chats/:jid", (req, res) => {
  const jid = req.params.jid;
  const t = req.tenant.id;
  q.deleteChatMessages.run(t, jid);
  q.deleteChatTagsAll.run(t, jid);
  q.deleteChatNotesAll.run(t, jid);
  q.deleteChatRow.run(t, jid);
  res.json({ ok: true });
});

app.post("/api/chats/lifecycle", (req, res) => {
  const { jid, lifecycle } = req.body || {};
  if (!jid || !lifecycle) return res.status(400).json({ error: "jid and lifecycle required" });
  const valid = Object.keys(LIFECYCLE_LABELS);
  if (!valid.includes(lifecycle)) return res.status(400).json({ error: `lifecycle must be one of: ${valid.join(", ")}` });
  q.setChatLifecycle.run(lifecycle, req.tenant.id, jid);
  // Trigger any follow-up sequences set to fire on this lifecycle stage
  try { onLifecycleChange(req.tenant.id, jid, lifecycle); } catch {}
  res.json({ ok: true });
});

app.post("/api/chats/agent", (req, res) => {
  const { jid, agent_id } = req.body || {};
  if (!jid) return res.status(400).json({ error: "jid required" });
  q.setChatAgent.run(agent_id || null, req.tenant.id, jid);
  res.json({ ok: true });
});

/* --- Tags --- */
app.get("/api/tags", (req, res) => {
  res.json(q.allTags.all(req.tenant.id).map((r) => r.tag));
});

app.get("/api/chats/:jid/tags", (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  res.json(q.listChatTags.all(req.tenant.id, jid).map((r) => r.tag));
});

app.post("/api/chats/:jid/tags", (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const { tag } = req.body || {};
  if (!tag) return res.status(400).json({ error: "tag required" });
  q.addChatTag.run(req.tenant.id, jid, tag.trim().toLowerCase());
  res.json({ ok: true });
});

app.delete("/api/chats/:jid/tags/:tag", (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  q.removeChatTag.run(req.tenant.id, jid, req.params.tag);
  res.json({ ok: true });
});

/* --- Notes --- */
app.get("/api/chats/:jid/notes", (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  res.json(q.listNotes.all(req.tenant.id, jid));
});

app.post("/api/chats/:jid/notes", (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: "body required" });
  q.addNote.run(req.tenant.id, jid, body, Date.now());
  res.json({ ok: true });
});

app.delete("/api/notes/:id", (req, res) => {
  q.deleteNote.run(req.params.id, req.tenant.id);
  res.json({ ok: true });
});

/* --- Rules --- */
app.get("/api/rules", (req, res) => res.json(q.listRules.all(req.tenant.id)));
app.post("/api/rules", (req, res) => {
  const { keyword, reply, match_type } = req.body || {};
  if (!keyword || !reply) return res.status(400).json({ error: "keyword and reply required" });
  const allowed = ["contains", "exact", "starts"];
  q.addRule.run(req.tenant.id, keyword, reply, allowed.includes(match_type) ? match_type : "contains");
  res.json({ ok: true });
});
app.post("/api/rules/:id/toggle", (req, res) => {
  q.toggleRule.run(req.body?.active ? 1 : 0, req.params.id, req.tenant.id);
  res.json({ ok: true });
});
app.delete("/api/rules/:id", (req, res) => {
  q.deleteRule.run(req.params.id, req.tenant.id);
  res.json({ ok: true });
});

/* --- Settings --- */
app.get("/api/settings", (req, res) => {
  const t = req.tenant.id;
  res.json({
    ai_global_enabled: getSetting(t, "ai_global_enabled"),
    ai_all_chats: getSetting(t, "ai_all_chats"),
    ai_system_prompt: getSetting(t, "ai_system_prompt"),
    ai_handoff_keywords: getSetting(t, "ai_handoff_keywords"),
  });
});
app.post("/api/settings", (req, res) => {
  const allowed = ["ai_global_enabled", "ai_all_chats", "ai_system_prompt", "ai_handoff_keywords"];
  for (const key of allowed) {
    if (key in (req.body || {})) q.setSetting.run(req.tenant.id, key, String(req.body[key]));
  }
  res.json({ ok: true });
});

/* --- AI Agents --- */
app.get("/api/agents", (req, res) => res.json(q.listAgents.all(req.tenant.id)));

// Live-test an agent (even unsaved) from the create/edit form
app.post("/api/agents/test", async (req, res) => {
  const { instructions, playbook, rules, model, openai_api_key, writing_style, messages } = req.body || {};
  try {
    const reply = await testAgentReply(req.tenant.id, { instructions, playbook, rules, model, openai_api_key, writing_style }, messages || []);
    if (!reply) return res.status(503).json({ error: "AI unavailable — check your API key" });
    res.json({ reply });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/agents", (req, res) => {
  const { name, emoji, instructions, playbook, rules, model, openai_api_key, writing_style } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  q.addAgent.run(
    req.tenant.id, name, emoji || "🤖",
    instructions || "", playbook || "", rules || "",
    model || "gpt-4o-mini", openai_api_key || "", writing_style || "", Date.now()
  );
  res.json({ ok: true });
});

app.put("/api/agents/:id", (req, res) => {
  const { name, emoji, instructions, playbook, rules, model, openai_api_key, writing_style } = req.body || {};
  // Keep the saved API key if the form sent a blank one (key fields are never pre-filled)
  const existing = q.getAgent.get(req.params.id, req.tenant.id);
  const key = (openai_api_key && openai_api_key.trim()) ? openai_api_key : (existing?.openai_api_key || "");
  q.updateAgent.run(
    name, emoji || "🤖",
    instructions || "", playbook || "", rules || "",
    model || "gpt-4o-mini", key, writing_style || "",
    req.params.id, req.tenant.id
  );
  res.json({ ok: true });
});

app.post("/api/agents/:id/toggle", (req, res) => {
  q.toggleAgent.run(req.body?.active ? 1 : 0, req.params.id, req.tenant.id);
  res.json({ ok: true });
});

app.delete("/api/agents/:id", (req, res) => {
  q.deleteAgent.run(req.params.id, req.tenant.id);
  res.json({ ok: true });
});

/* --- Knowledge Sources --- */
app.get("/api/knowledge", (req, res) => res.json(q.listKnowledge.all(req.tenant.id)));

app.post("/api/knowledge", upload.single("file"), (req, res) => {
  const { agent_id } = req.body || {};
  if (!req.file) return res.status(400).json({ error: "file required" });
  // Accept text files, PDFs (text extracted), or plain text body
  const content = req.file.buffer.toString("utf-8");
  q.addKnowledge.run(req.tenant.id, agent_id ? parseInt(agent_id) : null, req.file.originalname, content, Date.now());
  res.json({ ok: true, file_name: req.file.originalname });
});

app.delete("/api/knowledge/:id", (req, res) => {
  q.deleteKnowledge.run(req.params.id, req.tenant.id);
  res.json({ ok: true });
});

/* --- Templates --- */
app.get("/api/templates", (req, res) => res.json(q.listTemplates.all(req.tenant.id)));

app.post("/api/templates", (req, res) => {
  const { name, shortcut, body } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: "name and body required" });
  q.addTemplate.run(req.tenant.id, name, shortcut || "", body);
  res.json({ ok: true });
});

app.put("/api/templates/:id", (req, res) => {
  const { name, shortcut, body } = req.body || {};
  q.updateTemplate.run(name, shortcut || "", body, req.params.id, req.tenant.id);
  res.json({ ok: true });
});

app.delete("/api/templates/:id", (req, res) => {
  q.deleteTemplate.run(req.params.id, req.tenant.id);
  res.json({ ok: true });
});

/* --- Flows --- */
app.get("/api/flows", (req, res) => {
  res.json(q.listFlows.all(req.tenant.id).map((f) => ({ ...f, definition: JSON.parse(f.definition) })));
});
app.post("/api/flows", (req, res) => {
  const { name, trigger_keyword, definition } = req.body || {};
  if (!name || !trigger_keyword) return res.status(400).json({ error: "name and trigger_keyword required" });
  const errors = validateFlow(definition);
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });
  const info = q.addFlow.run(req.tenant.id, name, trigger_keyword, JSON.stringify(definition), Date.now());
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.put("/api/flows/:id", (req, res) => {
  const { name, trigger_keyword, definition } = req.body || {};
  const errors = validateFlow(definition);
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });
  q.updateFlow.run(name, trigger_keyword, JSON.stringify(definition), req.params.id, req.tenant.id);
  res.json({ ok: true });
});
app.post("/api/flows/:id/toggle", (req, res) => {
  q.toggleFlow.run(req.body?.active ? 1 : 0, req.params.id, req.tenant.id);
  res.json({ ok: true });
});
app.delete("/api/flows/:id", (req, res) => {
  q.deleteFlow.run(req.params.id, req.tenant.id);
  res.json({ ok: true });
});

/* --- Follow-up Sequences --- */
app.get("/api/sequences", (req, res) => {
  const seqs = q.listSequences.all(req.tenant.id).map((s) => ({
    ...s,
    steps: q.listSequenceSteps.all(s.id),
    active_enrollments: q.countActiveEnrollments.get(req.tenant.id, s.id).n,
  }));
  res.json(seqs);
});

app.post("/api/sequences", (req, res) => {
  const { name, trigger_type, trigger_value, steps } = req.body || {};
  if (!name || !Array.isArray(steps) || !steps.length) {
    return res.status(400).json({ error: "name and at least one step required" });
  }
  const info = q.addSequence.run(req.tenant.id, name, trigger_type || "manual", trigger_value || "", Date.now());
  const seqId = info.lastInsertRowid;
  steps.forEach((s, i) => q.addSequenceStep.run(seqId, i, parseInt(s.delay_minutes, 10) || 0, String(s.body || "")));
  res.json({ ok: true, id: seqId });
});

app.put("/api/sequences/:id", (req, res) => {
  const { name, trigger_type, trigger_value, steps } = req.body || {};
  const seq = q.getSequence.get(req.params.id, req.tenant.id);
  if (!seq) return res.status(404).json({ error: "Not found" });
  q.updateSequence.run(name, trigger_type || "manual", trigger_value || "", req.params.id, req.tenant.id);
  if (Array.isArray(steps)) {
    q.deleteSequenceSteps.run(req.params.id);
    steps.forEach((s, i) => q.addSequenceStep.run(req.params.id, i, parseInt(s.delay_minutes, 10) || 0, String(s.body || "")));
  }
  res.json({ ok: true });
});

app.post("/api/sequences/:id/toggle", (req, res) => {
  q.toggleSequence.run(req.body?.active ? 1 : 0, req.params.id, req.tenant.id);
  res.json({ ok: true });
});

app.delete("/api/sequences/:id", (req, res) => {
  q.deleteSequence.run(req.params.id, req.tenant.id);
  q.deleteSequenceSteps.run(req.params.id);
  res.json({ ok: true });
});

/* Manually enroll a chat into a sequence */
app.post("/api/sequences/:id/enroll", (req, res) => {
  const { jid } = req.body || {};
  if (!jid) return res.status(400).json({ error: "jid required" });
  const ok = enrollInSequence(req.tenant.id, parseInt(req.params.id, 10), jid);
  res.json({ ok, message: ok ? "Enrolled" : "Already enrolled or sequence has no steps" });
});

/* --- Broadcast Campaigns --- */
app.get("/api/broadcasts", (req, res) => res.json(q.listBroadcasts.all(req.tenant.id)));

/* Preview how many recipients a segment resolves to */
app.post("/api/broadcasts/preview", (req, res) => {
  const { segment_type, segment_value } = req.body || {};
  res.json({ count: resolveSegment(req.tenant.id, segment_type, segment_value).length });
});

app.post("/api/broadcasts", (req, res) => {
  const { name, body, segment_type, segment_value, send_now } = req.body || {};
  if (!body || !segment_type) return res.status(400).json({ error: "body and segment_type required" });
  const recipients = resolveSegment(req.tenant.id, segment_type, segment_value);
  if (!recipients.length) return res.status(400).json({ error: "No recipients match this segment" });

  const info = q.addBroadcast.run(req.tenant.id, name || "Broadcast", body, segment_type, segment_value || "", Date.now());
  const bId = info.lastInsertRowid;
  for (const r of recipients) q.addBroadcastRecipient.run(bId, req.tenant.id, r.jid, r.name || null);
  q.setBroadcastTotal.run(recipients.length, bId);
  if (send_now) q.setBroadcastStatus.run("sending", bId, req.tenant.id);
  res.json({ ok: true, id: bId, total: recipients.length });
});

app.post("/api/broadcasts/:id/start", (req, res) => {
  q.setBroadcastStatus.run("sending", req.params.id, req.tenant.id);
  res.json({ ok: true });
});
app.post("/api/broadcasts/:id/pause", (req, res) => {
  q.setBroadcastStatus.run("paused", req.params.id, req.tenant.id);
  res.json({ ok: true });
});
app.delete("/api/broadcasts/:id", (req, res) => {
  q.deleteBroadcast.run(req.params.id, req.tenant.id);
  q.deleteBroadcastRecipients.run(req.params.id);
  res.json({ ok: true });
});

/* --- Analytics --- */
app.get("/api/analytics", (req, res) => {
  const tid = req.tenant.id;
  const now = Date.now();
  const day = 86400000;
  const since7 = now - 7 * day;
  const since30 = now - 30 * day;
  const since14 = now - 14 * day;

  // Lifecycle funnel
  const lcRows = q.anLifecycle.all(tid);
  const lifecycle = {};
  for (const r of lcRows) lifecycle[r.lifecycle || "new_lead"] = r.n;

  // Messages by direction (30d)
  const dirRows = q.anMsgByDir.all(tid, since30);
  let inbound = 0, outbound = 0;
  for (const r of dirRows) { if (r.from_me) outbound = r.n; else inbound = r.n; }

  // Outbound by source (30d) → AI handling %
  const viaRows = q.anMsgByVia.all(tid, since30);
  const via = {};
  for (const r of viaRows) via[r.via || "human"] = r.n;
  const automated = (via.ai || 0) + (via.rule || 0) + (via.flow || 0) + (via.sequence || 0);
  const aiPct = outbound ? Math.round((automated / outbound) * 100) : 0;

  // Daily volume (14d)
  const daily = q.anDaily.all(tid, since14);

  // Pipeline value (open vs won)
  ensureStages(tid);
  const stages = q.listStages.all(tid);
  const wonIds = new Set(stages.filter((s) => s.is_won).map((s) => s.id));
  const lostIds = new Set(stages.filter((s) => s.is_lost).map((s) => s.id));
  const deals = q.listDeals.all(tid);
  let openValue = 0, wonValue = 0, openCount = 0, wonCount = 0;
  for (const d of deals) {
    const v = Number(d.value) || 0;
    if (wonIds.has(d.stage_id)) { wonValue += v; wonCount++; }
    else if (!lostIds.has(d.stage_id)) { openValue += v; openCount++; }
  }

  // Conversion: customers (customer + closed_won lifecycle) / total chats
  const customers = (lifecycle.customer || 0) + (lifecycle.closed_won || 0);
  const totalChats = q.anTotalChats.get(tid).n;
  const conversionRate = totalChats ? Math.round((customers / totalChats) * 100) : 0;

  res.json({
    totalChats,
    activeChats7: q.anActiveChats.get(tid, since7).n,
    inbound30: inbound,
    outbound30: outbound,
    aiHandledPct: aiPct,
    automatedReplies30: automated,
    conversionRate,
    customers,
    pipeline: { openValue, wonValue, openCount, wonCount },
    quota: convQuota(req.tenant),
    lifecycle,
    via,
    daily,
  });
});

/* ============================================================
   CONTACTS
   ============================================================ */
function syncContactsFromChats(tenantId) {
  for (const c of q.listChats.all(tenantId)) {
    if (!c.jid || c.jid.endsWith("@g.us")) continue;
    const existing = q.getContactByJid.get(tenantId, c.jid);
    if (!existing) {
      const phone = c.jid.replace(/@s\.whatsapp\.net$/, "");
      q.addContact.run(tenantId, c.name || null, phone, null, null, null, "{}", c.jid, Date.now(), Date.now());
    } else if ((!existing.name || existing.name === "") && c.name) {
      q.updateContact.run(c.name, existing.phone, existing.email, existing.company, existing.notes, existing.custom || "{}", Date.now(), existing.id, tenantId);
    }
  }
}

app.get("/api/contacts", (req, res) => {
  syncContactsFromChats(req.tenant.id);
  const fields = q.listContactFields.all(req.tenant.id);
  const contacts = q.listContacts.all(req.tenant.id).map((c) => ({ ...c, custom: safeJson(c.custom) }));
  res.json({ contacts, fields });
});

app.post("/api/contacts", (req, res) => {
  const { name, phone, email, company, notes, custom } = req.body || {};
  if (!name && !phone && !email) return res.status(400).json({ error: "Add at least a name, phone, or email" });
  const jid = phone ? `${String(phone).replace(/[^0-9]/g, "")}@s.whatsapp.net` : null;
  q.addContact.run(req.tenant.id, name || null, phone || null, email || null, company || null, notes || null, JSON.stringify(custom || {}), jid, Date.now(), Date.now());
  res.json({ ok: true });
});

app.put("/api/contacts/:id", (req, res) => {
  const c = q.getContact.get(req.params.id, req.tenant.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  q.updateContact.run(
    b.name ?? c.name, b.phone ?? c.phone, b.email ?? c.email, b.company ?? c.company, b.notes ?? c.notes,
    JSON.stringify(b.custom || safeJson(c.custom)), Date.now(), c.id, req.tenant.id
  );
  res.json({ ok: true });
});

app.delete("/api/contacts/:id", (req, res) => { q.deleteContact.run(req.params.id, req.tenant.id); res.json({ ok: true }); });

/* custom contact fields (extra columns) */
app.post("/api/contact-fields", (req, res) => {
  const label = String(req.body?.label || "").trim();
  if (!label) return res.status(400).json({ error: "Field label required" });
  const type = ["text", "number", "date", "url"].includes(req.body?.type) ? req.body.type : "text";
  const key = "f_" + label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") + "_" + Math.random().toString(36).slice(2, 6);
  q.addContactField.run(req.tenant.id, key, label, type, q.listContactFields.all(req.tenant.id).length);
  res.json({ ok: true, field_key: key });
});
app.delete("/api/contact-fields/:id", (req, res) => { q.deleteContactField.run(req.params.id, req.tenant.id); res.json({ ok: true }); });

/* CSV export / sample / import */
app.get("/api/contacts/export.csv", (req, res) => {
  syncContactsFromChats(req.tenant.id);
  const fields = q.listContactFields.all(req.tenant.id);
  const contacts = q.listContacts.all(req.tenant.id);
  const headers = ["Name", "Phone", "Email", "Company", "Notes", ...fields.map((f) => f.label)];
  const rows = contacts.map((c) => {
    const cu = safeJson(c.custom);
    return [c.name, c.phone, c.email, c.company, c.notes, ...fields.map((f) => cu[f.field_key] ?? "")];
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=contacts.csv");
  res.send(toCsv([headers, ...rows]));
});

app.get("/api/contacts/sample.csv", (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=contacts-sample.csv");
  res.send(toCsv([
    ["Name", "Phone", "Email", "Company", "Notes"],
    ["Jane Doe", "+14155551234", "jane@example.com", "Acme Co", "VIP customer"],
    ["Omar Ali", "+923001234567", "omar@example.com", "Nile Traders", "Asked about pricing"],
  ]));
});

app.post("/api/contacts/import", upload.single("file"), (req, res) => {
  let text = req.file ? req.file.buffer.toString("utf8") : (req.body?.csv || "");
  if (!text.trim()) return res.status(400).json({ error: "No CSV provided" });
  const rows = parseCsv(text);
  if (rows.length < 2) return res.status(400).json({ error: "CSV needs a header row and at least one contact" });
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const iName = idx(["name", "full name"]), iPhone = idx(["phone", "number", "mobile", "whatsapp"]),
        iEmail = idx(["email", "e-mail"]), iCompany = idx(["company", "organization"]), iNotes = idx(["notes", "note"]);
  let added = 0, updated = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.length || row.every((x) => !String(x).trim())) continue;
    const name = iName >= 0 ? (row[iName] || "").trim() : "";
    const phone = iPhone >= 0 ? (row[iPhone] || "").trim() : "";
    const email = iEmail >= 0 ? (row[iEmail] || "").trim() : "";
    const company = iCompany >= 0 ? (row[iCompany] || "").trim() : "";
    const notes = iNotes >= 0 ? (row[iNotes] || "").trim() : "";
    if (!name && !phone && !email) continue;
    let existing = phone ? q.getContactByPhone.get(req.tenant.id, phone) : null;
    if (!existing && email) existing = q.getContactByEmail.get(req.tenant.id, email);
    if (existing) {
      q.updateContact.run(name || existing.name, phone || existing.phone, email || existing.email, company || existing.company, notes || existing.notes, existing.custom || "{}", Date.now(), existing.id, req.tenant.id);
      updated++;
    } else {
      const jid = phone ? `${phone.replace(/[^0-9]/g, "")}@s.whatsapp.net` : null;
      q.addContact.run(req.tenant.id, name || null, phone || null, email || null, company || null, notes || null, "{}", jid, Date.now(), Date.now());
      added++;
    }
  }
  res.json({ ok: true, added, updated });
});

/* ============================================================
   PIPELINE (deals kanban)
   ============================================================ */
app.get("/api/pipeline", (req, res) => {
  ensureStages(req.tenant.id);
  res.json({ stages: q.listStages.all(req.tenant.id), deals: q.listDeals.all(req.tenant.id) });
});

app.post("/api/pipeline/stages", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Stage name required" });
  q.addStage.run(req.tenant.id, name, q.listStages.all(req.tenant.id).length, 0, 0);
  res.json({ ok: true });
});
app.delete("/api/pipeline/stages/:id", (req, res) => {
  ensureStages(req.tenant.id);
  const stages = q.listStages.all(req.tenant.id);
  if (stages.length <= 1) return res.status(400).json({ error: "Keep at least one stage" });
  const fallback = stages.find((s) => String(s.id) !== req.params.id);
  if (fallback) q.reassignDealsStage.run(fallback.id, req.params.id, req.tenant.id);
  q.deleteStage.run(req.params.id, req.tenant.id);
  res.json({ ok: true });
});

app.post("/api/deals", (req, res) => {
  ensureStages(req.tenant.id);
  const { title, value, currency, stage_id, contact_name, jid, contact_id } = req.body || {};
  if (!title) return res.status(400).json({ error: "Deal title required" });
  const stage = stage_id || q.firstStage.get(req.tenant.id)?.id;
  q.addDeal.run(req.tenant.id, title, contact_id || null, contact_name || null, jid || null, parseFloat(value) || 0, currency || "USD", stage, 0, Date.now(), Date.now());
  res.json({ ok: true });
});
app.put("/api/deals/:id", (req, res) => {
  const d = q.getDeal.get(req.params.id, req.tenant.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  q.updateDeal.run(b.title ?? d.title, b.contact_name ?? d.contact_name, b.jid ?? d.jid,
    b.value !== undefined ? parseFloat(b.value) || 0 : d.value, b.currency ?? d.currency, b.stage_id ?? d.stage_id, Date.now(), d.id, req.tenant.id);
  res.json({ ok: true });
});
app.post("/api/deals/:id/move", (req, res) => {
  q.moveDeal.run(req.body?.stage_id, req.body?.position || 0, Date.now(), req.params.id, req.tenant.id);
  res.json({ ok: true });
});
app.delete("/api/deals/:id", (req, res) => { q.deleteDeal.run(req.params.id, req.tenant.id); res.json({ ok: true }); });
app.get("/api/deals", (req, res) => {
  if (!req.query.jid) return res.json([]);
  res.json(q.dealsByJid.all(req.tenant.id, req.query.jid));
});

/* Full client profile (contact + their deals + custom field defs) */
app.get("/api/client", (req, res) => {
  const jid = req.query.jid;
  const contact = jid ? q.getContactByJid.get(req.tenant.id, jid) : null;
  res.json({
    contact: contact ? { ...contact, custom: safeJson(contact.custom) } : null,
    deals: jid ? q.dealsByJid.all(req.tenant.id, jid) : [],
    fields: q.listContactFields.all(req.tenant.id),
  });
});

/* ============================================================
   AI MAGIC (smart replies + summarize)
   ============================================================ */
app.post("/api/ai/suggest", async (req, res) => {
  if (!req.body?.jid) return res.status(400).json({ error: "jid required" });
  try {
    const suggestions = await suggestReplies(req.tenant.id, req.body.jid);
    if (!suggestions.length) return res.status(503).json({ error: "AI unavailable — check your API key" });
    res.json({ suggestions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/ai/summarize", async (req, res) => {
  if (!req.body?.jid) return res.status(400).json({ error: "jid required" });
  try {
    const summary = await summarizeChat(req.tenant.id, req.body.jid);
    if (!summary) return res.status(503).json({ error: "Nothing to summarize yet" });
    res.json({ summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ============================================================
   BEHAVIOUR LEARNING (global owner voice + per-chat style/summary)
   ============================================================ */
const LEARN_THRESHOLD = 100;

// Global "your voice" style
app.get("/api/owner-style", (req, res) => {
  const ownerMsgs = q.countOwnerMessages.get(req.tenant.id).n;
  res.json({
    style: getSetting(req.tenant.id, "owner_style") || "",
    ownerMsgs,
    threshold: LEARN_THRESHOLD,
    eligible: ownerMsgs >= LEARN_THRESHOLD,
  });
});
app.post("/api/owner-style/learn", async (req, res) => {
  try {
    const style = await learnOwnerStyle(req.tenant.id);
    if (!style) return res.status(503).json({ error: "AI returned nothing — check your API key" });
    q.setSetting.run(req.tenant.id, "owner_style", style);
    res.json({ ok: true, style });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete("/api/owner-style", (req, res) => { q.setSetting.run(req.tenant.id, "owner_style", ""); res.json({ ok: true }); });
// Instant global style: learn the owner's voice from uploaded WhatsApp exports
app.post("/api/owner-style/import", upload.array("files", 20), async (req, res) => {
  const texts = (req.files || []).map((f) => f.buffer.toString("utf8")).filter((t) => t.trim());
  if (!texts.length) return res.status(400).json({ error: "Upload at least one chat .txt file." });
  try {
    const { style, imported } = await learnOwnerStyleFromExports(req.tenant.id, texts, req.body?.ownerName || "");
    if (!style) return res.status(503).json({ error: "AI returned nothing — check your API key" });
    q.setSetting.run(req.tenant.id, "owner_style", style);
    res.json({ ok: true, style, imported });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Per-chat behaviour
app.get("/api/chats/:jid/insight", (req, res) => {
  const chat = q.getChat.get(req.tenant.id, req.params.jid);
  res.json({
    summary: chat?.ai_summary || "",
    style: chat?.ai_style || "",
    count: q.countChatMessages.get(req.tenant.id, req.params.jid).n,
    threshold: LEARN_THRESHOLD,
  });
});
app.post("/api/chats/:jid/learn", async (req, res) => {
  const jid = req.params.jid;
  const count = q.countChatMessages.get(req.tenant.id, jid).n;
  if (count < LEARN_THRESHOLD) return res.status(400).json({ error: `Need ${LEARN_THRESHOLD} messages in this chat first (have ${count}).` });
  try {
    const { summary, style } = await learnChatBehaviour(req.tenant.id, jid);
    q.setChatInsight.run(summary, style, req.tenant.id, jid);
    res.json({ ok: true, summary, style });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Feed prior history: import a WhatsApp "Export chat" .txt so the agent
// understands the relationship without waiting for 100 live messages.
app.post("/api/chats/:jid/import-history", upload.single("file"), async (req, res) => {
  const jid = req.params.jid;
  const text = req.file ? req.file.buffer.toString("utf8") : (req.body?.text || "");
  if (!text.trim()) return res.status(400).json({ error: "No chat file provided." });
  try {
    const { summary, style, imported } = await learnChatBehaviourFromExport(req.tenant.id, jid, text, req.body?.ownerName || "");
    q.setChatInsight.run(summary, style, req.tenant.id, jid);
    res.json({ ok: true, summary, style, imported });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ============================================================
   STARTER PACKS
   ============================================================ */
app.get("/api/starter-packs", (req, res) => res.json(packSummary()));
app.post("/api/starter-packs/:id/install", (req, res) => {
  try { res.json({ ok: true, ...installPack(req.tenant.id, req.params.id) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

/* ============================================================
   CLICK-TO-WHATSAPP LEAD ENGINE
   ============================================================ */
app.get("/api/lead/number", (req, res) => {
  const s = getSessionStatus(req.tenant.id);
  res.json({ number: s.me || "", connected: s.status === "connected" });
});
app.get("/api/lead/sources", (req, res) => res.json(q.listLeadSources.all(req.tenant.id)));
app.post("/api/lead/sources", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Source name required" });
  const ref = (name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "src") + Math.random().toString(36).slice(2, 5);
  q.addLeadSource.run(req.tenant.id, name, ref, String(req.body?.prefill || ""), Date.now());
  res.json({ ok: true, ref });
});
app.delete("/api/lead/sources/:id", (req, res) => { q.deleteLeadSource.run(req.params.id, req.tenant.id); res.json({ ok: true }); });
app.get("/api/lead/qr", async (req, res) => {
  const text = String(req.query.text || "");
  if (!text) return res.status(400).json({ error: "text required" });
  try { res.json({ dataUrl: await QRCode.toDataURL(text, { margin: 1, width: 360 }) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/* ============================================================
   IN-CHAT PAYMENTS
   ============================================================ */
app.get("/api/payments", (req, res) => res.json(q.listPayments.all(req.tenant.id)));
app.get("/api/payments/settings", (req, res) => {
  res.json({ stripe_set: !!getSetting(req.tenant.id, "org_stripe_key") });
});
app.post("/api/payments/settings", (req, res) => {
  if (!["owner", "admin"].includes(req.role)) return res.status(403).json({ error: "Only owners/admins" });
  if (typeof req.body?.stripe_key === "string") q.setSetting.run(req.tenant.id, "org_stripe_key", req.body.stripe_key.trim());
  res.json({ ok: true });
});
app.post("/api/payments/request", async (req, res) => {
  const { jid, contact_name, amount, currency, description } = req.body || {};
  if (!jid || !amount) return res.status(400).json({ error: "jid and amount required" });
  const cur = (currency || "USD").toUpperCase();
  const desc = description || "Payment request";
  const stripeKey = getSetting(req.tenant.id, "org_stripe_key");
  let url, provider;
  try {
    if (stripeKey) { url = await createStripePaymentLink(stripeKey, amount, cur, desc); provider = "stripe"; }
    else { url = `https://pay.example.com/demo/${newId().slice(0, 10)}`; provider = "demo"; }
  } catch (err) { return res.status(400).json({ error: "Stripe error: " + err.message }); }

  q.addPayment.run(req.tenant.id, jid, contact_name || null, parseFloat(amount), cur, desc, url, "sent", provider, Date.now());
  const msg = `💳 *Payment request*\n${desc}\nAmount: ${cur} ${Number(amount).toLocaleString()}\n\nPay securely here:\n${url}`;
  try { await sendText(req.tenant.id, jid, msg, "human"); } catch (err) { /* connection may be off */ }
  res.json({ ok: true, url, provider });
});

/* ============================================================
   BRANDED ROI REPORT
   ============================================================ */
app.get("/api/report", (req, res) => {
  const tid = req.tenant.id, now = Date.now(), day = 86400000, since30 = now - 30 * day;
  const dir = q.anMsgByDir.all(tid, since30);
  let inbound = 0, outbound = 0;
  for (const r of dir) { if (r.from_me) outbound = r.n; else inbound = r.n; }
  const via = {}; for (const r of q.anMsgByVia.all(tid, since30)) via[r.via || "human"] = r.n;
  const automated = (via.ai || 0) + (via.rule || 0) + (via.flow || 0) + (via.sequence || 0);
  ensureStages(tid);
  const stages = q.listStages.all(tid);
  const wonIds = new Set(stages.filter((s) => s.is_won).map((s) => s.id));
  const lostIds = new Set(stages.filter((s) => s.is_lost).map((s) => s.id));
  let openValue = 0, wonValue = 0;
  for (const d of q.listDeals.all(tid)) {
    const v = Number(d.value) || 0;
    if (wonIds.has(d.stage_id)) wonValue += v; else if (!lostIds.has(d.stage_id)) openValue += v;
  }
  const lc = {}; for (const r of q.anLifecycle.all(tid)) lc[r.lifecycle || "new_lead"] = r.n;
  res.json({
    branding: brandingFor(tid),
    org: req.tenant.business_name,
    generatedAt: now,
    period: "Last 30 days",
    inbound, outbound, automated,
    hoursSaved: Math.round((automated * 2) / 60 * 10) / 10, // ~2 min saved per automated reply
    aiPct: outbound ? Math.round((automated / outbound) * 100) : 0,
    totalChats: q.anTotalChats.get(tid).n,
    activeChats: q.anActiveChats.get(tid, now - 7 * day).n,
    pipeline: { openValue, wonValue },
    lifecycle: lc,
  });
});

/* ============================================================
   APPOINTMENT BOOKING
   ============================================================ */
app.get("/api/appointments", (req, res) => res.json(q.listAppointments.all(req.tenant.id)));
app.post("/api/appointments", async (req, res) => {
  const { jid, contact_name, title, start_ts, duration, notes, send_confirmation } = req.body || {};
  if (!title || !start_ts) return res.status(400).json({ error: "title and start time required" });
  q.addAppointment.run(req.tenant.id, jid || null, contact_name || null, title, Number(start_ts), parseInt(duration, 10) || 30, "confirmed", notes || null, Date.now());
  if (send_confirmation && jid) {
    const when = new Date(Number(start_ts)).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    try { await sendText(req.tenant.id, jid, `✅ Your appointment is confirmed!\n\n📅 ${title}\n🕐 ${when}\n\nReply RESCHEDULE if you need to change it. See you soon!`, "human"); } catch {}
  }
  res.json({ ok: true });
});
app.put("/api/appointments/:id", (req, res) => {
  const b = req.body || {};
  q.updateAppointment.run(b.title, b.contact_name || null, Number(b.start_ts), parseInt(b.duration, 10) || 30, b.status || "confirmed", b.notes || null, req.params.id, req.tenant.id);
  res.json({ ok: true });
});
app.delete("/api/appointments/:id", (req, res) => { q.deleteAppointment.run(req.params.id, req.tenant.id); res.json({ ok: true }); });

/* ============================================================
   E-COMMERCE RECOVERY
   ============================================================ */
app.get("/api/ecommerce/info", (req, res) => {
  res.json({
    webhook_url: `${baseUrl(req)}/api/v1/ecommerce/abandoned-cart`,
    api_key: req.tenant.api_key || null,
    sample: { phone: "+14155551234", name: "Jane", cart_value: 79.99, currency: "USD", checkout_url: "https://yourstore.com/cart/abc", items: "2× T-shirt" },
  });
});

/* --- Integrations --- */
app.get("/api/integrations", (req, res) => {
  res.json({
    webhook_url: getSetting(req.tenant.id, "webhook_url") || "",
    api_key: req.tenant.api_key || null,
  });
});
app.post("/api/integrations/webhook", (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (url && !/^https:\/\//.test(url)) return res.status(400).json({ error: "Webhook URL must start with https://" });
  q.setSetting.run(req.tenant.id, "webhook_url", url);
  res.json({ ok: true });
});
app.post("/api/integrations/apikey", (req, res) => {
  const key = "wak_" + newId() + newId();
  q.setApiKey.run(key, req.tenant.id);
  res.json({ api_key: key });
});

/* --- Billing --- */
app.post("/api/billing/checkout", async (req, res) => {
  try { const url = await createCheckout(req.tenant, req.body?.plan, baseUrl(req)); res.json({ url }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/billing/portal", async (req, res) => {
  try { const url = await createPortal(req.tenant, baseUrl(req)); res.json({ url }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

/* ============================================================
   HELPERS
   ============================================================ */
function apiKeyAuth(req) {
  const key = req.headers["x-api-key"];
  return key ? q.tenantByApiKey.get(key) : null;
}

/* ---- Stripe payment link (uses an org's own Stripe secret key) ---- */
async function stripePost(key, path, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe ${res.status}`);
  return data;
}
async function createStripePaymentLink(key, amount, currency, description) {
  const price = await stripePost(key, "prices", {
    unit_amount: Math.round(Number(amount) * 100),
    currency: currency.toLowerCase(),
    "product_data[name]": description,
  });
  const link = await stripePost(key, "payment_links", {
    "line_items[0][price]": price.id,
    "line_items[0][quantity]": 1,
  });
  return link.url;
}

/* ---- Admin helpers ---- */
function isSessionConnected(tid) { return isConnected(tid); }
function countConnectedSessions() { return connectedCount(); }

/* ---- White-label branding helpers ---- */
function brandingDefaults() {
  return { app_name: "Zaply", logo: "", hue: 158, login_subtitle: "Sign in to your WhatsApp AI inbox.", powered_by: true, custom_domain: "" };
}
function brandingFor(tenantId) {
  const g = (k) => q.getSettingRow.get(tenantId, k)?.value;
  const d = brandingDefaults();
  const hue = g("brand_hue");
  const poweredBy = g("brand_powered_by");
  return {
    app_name: g("brand_app_name") || d.app_name,
    logo: g("brand_logo") || "",
    hue: hue != null && hue !== "" ? Number(hue) : d.hue,
    login_subtitle: g("brand_login_subtitle") || d.login_subtitle,
    powered_by: poweredBy == null || poweredBy === "" ? true : poweredBy === "1",
    custom_domain: g("brand_custom_domain") || "",
  };
}

/* ---- CSV + JSON helpers ---- */
function safeJson(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }
function csvCell(v) {
  v = v == null ? "" : String(v);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function toCsv(rows) { return rows.map((r) => r.map(csvCell).join(",")).join("\r\n"); }
function parseCsv(text) {
  const rows = []; let row = [], cell = "", inQ = false;
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length);
}

/** Resolve a broadcast segment to a list of { jid, name }. */
function resolveSegment(tenantId, type, value) {
  switch (type) {
    case "lifecycle": return q.chatsByLifecycle.all(tenantId, value || "new_lead");
    case "tag":       return q.chatsByTag.all(tenantId, value || "");
    case "unread":    return q.chatsUnread.all(tenantId);
    case "all":
    default:          return q.chatsAll.all(tenantId);
  }
}

function publicTenant(t) {
  return {
    id: t.id, email: t.email, business_name: t.business_name,
    plan: t.plan, plan_label: getPlans()[t.plan]?.label || t.plan,
    trial_ends: t.trial_ends, status: t.status,
  };
}

function publicOrg(t) {
  return {
    id: t.id,
    name: t.business_name || "Untitled organization",
    plan: t.plan, plan_label: getPlans()[t.plan]?.label || t.plan,
    trial_ends: t.trial_ends, status: t.status,
    role: t.member_role || null,
  };
}

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}

/* ============================================================
   WebSocket
   ============================================================ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const payload = verifyToken(url.searchParams.get("token") || "");
  if (!payload) return ws.close(4001, "unauthorized");
  ws.tenantId = payload.tid;
});

function broadcastWs(tenantId, event) {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.tenantId === tenantId) client.send(payload);
  }
}
onEvent(broadcastWs);
onAutomationEvent(broadcastWs);

const PORT = process.env.PORT || 3000;
const APP_VERSION = "v0.5.0 (Zaply favicon + logo)";
server.listen(PORT, () => {
  console.log("======================================================");
  console.log(`Zaply ${APP_VERSION}`);
  console.log(`Portal running at http://localhost:${PORT}`);
  console.log("======================================================");
  resumeAllSessions();
  startAutomationScheduler();
});

// Public — confirm which code version is actually deployed (open in a browser):
//   https://<your-app>.replit.app/version
app.get("/version", (req, res) => res.json({ version: APP_VERSION }));
