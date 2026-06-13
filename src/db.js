import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, "..", "data.sqlite"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  business_name TEXT,
  plan TEXT DEFAULT 'trial',
  trial_ends INTEGER,
  stripe_customer_id TEXT,
  stripe_sub_id TEXT,
  status TEXT DEFAULT 'active',
  created INTEGER
);
CREATE TABLE IF NOT EXISTS chats (
  tenant_id TEXT,
  jid TEXT,
  name TEXT,
  last_msg TEXT,
  last_ts INTEGER,
  unread INTEGER DEFAULT 0,
  ai_enabled INTEGER DEFAULT 0,
  lifecycle TEXT DEFAULT 'new_lead',
  PRIMARY KEY (tenant_id, jid)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT,
  tenant_id TEXT,
  jid TEXT,
  from_me INTEGER,
  body TEXT,
  ts INTEGER,
  via TEXT DEFAULT 'human',
  mime_type TEXT,
  file_name TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_t_jid_ts ON messages (tenant_id, jid, ts);
CREATE INDEX IF NOT EXISTS idx_messages_t_via_ts ON messages (tenant_id, via, ts);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  keyword TEXT NOT NULL,
  reply TEXT NOT NULL,
  match_type TEXT DEFAULT 'contains',
  active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_rules_tenant ON rules (tenant_id);
CREATE TABLE IF NOT EXISTS settings (
  tenant_id TEXT,
  key TEXT,
  value TEXT,
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  name TEXT,
  trigger_keyword TEXT,
  definition TEXT,
  active INTEGER DEFAULT 1,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flows_tenant ON flows (tenant_id);
CREATE TABLE IF NOT EXISTS flow_state (
  tenant_id TEXT,
  jid TEXT,
  flow_id INTEGER,
  node_id TEXT,
  updated INTEGER,
  PRIMARY KEY (tenant_id, jid)
);

-- AI Agents
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '🤖',
  instructions TEXT,
  playbook TEXT,
  rules TEXT,
  model TEXT DEFAULT 'gpt-4o-mini',
  openai_api_key TEXT,
  active INTEGER DEFAULT 1,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents (tenant_id);

-- Knowledge sources for agents
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  agent_id INTEGER,
  file_name TEXT,
  content TEXT,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_knowledge_tenant ON knowledge_sources (tenant_id);

-- Message templates (slash command)
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  name TEXT NOT NULL,
  shortcut TEXT,
  body TEXT NOT NULL,
  active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates (tenant_id);

-- Chat tags
CREATE TABLE IF NOT EXISTS chat_tags (
  tenant_id TEXT,
  jid TEXT,
  tag TEXT,
  PRIMARY KEY (tenant_id, jid, tag)
);

-- Chat notes
CREATE TABLE IF NOT EXISTS chat_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  jid TEXT,
  body TEXT,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notes_tenant_jid ON chat_notes (tenant_id, jid);

-- Inbound webhook events log
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  payload TEXT,
  created INTEGER
);
`);

/* Safe migrations — add columns that may not exist yet */
const migrationStmts = [
  "ALTER TABLE tenants ADD COLUMN api_key TEXT",
  "ALTER TABLE chats ADD COLUMN lifecycle TEXT DEFAULT 'new_lead'",
  "ALTER TABLE chats ADD COLUMN agent_id INTEGER",
  "ALTER TABLE messages ADD COLUMN mime_type TEXT",
  "ALTER TABLE messages ADD COLUMN file_name TEXT",
  "ALTER TABLE messages ADD COLUMN media_url TEXT",
  "ALTER TABLE messages ADD COLUMN status INTEGER",
];
for (const stmt of migrationStmts) {
  try { db.exec(stmt); } catch {}
}

/* ── Follow-up Sequences, Broadcasts (added) ── */
db.exec(`
CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  name TEXT NOT NULL,
  trigger_type TEXT DEFAULT 'manual',
  trigger_value TEXT,
  active INTEGER DEFAULT 1,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sequences_tenant ON sequences (tenant_id);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id INTEGER,
  step_order INTEGER,
  delay_minutes INTEGER DEFAULT 60,
  body TEXT
);
CREATE INDEX IF NOT EXISTS idx_seq_steps ON sequence_steps (sequence_id);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  sequence_id INTEGER,
  jid TEXT,
  current_step INTEGER DEFAULT 0,
  next_run_ts INTEGER,
  status TEXT DEFAULT 'active',
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_enroll_due ON sequence_enrollments (status, next_run_ts);
CREATE INDEX IF NOT EXISTS idx_enroll_tenant ON sequence_enrollments (tenant_id);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  name TEXT,
  body TEXT,
  segment_type TEXT,
  segment_value TEXT,
  status TEXT DEFAULT 'draft',
  total INTEGER DEFAULT 0,
  sent INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant ON broadcasts (tenant_id);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id INTEGER,
  tenant_id TEXT,
  jid TEXT,
  name TEXT,
  status TEXT DEFAULT 'pending',
  sent_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_brec_due ON broadcast_recipients (broadcast_id, status);

-- ── Users & multi-organization membership ──
-- A "user" is a login. A "tenant" row is now an ORGANIZATION.
-- org_members links users to organizations (many-to-many) with a role.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  name TEXT,
  created INTEGER
);
CREATE TABLE IF NOT EXISTS org_members (
  user_id TEXT,
  org_id TEXT,
  role TEXT DEFAULT 'agent',   -- owner | admin | agent
  created INTEGER,
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON org_members (user_id);
CREATE INDEX IF NOT EXISTS idx_members_org ON org_members (org_id);

-- ── Contacts (CRM) ──
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  name TEXT,
  phone TEXT,
  email TEXT,
  company TEXT,
  notes TEXT,
  custom TEXT,        -- JSON { fieldKey: value }
  jid TEXT,           -- linked WhatsApp jid (if any)
  created INTEGER,
  updated INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_jid ON contacts (tenant_id, jid);

-- Custom contact fields (extra columns)
CREATE TABLE IF NOT EXISTS contact_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  field_key TEXT,
  label TEXT,
  type TEXT DEFAULT 'text',
  position INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_contact_fields_tenant ON contact_fields (tenant_id);

-- ── Pipeline (deals kanban) ──
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  name TEXT,
  position INTEGER DEFAULT 0,
  is_won INTEGER DEFAULT 0,
  is_lost INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stages_tenant ON pipeline_stages (tenant_id);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  title TEXT,
  contact_id INTEGER,
  contact_name TEXT,
  jid TEXT,
  value REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  stage_id INTEGER,
  position INTEGER DEFAULT 0,
  created INTEGER,
  updated INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deals_tenant ON deals (tenant_id);
`);

/* One-time migration: turn each legacy tenant (which held its own login)
   into a user + their first organization, owned by that user. Idempotent. */
(function migrateTenantsToUsers() {
  const tenants = db.prepare("SELECT * FROM tenants").all();
  const insUser = db.prepare("INSERT INTO users (id, email, pass_hash, name, created) VALUES (?, ?, ?, ?, ?)");
  const findUser = db.prepare("SELECT id FROM users WHERE email = ?");
  const insMember = db.prepare("INSERT OR IGNORE INTO org_members (user_id, org_id, role, created) VALUES (?, ?, 'owner', ?)");
  for (const t of tenants) {
    if (!t.email || !t.pass_hash) continue; // org-only rows (no login) are skipped
    let u = findUser.get(t.email);
    if (!u) {
      const uid = crypto.randomBytes(12).toString("hex");
      try { insUser.run(uid, t.email, t.pass_hash, t.business_name || null, t.created || Date.now()); u = { id: uid }; }
      catch { u = findUser.get(t.email); }
    }
    if (u) insMember.run(u.id, t.id, Date.now());
  }
})();

/* ── Super-admin (application owner) + global app settings ── */
db.exec(`
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);
try { db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0"); } catch {}

/* ── Bookings, payments, lead sources (growth features) ── */
db.exec(`
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  jid TEXT,
  contact_name TEXT,
  title TEXT,
  start_ts INTEGER,
  duration INTEGER DEFAULT 30,
  status TEXT DEFAULT 'confirmed',
  notes TEXT,
  reminded INTEGER DEFAULT 0,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_appts_tenant ON appointments (tenant_id, start_ts);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  jid TEXT,
  contact_name TEXT,
  amount REAL,
  currency TEXT DEFAULT 'USD',
  description TEXT,
  url TEXT,
  status TEXT DEFAULT 'sent',
  provider TEXT,
  created INTEGER,
  paid_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments (tenant_id);

CREATE TABLE IF NOT EXISTS lead_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  name TEXT,
  ref TEXT,
  prefill TEXT,
  clicks INTEGER DEFAULT 0,
  leads INTEGER DEFAULT 0,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lead_sources_tenant ON lead_sources (tenant_id);
`);

/* Bootstrap the application owner:
   - any email in SUPER_ADMIN_EMAILS env becomes admin
   - if no admin exists at all, the earliest-registered user (the founder) becomes admin */
(function bootstrapAdmin() {
  const envAdmins = (process.env.SUPER_ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const email of envAdmins) {
    try { db.prepare("UPDATE users SET is_admin = 1 WHERE lower(email) = ?").run(email); } catch {}
  }
  const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get().n;
  if (adminCount === 0) {
    const first = db.prepare("SELECT id FROM users ORDER BY created LIMIT 1").get();
    if (first) db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(first.id);
  }
})();

export const DEFAULT_SETTINGS = {
  ai_global_enabled: "0",
  ai_system_prompt:
    "You are a friendly, professional WhatsApp assistant for this business. Reply in the same language the customer writes in (English, Urdu, or Roman Urdu — use respectful Aap forms in Urdu, never Tu). Keep replies to 2-3 short lines. If you don't know something or the customer asks for a human, say the owner will reply shortly. Never make commitments about prices, refunds, or delivery dates unless they appear in the business info below.\n\nBusiness info:\n(Describe your business here in Settings)",
  ai_handoff_keywords: "human, agent, owner, complaint, refund",
};

export const LIFECYCLE_LABELS = {
  new_lead: "New Lead",
  hot_lead: "Hot Lead",
  payment: "Payment",
  customer: "Customer",
  closed_won: "Closed-Won",
};

export const PLANS = {
  trial: { convPerMonth: 50, label: "Free trial", price: 0 },
  starter: { convPerMonth: 300, label: "Starter", price: 29 },
  pro: { convPerMonth: 1500, label: "Pro", price: 79 },
  agency: { convPerMonth: Infinity, label: "Agency", price: 199 },
};

/* Plans the admin can edit live (stored as JSON in app_settings; -1 = unlimited). */
export function getPlans() {
  const raw = db.prepare("SELECT value FROM app_settings WHERE key = 'plans'").get()?.value;
  if (raw) {
    try {
      const o = JSON.parse(raw);
      const merged = {};
      for (const k of Object.keys(PLANS)) {
        const ov = o[k] || {};
        merged[k] = {
          label: ov.label ?? PLANS[k].label,
          price: ov.price != null ? Number(ov.price) : PLANS[k].price,
          convPerMonth: ov.convPerMonth === -1 || ov.convPerMonth == null ? (ov.convPerMonth === -1 ? Infinity : PLANS[k].convPerMonth) : Number(ov.convPerMonth),
        };
      }
      return merged;
    } catch {}
  }
  return PLANS;
}

export const q = {
  // tenants (= organizations)
  createTenant: db.prepare(`INSERT INTO tenants (id, email, pass_hash, business_name, plan, trial_ends, created) VALUES (?, ?, ?, ?, 'trial', ?, ?)`),
  createOrg: db.prepare(`INSERT INTO tenants (id, email, pass_hash, business_name, plan, trial_ends, created) VALUES (?, ?, '', ?, 'trial', ?, ?)`),
  renameOrg: db.prepare("UPDATE tenants SET business_name = ? WHERE id = ?"),
  tenantByEmail: db.prepare("SELECT * FROM tenants WHERE email = ?"),
  tenantById: db.prepare("SELECT * FROM tenants WHERE id = ?"),

  // users (logins)
  createUser: db.prepare("INSERT INTO users (id, email, pass_hash, name, created) VALUES (?, ?, ?, ?, ?)"),
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  setUserPass: db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?"),

  // org membership
  addMember: db.prepare("INSERT OR IGNORE INTO org_members (user_id, org_id, role, created) VALUES (?, ?, ?, ?)"),
  getMembership: db.prepare("SELECT * FROM org_members WHERE user_id = ? AND org_id = ?"),
  listOrgsForUser: db.prepare(`
    SELECT t.*, m.role AS member_role
    FROM org_members m JOIN tenants t ON t.id = m.org_id
    WHERE m.user_id = ? ORDER BY t.created
  `),
  listMembersForOrg: db.prepare(`
    SELECT u.id, u.email, u.name, m.role, m.created
    FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? ORDER BY (m.role = 'owner') DESC, m.created
  `),
  removeMember: db.prepare("DELETE FROM org_members WHERE user_id = ? AND org_id = ?"),
  setMemberRole: db.prepare("UPDATE org_members SET role = ? WHERE user_id = ? AND org_id = ?"),
  countOwners: db.prepare("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner'"),

  // ── Contacts ──
  listContacts: db.prepare("SELECT * FROM contacts WHERE tenant_id = ? ORDER BY (name IS NULL OR name = ''), name COLLATE NOCASE, id DESC"),
  getContact: db.prepare("SELECT * FROM contacts WHERE id = ? AND tenant_id = ?"),
  getContactByJid: db.prepare("SELECT * FROM contacts WHERE tenant_id = ? AND jid = ?"),
  getContactByPhone: db.prepare("SELECT * FROM contacts WHERE tenant_id = ? AND phone = ? LIMIT 1"),
  getContactByEmail: db.prepare("SELECT * FROM contacts WHERE tenant_id = ? AND email = ? AND email <> '' LIMIT 1"),
  addContact: db.prepare("INSERT INTO contacts (tenant_id, name, phone, email, company, notes, custom, jid, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  updateContact: db.prepare("UPDATE contacts SET name = ?, phone = ?, email = ?, company = ?, notes = ?, custom = ?, updated = ? WHERE id = ? AND tenant_id = ?"),
  deleteContact: db.prepare("DELETE FROM contacts WHERE id = ? AND tenant_id = ?"),
  countContacts: db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ?"),

  // contact custom fields
  listContactFields: db.prepare("SELECT * FROM contact_fields WHERE tenant_id = ? ORDER BY position, id"),
  addContactField: db.prepare("INSERT INTO contact_fields (tenant_id, field_key, label, type, position) VALUES (?, ?, ?, ?, ?)"),
  deleteContactField: db.prepare("DELETE FROM contact_fields WHERE id = ? AND tenant_id = ?"),

  // ── Pipeline ──
  listStages: db.prepare("SELECT * FROM pipeline_stages WHERE tenant_id = ? ORDER BY position, id"),
  addStage: db.prepare("INSERT INTO pipeline_stages (tenant_id, name, position, is_won, is_lost) VALUES (?, ?, ?, ?, ?)"),
  deleteStage: db.prepare("DELETE FROM pipeline_stages WHERE id = ? AND tenant_id = ?"),
  countStages: db.prepare("SELECT COUNT(*) AS n FROM pipeline_stages WHERE tenant_id = ?"),
  firstStage: db.prepare("SELECT * FROM pipeline_stages WHERE tenant_id = ? ORDER BY position, id LIMIT 1"),

  listDeals: db.prepare("SELECT * FROM deals WHERE tenant_id = ? ORDER BY stage_id, position, id"),
  getDeal: db.prepare("SELECT * FROM deals WHERE id = ? AND tenant_id = ?"),
  dealsByJid: db.prepare("SELECT * FROM deals WHERE tenant_id = ? AND jid = ? ORDER BY updated DESC"),
  addDeal: db.prepare("INSERT INTO deals (tenant_id, title, contact_id, contact_name, jid, value, currency, stage_id, position, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  updateDeal: db.prepare("UPDATE deals SET title = ?, contact_name = ?, jid = ?, value = ?, currency = ?, stage_id = ?, updated = ? WHERE id = ? AND tenant_id = ?"),
  moveDeal: db.prepare("UPDATE deals SET stage_id = ?, position = ?, updated = ? WHERE id = ? AND tenant_id = ?"),
  deleteDeal: db.prepare("DELETE FROM deals WHERE id = ? AND tenant_id = ?"),
  reassignDealsStage: db.prepare("UPDATE deals SET stage_id = ? WHERE stage_id = ? AND tenant_id = ?"),
  tenantByStripeCustomer: db.prepare("SELECT * FROM tenants WHERE stripe_customer_id = ?"),
  setStripeCustomer: db.prepare("UPDATE tenants SET stripe_customer_id = ? WHERE id = ?"),
  setPlan: db.prepare("UPDATE tenants SET plan = ?, stripe_sub_id = ? WHERE id = ?"),
  setStatus: db.prepare("UPDATE tenants SET status = ? WHERE id = ?"),
  listActiveTenants: db.prepare("SELECT id FROM tenants WHERE status = 'active'"),

  // chats
  upsertChat: db.prepare(`
    INSERT INTO chats (tenant_id, jid, name, last_msg, last_ts, unread)
    VALUES (@tenant_id, @jid, @name, @last_msg, @last_ts, @unread)
    ON CONFLICT(tenant_id, jid) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      last_msg = excluded.last_msg,
      last_ts = excluded.last_ts,
      unread = chats.unread + excluded.unread
  `),
  clearUnread: db.prepare("UPDATE chats SET unread = 0 WHERE tenant_id = ? AND jid = ?"),
  listChats: db.prepare("SELECT * FROM chats WHERE tenant_id = ? ORDER BY last_ts DESC LIMIT 200"),
  listUnreadChats: db.prepare("SELECT * FROM chats WHERE tenant_id = ? AND unread > 0 ORDER BY last_ts DESC LIMIT 200"),
  getChat: db.prepare("SELECT * FROM chats WHERE tenant_id = ? AND jid = ?"),
  setChatAi: db.prepare("UPDATE chats SET ai_enabled = ? WHERE tenant_id = ? AND jid = ?"),
  setChatLifecycle: db.prepare("UPDATE chats SET lifecycle = ? WHERE tenant_id = ? AND jid = ?"),
  setChatAgent: db.prepare("UPDATE chats SET agent_id = ? WHERE tenant_id = ? AND jid = ?"),
  ensureChat: db.prepare(`
    INSERT INTO chats (tenant_id, jid, name, last_msg, last_ts, unread)
    VALUES (?, ?, ?, '', ?, 0)
    ON CONFLICT(tenant_id, jid) DO NOTHING
  `),

  // messages
  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages (id, tenant_id, jid, from_me, body, ts, via, mime_type, file_name, media_url, status)
    VALUES (@id, @tenant_id, @jid, @from_me, @body, @ts, @via, @mime_type, @file_name, @media_url, @status)
  `),
  setMessageStatus: db.prepare("UPDATE messages SET status = ? WHERE tenant_id = ? AND id = ?"),
  getMessageById: db.prepare("SELECT body FROM messages WHERE tenant_id = ? AND id = ?"),
  listMessages: db.prepare("SELECT * FROM messages WHERE tenant_id = ? AND jid = ? ORDER BY ts ASC LIMIT 500"),
  recentMessages: db.prepare("SELECT * FROM messages WHERE tenant_id = ? AND jid = ? ORDER BY ts DESC LIMIT ?"),
  countRecentAiReplies: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND jid = ? AND via = 'ai' AND ts > ?"),
  countMonthlyAiReplies: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND via = 'ai' AND ts > ?"),
  countMonthlyAutomatedConversations: db.prepare("SELECT COUNT(DISTINCT jid) AS n FROM messages WHERE tenant_id = ? AND via IN ('ai','rule','flow') AND ts > ?"),
  chatHasAutomationSince: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND jid = ? AND via IN ('ai','rule','flow') AND ts > ?"),

  // flows
  listFlows: db.prepare("SELECT * FROM flows WHERE tenant_id = ? ORDER BY id"),
  getFlow: db.prepare("SELECT * FROM flows WHERE id = ? AND tenant_id = ?"),
  addFlow: db.prepare("INSERT INTO flows (tenant_id, name, trigger_keyword, definition, active, created) VALUES (?, ?, ?, ?, 1, ?)"),
  updateFlow: db.prepare("UPDATE flows SET name = ?, trigger_keyword = ?, definition = ? WHERE id = ? AND tenant_id = ?"),
  toggleFlow: db.prepare("UPDATE flows SET active = ? WHERE id = ? AND tenant_id = ?"),
  deleteFlow: db.prepare("DELETE FROM flows WHERE id = ? AND tenant_id = ?"),
  activeFlows: db.prepare("SELECT * FROM flows WHERE tenant_id = ? AND active = 1"),

  // flow state
  getFlowState: db.prepare("SELECT * FROM flow_state WHERE tenant_id = ? AND jid = ?"),
  setFlowState: db.prepare(`INSERT INTO flow_state (tenant_id, jid, flow_id, node_id, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, jid) DO UPDATE SET flow_id = excluded.flow_id, node_id = excluded.node_id, updated = excluded.updated`),
  clearFlowState: db.prepare("DELETE FROM flow_state WHERE tenant_id = ? AND jid = ?"),

  // api keys
  setApiKey: db.prepare("UPDATE tenants SET api_key = ? WHERE id = ?"),
  tenantByApiKey: db.prepare("SELECT * FROM tenants WHERE api_key = ?"),

  // rules
  listRules: db.prepare("SELECT * FROM rules WHERE tenant_id = ? ORDER BY id"),
  addRule: db.prepare("INSERT INTO rules (tenant_id, keyword, reply, match_type, active) VALUES (?, ?, ?, ?, 1)"),
  toggleRule: db.prepare("UPDATE rules SET active = ? WHERE id = ? AND tenant_id = ?"),
  deleteRule: db.prepare("DELETE FROM rules WHERE id = ? AND tenant_id = ?"),

  // settings
  getSettingRow: db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = ?"),
  setSetting: db.prepare(`INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`),
  settingByKeyValue: db.prepare("SELECT tenant_id FROM settings WHERE key = ? AND value = ? LIMIT 1"),

  // agents
  listAgents: db.prepare("SELECT id, tenant_id, name, emoji, instructions, playbook, rules, model, active, created FROM agents WHERE tenant_id = ? ORDER BY id"),
  getAgent: db.prepare("SELECT * FROM agents WHERE id = ? AND tenant_id = ?"),
  addAgent: db.prepare("INSERT INTO agents (tenant_id, name, emoji, instructions, playbook, rules, model, openai_api_key, active, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)"),
  updateAgent: db.prepare("UPDATE agents SET name = ?, emoji = ?, instructions = ?, playbook = ?, rules = ?, model = ?, openai_api_key = ? WHERE id = ? AND tenant_id = ?"),
  toggleAgent: db.prepare("UPDATE agents SET active = ? WHERE id = ? AND tenant_id = ?"),
  deleteAgent: db.prepare("DELETE FROM agents WHERE id = ? AND tenant_id = ?"),

  // knowledge sources
  listKnowledge: db.prepare("SELECT id, tenant_id, agent_id, file_name, created FROM knowledge_sources WHERE tenant_id = ? ORDER BY id"),
  getKnowledgeForAgent: db.prepare("SELECT * FROM knowledge_sources WHERE tenant_id = ? AND agent_id = ?"),
  addKnowledge: db.prepare("INSERT INTO knowledge_sources (tenant_id, agent_id, file_name, content, created) VALUES (?, ?, ?, ?, ?)"),
  deleteKnowledge: db.prepare("DELETE FROM knowledge_sources WHERE id = ? AND tenant_id = ?"),

  // templates
  listTemplates: db.prepare("SELECT * FROM templates WHERE tenant_id = ? AND active = 1 ORDER BY name"),
  addTemplate: db.prepare("INSERT INTO templates (tenant_id, name, shortcut, body, active) VALUES (?, ?, ?, ?, 1)"),
  updateTemplate: db.prepare("UPDATE templates SET name = ?, shortcut = ?, body = ? WHERE id = ? AND tenant_id = ?"),
  deleteTemplate: db.prepare("DELETE FROM templates WHERE id = ? AND tenant_id = ?"),

  // tags
  listChatTags: db.prepare("SELECT tag FROM chat_tags WHERE tenant_id = ? AND jid = ?"),
  addChatTag: db.prepare("INSERT OR IGNORE INTO chat_tags (tenant_id, jid, tag) VALUES (?, ?, ?)"),
  removeChatTag: db.prepare("DELETE FROM chat_tags WHERE tenant_id = ? AND jid = ? AND tag = ?"),
  allTags: db.prepare("SELECT DISTINCT tag FROM chat_tags WHERE tenant_id = ? ORDER BY tag"),

  // notes
  listNotes: db.prepare("SELECT * FROM chat_notes WHERE tenant_id = ? AND jid = ? ORDER BY created DESC"),
  addNote: db.prepare("INSERT INTO chat_notes (tenant_id, jid, body, created) VALUES (?, ?, ?, ?)"),
  deleteNote: db.prepare("DELETE FROM chat_notes WHERE id = ? AND tenant_id = ?"),

  // webhook events
  logWebhookEvent: db.prepare("INSERT INTO webhook_events (id, tenant_id, payload, created) VALUES (?, ?, ?, ?)"),

  // ── Follow-up sequences ──
  listSequences: db.prepare("SELECT * FROM sequences WHERE tenant_id = ? ORDER BY id DESC"),
  getSequence: db.prepare("SELECT * FROM sequences WHERE id = ? AND tenant_id = ?"),
  addSequence: db.prepare("INSERT INTO sequences (tenant_id, name, trigger_type, trigger_value, active, created) VALUES (?, ?, ?, ?, 1, ?)"),
  updateSequence: db.prepare("UPDATE sequences SET name = ?, trigger_type = ?, trigger_value = ? WHERE id = ? AND tenant_id = ?"),
  toggleSequence: db.prepare("UPDATE sequences SET active = ? WHERE id = ? AND tenant_id = ?"),
  deleteSequence: db.prepare("DELETE FROM sequences WHERE id = ? AND tenant_id = ?"),
  activeSequencesByTrigger: db.prepare("SELECT * FROM sequences WHERE tenant_id = ? AND active = 1 AND trigger_type = ?"),

  listSequenceSteps: db.prepare("SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY step_order"),
  addSequenceStep: db.prepare("INSERT INTO sequence_steps (sequence_id, step_order, delay_minutes, body) VALUES (?, ?, ?, ?)"),
  deleteSequenceSteps: db.prepare("DELETE FROM sequence_steps WHERE sequence_id = ?"),
  countSequenceSteps: db.prepare("SELECT COUNT(*) AS n FROM sequence_steps WHERE sequence_id = ?"),

  // enrollments
  enrollContact: db.prepare("INSERT INTO sequence_enrollments (tenant_id, sequence_id, jid, current_step, next_run_ts, status, created) VALUES (?, ?, ?, 0, ?, 'active', ?)"),
  isEnrolled: db.prepare("SELECT id FROM sequence_enrollments WHERE tenant_id = ? AND sequence_id = ? AND jid = ? AND status = 'active'"),
  dueEnrollments: db.prepare("SELECT * FROM sequence_enrollments WHERE status = 'active' AND next_run_ts <= ? ORDER BY next_run_ts LIMIT 50"),
  advanceEnrollment: db.prepare("UPDATE sequence_enrollments SET current_step = ?, next_run_ts = ?, status = ? WHERE id = ?"),
  stopEnrollmentsForChat: db.prepare("UPDATE sequence_enrollments SET status = 'stopped' WHERE tenant_id = ? AND jid = ? AND status = 'active'"),
  countActiveEnrollments: db.prepare("SELECT COUNT(*) AS n FROM sequence_enrollments WHERE tenant_id = ? AND sequence_id = ? AND status = 'active'"),

  // ── Broadcasts ──
  listBroadcasts: db.prepare("SELECT * FROM broadcasts WHERE tenant_id = ? ORDER BY id DESC"),
  getBroadcast: db.prepare("SELECT * FROM broadcasts WHERE id = ? AND tenant_id = ?"),
  addBroadcast: db.prepare("INSERT INTO broadcasts (tenant_id, name, body, segment_type, segment_value, status, total, created) VALUES (?, ?, ?, ?, ?, 'draft', 0, ?)"),
  setBroadcastStatus: db.prepare("UPDATE broadcasts SET status = ? WHERE id = ? AND tenant_id = ?"),
  setBroadcastTotal: db.prepare("UPDATE broadcasts SET total = ? WHERE id = ?"),
  incBroadcastSent: db.prepare("UPDATE broadcasts SET sent = sent + 1 WHERE id = ?"),
  incBroadcastFailed: db.prepare("UPDATE broadcasts SET failed = failed + 1 WHERE id = ?"),
  deleteBroadcast: db.prepare("DELETE FROM broadcasts WHERE id = ? AND tenant_id = ?"),
  sendingBroadcasts: db.prepare("SELECT * FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 20"),

  addBroadcastRecipient: db.prepare("INSERT INTO broadcast_recipients (broadcast_id, tenant_id, jid, name, status) VALUES (?, ?, ?, ?, 'pending')"),
  pendingRecipients: db.prepare("SELECT * FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending' LIMIT ?"),
  countPendingRecipients: db.prepare("SELECT COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending'"),
  markRecipientSent: db.prepare("UPDATE broadcast_recipients SET status = 'sent', sent_ts = ? WHERE id = ?"),
  markRecipientFailed: db.prepare("UPDATE broadcast_recipients SET status = 'failed', sent_ts = ? WHERE id = ?"),
  deleteBroadcastRecipients: db.prepare("DELETE FROM broadcast_recipients WHERE broadcast_id = ?"),

  // segment resolvers
  chatsByLifecycle: db.prepare("SELECT jid, name FROM chats WHERE tenant_id = ? AND lifecycle = ?"),
  chatsByTag: db.prepare("SELECT c.jid, c.name FROM chats c JOIN chat_tags t ON c.tenant_id = t.tenant_id AND c.jid = t.jid WHERE c.tenant_id = ? AND t.tag = ?"),
  chatsUnread: db.prepare("SELECT jid, name FROM chats WHERE tenant_id = ? AND unread > 0"),
  chatsAll: db.prepare("SELECT jid, name FROM chats WHERE tenant_id = ?"),

  // ── Analytics ──
  anLifecycle: db.prepare("SELECT lifecycle, COUNT(*) AS n FROM chats WHERE tenant_id = ? GROUP BY lifecycle"),
  anTotalChats: db.prepare("SELECT COUNT(*) AS n FROM chats WHERE tenant_id = ?"),
  anActiveChats: db.prepare("SELECT COUNT(*) AS n FROM chats WHERE tenant_id = ? AND last_ts > ?"),
  anMsgByDir: db.prepare("SELECT from_me, COUNT(*) AS n FROM messages WHERE tenant_id = ? AND ts > ? GROUP BY from_me"),
  anMsgByVia: db.prepare("SELECT via, COUNT(*) AS n FROM messages WHERE tenant_id = ? AND ts > ? GROUP BY via"),
  anDaily: db.prepare("SELECT date(ts/1000,'unixepoch','localtime') AS d, SUM(CASE WHEN from_me=0 THEN 1 ELSE 0 END) AS inbound, SUM(CASE WHEN from_me=1 THEN 1 ELSE 0 END) AS outbound FROM messages WHERE tenant_id = ? AND ts > ? GROUP BY d ORDER BY d"),

  // ── Global app settings (admin) ──
  getApp: db.prepare("SELECT value FROM app_settings WHERE key = ?"),
  setApp: db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),

  // ── Super-admin queries ──
  allTenants: db.prepare("SELECT * FROM tenants ORDER BY created DESC"),
  ownerOfOrg: db.prepare("SELECT u.email, u.name, u.id FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'owner' ORDER BY m.created LIMIT 1"),
  memberCountOrg: db.prepare("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?"),
  msgCountOrg: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ?"),
  chatCountOrg: db.prepare("SELECT COUNT(*) AS n FROM chats WHERE tenant_id = ?"),
  allUsers: db.prepare("SELECT id, email, name, is_admin, created FROM users ORDER BY created DESC"),
  countAllUsers: db.prepare("SELECT COUNT(*) AS n FROM users"),
  countAllTenants: db.prepare("SELECT COUNT(*) AS n FROM tenants"),
  countTenantsByPlan: db.prepare("SELECT plan, COUNT(*) AS n FROM tenants GROUP BY plan"),
  recentTenants: db.prepare("SELECT * FROM tenants ORDER BY created DESC LIMIT 8"),
  setUserAdmin: db.prepare("UPDATE users SET is_admin = ? WHERE id = ?"),
  deleteTenant: db.prepare("DELETE FROM tenants WHERE id = ?"),
  deleteOrgMembers: db.prepare("DELETE FROM org_members WHERE org_id = ?"),
  signupsSince: db.prepare("SELECT date(created/1000,'unixepoch','localtime') AS d, COUNT(*) AS n FROM tenants WHERE created > ? GROUP BY d ORDER BY d"),

  // ── Appointments / bookings ──
  listAppointments: db.prepare("SELECT * FROM appointments WHERE tenant_id = ? ORDER BY start_ts"),
  upcomingAppointments: db.prepare("SELECT * FROM appointments WHERE tenant_id = ? AND start_ts > ? ORDER BY start_ts"),
  addAppointment: db.prepare("INSERT INTO appointments (tenant_id, jid, contact_name, title, start_ts, duration, status, notes, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  updateAppointment: db.prepare("UPDATE appointments SET title = ?, contact_name = ?, start_ts = ?, duration = ?, status = ?, notes = ? WHERE id = ? AND tenant_id = ?"),
  deleteAppointment: db.prepare("DELETE FROM appointments WHERE id = ? AND tenant_id = ?"),
  dueReminders: db.prepare("SELECT * FROM appointments WHERE status = 'confirmed' AND reminded = 0 AND start_ts > ? AND start_ts <= ?"),
  markReminded: db.prepare("UPDATE appointments SET reminded = 1 WHERE id = ?"),

  // ── Payments ──
  listPayments: db.prepare("SELECT * FROM payments WHERE tenant_id = ? ORDER BY id DESC LIMIT 100"),
  addPayment: db.prepare("INSERT INTO payments (tenant_id, jid, contact_name, amount, currency, description, url, status, provider, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  setPaymentStatus: db.prepare("UPDATE payments SET status = ?, paid_ts = ? WHERE id = ? AND tenant_id = ?"),

  // ── Lead sources (click-to-WhatsApp) ──
  listLeadSources: db.prepare("SELECT * FROM lead_sources WHERE tenant_id = ? ORDER BY id DESC"),
  getLeadSourceByRef: db.prepare("SELECT * FROM lead_sources WHERE tenant_id = ? AND ref = ? LIMIT 1"),
  addLeadSource: db.prepare("INSERT INTO lead_sources (tenant_id, name, ref, prefill, created) VALUES (?, ?, ?, ?, ?)"),
  deleteLeadSource: db.prepare("DELETE FROM lead_sources WHERE id = ? AND tenant_id = ?"),
  incLeadSourceLead: db.prepare("UPDATE lead_sources SET leads = leads + 1 WHERE id = ?"),
};

export function getSetting(tenantId, key) {
  const row = q.getSettingRow.get(tenantId, key);
  if (row) return row.value;
  return DEFAULT_SETTINGS[key] ?? null;
}

export function newId() {
  return crypto.randomBytes(12).toString("hex");
}

/* Default pipeline stages, seeded on first access per organization. */
export const DEFAULT_STAGES = [
  { name: "Lead", is_won: 0, is_lost: 0 },
  { name: "Qualified", is_won: 0, is_lost: 0 },
  { name: "Proposal", is_won: 0, is_lost: 0 },
  { name: "Negotiation", is_won: 0, is_lost: 0 },
  { name: "Won", is_won: 1, is_lost: 0 },
  { name: "Lost", is_won: 0, is_lost: 1 },
];

export function ensureStages(tenantId) {
  if (q.countStages.get(tenantId).n === 0) {
    DEFAULT_STAGES.forEach((s, i) => q.addStage.run(tenantId, s.name, i, s.is_won, s.is_lost));
  }
}

function monthStartTs() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function convQuota(tenant) {
  const plans = getPlans();
  const plan = plans[tenant.plan] || plans.trial;
  const { n } = q.countMonthlyAutomatedConversations.get(tenant.id, monthStartTs());
  return { allowed: n < plan.convPerMonth, used: n, limit: plan.convPerMonth };
}

export function chatCounted(tenantId, jid) {
  const { n } = q.chatHasAutomationSince.get(tenantId, jid, monthStartTs());
  return n > 0;
}

export function automationAllowed(tenant, jid) {
  if (chatCounted(tenant.id, jid)) return true;
  return convQuota(tenant).allowed;
}

export function tenantActive(tenant) {
  if (!tenant || tenant.status !== "active") return false;
  if (tenant.plan === "trial") return Date.now() < (tenant.trial_ends || 0);
  return true;
}

export default db;
