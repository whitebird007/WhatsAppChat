import crypto from "node:crypto";
import { q, newId } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || "7", 10);

/* ---------- Password hashing (scrypt, no native deps) ---------- */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

/* ---------- Minimal HS256 JWT (no deps) ---------- */
const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function signToken(payload, expiresInSec = 60 * 60 * 24 * 30) {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSec })
  );
  const sig = b64u(crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  try {
    const [header, body, sig] = token.split(".");
    const expected = b64u(
      crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest()
    );
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function trialEnds() {
  const adminDays = parseInt(q.getApp.get("default_trial_days")?.value, 10);
  const days = Number.isFinite(adminDays) && adminDays > 0 ? adminDays : TRIAL_DAYS;
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

/** Create a brand-new organization (tenant) owned by `userId`. Returns the org row. */
export function createOrganization(userId, name) {
  const orgId = newId();
  // tenants.email is a vestigial NOT NULL UNIQUE column (auth lives in `users` now),
  // so give each org a synthetic unique value.
  const syntheticEmail = `org-${orgId}@inboxai.local`;
  q.createOrg.run(orgId, syntheticEmail, name || "My Organization", trialEnds(), Date.now());
  q.addMember.run(userId, orgId, "owner", Date.now());
  return q.tenantById.get(orgId);
}

/* ---------- Signup / login ---------- */
// Signup creates a USER (login) + their first ORGANIZATION, owned by them.
export function signup({ email, password, businessName }) {
  if (q.getApp.get("signups_enabled")?.value === "0") throw new Error("New sign-ups are currently disabled");
  email = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Valid email required");
  if (!password || password.length < 8) throw new Error("Password must be at least 8 characters");
  if (q.userByEmail.get(email)) throw new Error("An account with this email already exists");

  const userId = newId();
  q.createUser.run(userId, email, hashPassword(password), businessName || null, Date.now());
  const org = createOrganization(userId, businessName || "My Organization");

  const user = q.userById.get(userId);
  return { token: signToken({ uid: userId, tid: org.id }), user, tenant: org, orgs: q.listOrgsForUser.all(userId) };
}

export function login({ email, password }) {
  email = String(email || "").trim().toLowerCase();
  const user = q.userByEmail.get(email);
  if (!user || !verifyPassword(password, user.pass_hash)) {
    throw new Error("Invalid email or password");
  }
  const orgs = q.listOrgsForUser.all(user.id);
  if (!orgs.length) {
    // Safety net: a user with no org (shouldn't happen) gets a fresh one
    const org = createOrganization(user.id, user.name || "My Organization");
    orgs.push({ ...org, member_role: "owner" });
  }
  const active = orgs[0];
  return { token: signToken({ uid: user.id, tid: active.id }), user, tenant: active, orgs };
}

/** Issue a token for the user against a different org they belong to. */
export function switchOrg(userId, orgId) {
  const m = q.getMembership.get(userId, orgId);
  if (!m) throw new Error("You don't have access to that organization");
  const org = q.tenantById.get(orgId);
  return { token: signToken({ uid: userId, tid: orgId }), tenant: org, role: m.role };
}

/* ---------- Express middleware ---------- */
export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Not logged in" });

  const user = q.userById.get(payload.uid);
  if (!user) return res.status(401).json({ error: "Account not found" });
  const tenant = q.tenantById.get(payload.tid);
  if (!tenant) return res.status(401).json({ error: "Organization not found" });
  const membership = q.getMembership.get(user.id, tenant.id);
  if (!membership) return res.status(403).json({ error: "No access to this organization" });

  req.user = user;
  req.tenant = tenant;       // the active organization (same shape as before — all existing routes keep working)
  req.role = membership.role;
  next();
}
