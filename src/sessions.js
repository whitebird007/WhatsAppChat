import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { fileURLToPath } from "url";
import { q, getSetting, automationAllowed, convQuota, tenantActive } from "./db.js";
import { runFlows } from "./flows.js";
import { matchRule } from "./rules.js";
import { generateReply } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_ROOT = path.join(__dirname, "..", "auth");
const MEDIA_ROOT = path.join(__dirname, "..", "public", "media");
const AVATAR_ROOT = path.join(__dirname, "..", "public", "avatars");
const silentLogger = pino({ level: "silent" });

/* Fetch a contact's WhatsApp profile photo (if public) and cache it locally.
   Fire-and-forget; only runs when we don't already have one. */
async function fetchAvatar(tenantId, jid, sock) {
  try {
    const chat = q.getChat.get(tenantId, jid);
    if (chat?.profile_pic) return; // already have one
    const url = await sock.profilePictureUrl(jid, "image").catch(() => null);
    if (!url) return;
    const res = await fetch(url);
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    const dir = path.join(AVATAR_ROOT, tenantId.replace(/[^a-z0-9]/gi, ""));
    fs.mkdirSync(dir, { recursive: true });
    const fname = `${jid.replace(/[^a-z0-9]/gi, "_")}.jpg`;
    fs.writeFileSync(path.join(dir, fname), buf);
    const rel = `/avatars/${tenantId.replace(/[^a-z0-9]/gi, "")}/${fname}`;
    q.setChatAvatar.run(rel, tenantId, jid);
    broadcast(tenantId, { type: "avatar", data: { jid, url: rel } });
  } catch (err) { /* private pic / not authorized — ignore */ }
}

/* Map a WhatsApp media message node → a file extension + friendly label. */
const MEDIA_KINDS = {
  imageMessage: "image", videoMessage: "video", audioMessage: "audio",
  documentMessage: "document", stickerMessage: "sticker",
};
function extFromMime(mime, kind) {
  const sub = (mime || "").split(";")[0].split("/")[1] || "";
  const map = { jpeg: "jpg", mpeg: "mp3", "x-m4a": "m4a", quicktime: "mov", "svg+xml": "svg", plain: "txt" };
  if (map[sub]) return map[sub];
  if (sub) return sub.replace(/[^a-z0-9]/gi, "") || "bin";
  return kind === "audio" ? "ogg" : kind === "image" ? "jpg" : kind === "video" ? "mp4" : "bin";
}

/* Convert any recorded/uploaded audio (e.g. browser WebM/Opus) into the
   OGG/Opus mono format WhatsApp requires for voice notes. Returns a Buffer. */
function transcodeToOpusOgg(inputBuffer) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg not available"));
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inPath = path.join(os.tmpdir(), `wa-in-${id}`);
    const outPath = path.join(os.tmpdir(), `wa-out-${id}.ogg`);
    const cleanup = () => { try { fs.unlinkSync(inPath); } catch {} try { fs.unlinkSync(outPath); } catch {} };
    try { fs.writeFileSync(inPath, inputBuffer); } catch (e) { return reject(e); }
    execFile(
      ffmpegPath,
      ["-y", "-hide_banner", "-loglevel", "error", "-i", inPath, "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", outPath],
      { timeout: 30000 },
      (err) => {
        if (err) { cleanup(); return reject(err); }
        try { const out = fs.readFileSync(outPath); cleanup(); resolve(out); }
        catch (e) { cleanup(); reject(e); }
      }
    );
  });
}

/* Download an incoming media message, save it under /public/media, return its info (or null). */
async function saveIncomingMedia(tenantId, msg, sock) {
  const m = msg.message || {};
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  const typeKey = Object.keys(MEDIA_KINDS).find((k) => inner[k]);
  if (!typeKey) return null;
  const node = inner[typeKey];
  const kind = MEDIA_KINDS[typeKey];
  let buffer;
  try {
    buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage });
  } catch (err) { console.error(`[media:${tenantId}] download failed:`, err.message); return null; }
  if (!buffer) return null;

  const mime = node.mimetype || (kind === "audio" ? "audio/ogg" : kind === "image" ? "image/jpeg" : "application/octet-stream");
  const id = (msg.key?.id || `m${Date.now()}`).replace(/[^a-z0-9]/gi, "");
  const fileName = node.fileName || (kind === "audio" && node.ptt ? "Voice note" : `${kind}.${extFromMime(mime, kind)}`);
  const stored = `${id}.${extFromMime(mime, kind)}`;
  const dir = path.join(MEDIA_ROOT, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, stored), buffer);

  const body = node.caption || (kind === "audio" && node.ptt ? "🎤 Voice message"
    : kind === "image" ? "📷 Photo" : kind === "video" ? "🎬 Video"
    : kind === "document" ? `📎 ${fileName}` : kind === "sticker" ? "🌟 Sticker" : "📎 Attachment");
  return { mime_type: mime, file_name: fileName, media_url: `/media/${tenantId}/${stored}`, body };
}

/** tenantId -> { sock, status, qrDataUrl, me, stopping } */
const sessions = new Map();

let broadcast = (tenantId, event) => {};
export function onEvent(fn) {
  broadcast = fn;
}

export function getSessionStatus(tenantId) {
  const s = sessions.get(tenantId);
  return {
    status: s?.status || "disconnected",
    qr: s?.qrDataUrl || null,
    me: s?.me || null,
  };
}

/** True when the tenant's WhatsApp socket is live. Used by the automation scheduler. */
export function isConnected(tenantId) {
  return sessions.get(tenantId)?.status === "connected";
}

/** How many tenants currently have a live WhatsApp connection (for the admin panel). */
export function connectedCount() {
  let n = 0;
  for (const s of sessions.values()) if (s.status === "connected") n++;
  return n;
}

/* Best-effort: pull WhatsApp's numeric rejection code (e.g. 463) out of a failed update. */
function extractErrorCode(u) {
  try {
    const s = JSON.stringify(u);
    const m = s.match(/"(?:error|code|errorCode)"\s*:\s*"?(\d{3})"?/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

export async function startSession(tenantId) {
  const existing = sessions.get(tenantId);
  if (existing && ["connected", "connecting", "qr"].includes(existing.status)) {
    return; // already running
  }

  const authDir = path.join(AUTH_ROOT, tenantId);
  fs.mkdirSync(authDir, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // Required by WhatsApp: when a recipient's device asks to re-send a message
    // (after an encryption-session reset), Baileys calls this to get the content.
    // Without it, those messages silently never arrive even though they look "sent".
    getMessage: async (key) => {
      try {
        const row = q.getMessageById.get(tenantId, key.id);
        return row ? { conversation: row.body } : undefined;
      } catch { return undefined; }
    },
  });

  const session = { sock, status: "connecting", qrDataUrl: null, me: null, stopping: false };
  sessions.set(tenantId, session);
  broadcast(tenantId, { type: "status", data: getSessionStatus(tenantId) });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.status = "qr";
      session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      broadcast(tenantId, { type: "status", data: getSessionStatus(tenantId) });
    }

    if (connection === "open") {
      session.status = "connected";
      session.qrDataUrl = null;
      session.me = sock.user?.id?.split(":")[0] || null;
      broadcast(tenantId, { type: "status", data: getSessionStatus(tenantId) });
      console.log(`[wa:${tenantId}] connected as ${session.me}`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      session.status = "disconnected";
      session.qrDataUrl = null;
      broadcast(tenantId, { type: "status", data: getSessionStatus(tenantId) });
      if (loggedOut) {
        fs.rmSync(authDir, { recursive: true, force: true });
        sessions.delete(tenantId);
      } else if (!session.stopping) {
        setTimeout(() => startSession(tenantId).catch(console.error), 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleMessage(tenantId, sock, msg);
      } catch (err) {
        console.error(`[wa:${tenantId}] message error:`, err.message);
      }
    }
  });

  // Delivery receipts: WhatsApp reports sent → delivered → read for our outgoing messages.
  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      const st = u.update?.status;
      if (st == null || !u.key?.id || !u.key?.fromMe) continue;
      const status = typeof st === "number" ? st : ({ PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5, ERROR: 0 }[st] ?? null);
      if (status == null) continue;
      q.setMessageStatus.run(status, tenantId, u.key.id);
      broadcast(tenantId, { type: "status_update", data: { jid: u.key.remoteJid, id: u.key.id, status } });
      if (status === 0) {
        // Try to surface WhatsApp's actual rejection code from the update payload.
        const code = u.update?.code ?? u.update?.errorCode ?? extractErrorCode(u) ?? null;
        console.error(`[wa:${tenantId}] delivery FAILED for ${u.key.id} → ${u.key.remoteJid}${code ? ` (code ${code})` : ""}`);
        broadcast(tenantId, { type: "delivery_problem", data: { jid: u.key.remoteJid, id: u.key.id, code } });
      }
    }
  });
}

function phoneFromJid(jid) {
  if (jid && jid.endsWith("@s.whatsapp.net")) return jid.split("@")[0].split(":")[0];
  return null;
}
/* If a chat already exists for this phone under a different JID, return that JID. */
function canonicalJid(tenantId, jid) {
  const phone = phoneFromJid(jid);
  if (phone) {
    const ex = q.getChatByPhone.get(tenantId, phone);
    if (ex && ex.jid !== jid) return ex.jid;
  }
  return jid;
}

async function handleMessage(tenantId, sock, msg) {
  let jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return;

  const fromMe = !!msg.key.fromMe;
  const ts = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;

  // Prevent duplicate threads for one contact (the @lid vs @s.whatsapp.net problem):
  // figure out the phone, and if a chat already exists for that phone under another
  // JID, file this message under the EXISTING chat instead of making a new one.
  let phone = phoneFromJid(jid);
  if (!phone && jid.endsWith("@lid")) {
    const alt = msg.key.remoteJidAlt || msg.key.senderPn || null;
    phone = phoneFromJid(alt);
  }
  if (phone) {
    const existing = q.getChatByPhone.get(tenantId, phone);
    if (existing && existing.jid !== jid) jid = existing.jid; // refile under the canonical chat
  }

  // Text and/or media — download any attachment (photo, video, voice note, document)
  const text = extractText(msg);
  const media = await saveIncomingMedia(tenantId, msg, sock);
  if (!text && !media) return; // not a message type we handle (reactions, receipts, etc.)

  const body = text || media?.body || "";

  q.insertMessage.run({
    id: msg.key.id,
    tenant_id: tenantId,
    jid,
    from_me: fromMe ? 1 : 0,
    body,
    ts,
    via: fromMe ? "human" : "customer",
    mime_type: media?.mime_type || null,
    file_name: media?.file_name || null,
    media_url: media?.media_url || null,
    status: fromMe ? 2 : null,
  });
  q.upsertChat.run({
    tenant_id: tenantId,
    jid,
    name: msg.pushName || null,
    last_msg: body,
    last_ts: ts,
    unread: fromMe ? 0 : 1,
  });
  if (phone) { try { q.setChatPhone.run(phone, tenantId, jid); } catch {} }
  fetchAvatar(tenantId, jid, sock).catch(() => {}); // fire-and-forget profile photo
  broadcast(tenantId, {
    type: "message",
    data: { jid, from_me: fromMe, body, ts, name: msg.pushName || null,
      mime_type: media?.mime_type || null, file_name: media?.file_name || null, media_url: media?.media_url || null,
      id: msg.key.id, status: fromMe ? 2 : null },
  });

  if (fromMe) return;

  // A customer reply cancels any active follow-up drip so we never nag a live conversation
  try {
    const { onCustomerReply } = await import("./automation.js");
    onCustomerReply(tenantId, jid);
  } catch {}

  // Click-to-WhatsApp source tracking: a lead arriving from a tracked link carries "(ref: xxx)"
  const refMatch = (text || "").match(/\(ref:\s*([a-z0-9]+)\)/i);
  if (refMatch) {
    const src = q.getLeadSourceByRef.get(tenantId, refMatch[1].toLowerCase());
    if (src) {
      q.addChatTag.run(tenantId, jid, src.name.toLowerCase());
      q.incLeadSourceLead.run(src.id);
    }
  }

  // Outbound webhook (Make.com / Zapier) — fire and forget
  fireWebhook(tenantId, { event: "message.received", jid, name: msg.pushName || null, text, ts });

  const tenant = q.tenantById.get(tenantId);
  if (!tenantActive(tenant)) return; // trial expired / canceled: inbox works, automation off

  // Conversation-based quota: unlimited replies inside counted chats,
  // block only when a NEW conversation would exceed the plan.
  if (!automationAllowed(tenant, jid)) {
    broadcast(tenantId, { type: "quota_exceeded", data: convQuota(tenant) });
    return;
  }

  // 1) Flows (multi-step sequences) take priority
  const flowEffects = {
    handoff: () => {
      q.upsertChat.run({ tenant_id: tenantId, jid, name: null, last_msg: body, last_ts: ts, unread: 1 });
      broadcast(tenantId, { type: "handoff", data: { jid } });
      fireWebhook(tenantId, { event: "handoff.requested", jid, ts: Date.now() });
    },
    enableAi: () => q.setChatAi.run(1, tenantId, jid),
  };
  const handledByFlow = await runFlows(
    tenantId, jid, text || "",
    (t) => sendText(tenantId, jid, t, "flow"),
    flowEffects
  );
  if (handledByFlow) return;

  // 2) Keyword rules
  const ruleReply = matchRule(tenantId, text || "");
  if (ruleReply) {
    await sendText(tenantId, jid, ruleReply, "rule");
    return;
  }

  // 3) AI agent
  const globalAi = getSetting(tenantId, "ai_global_enabled") === "1";
  const chat = q.getChat.get(tenantId, jid);
  if (globalAi && chat?.ai_enabled) {
    const reply = await generateReply(tenantId, jid);
    if (reply) {
      // Human-like: show "typing…", then wait ~3–10s scaled to reply length, then send.
      try { await sock.sendPresenceUpdate("composing", jid); } catch {}
      const delay = Math.min(10000, 2500 + reply.length * 35 + Math.random() * 1500);
      await new Promise((r) => setTimeout(r, delay));
      try { await sock.sendPresenceUpdate("paused", jid); } catch {}
      await sendText(tenantId, jid, reply, "ai");
    }
  }
}

/** POST events to the tenant's webhook URL (for Make.com, Zapier, n8n). */
function fireWebhook(tenantId, payload) {
  const url = getSetting(tenantId, "webhook_url");
  if (!url || !/^https:\/\//.test(url)) return;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  }).catch((err) => console.error(`[webhook:${tenantId}]`, err.message));
}

export async function sendText(tenantId, jid, text, via = "human") {
  const session = sessions.get(tenantId);
  if (!session || session.status !== "connected") {
    throw new Error("WhatsApp is not connected");
  }
  jid = canonicalJid(tenantId, jid);
  let sent;
  try {
    sent = await session.sock.sendMessage(jid, { text });
    console.log(`[wa:${tenantId}] SENT text → ${jid} (id ${sent?.key?.id})`);
  } catch (err) {
    console.error(`[wa:${tenantId}] SEND FAILED → ${jid}: ${err.message}`);
    broadcast(tenantId, { type: "delivery_problem", data: { jid, id: null, code: null, reason: err.message } });
    throw err;
  }
  const ts = Date.now();
  const id = sent?.key?.id || `local-${ts}`;
  q.insertMessage.run({
    id,
    tenant_id: tenantId,
    jid,
    from_me: 1,
    body: text,
    ts,
    via,
    mime_type: null,
    file_name: null,
    media_url: null,
    status: 2,
  });
  q.upsertChat.run({ tenant_id: tenantId, jid, name: null, last_msg: text, last_ts: ts, unread: 0 });
  broadcast(tenantId, { type: "message", data: { jid, from_me: true, body: text, ts, via, id, status: 2 } });
  return sent;
}

/* Save an outgoing media buffer so it can be displayed in the chat afterwards. */
function saveOutgoingMedia(tenantId, buffer, mimeType, kind) {
  const id = `out${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const stored = `${id}.${extFromMime(mimeType, kind)}`;
  const dir = path.join(MEDIA_ROOT, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, stored), buffer);
  return `/media/${tenantId}/${stored}`;
}

/**
 * Send a media file (image, document, video, audio, or voice note) to a JID.
 * Pass voice=true to send a true WhatsApp voice message (push-to-talk).
 */
export async function sendMedia(tenantId, jid, buffer, mimeType, fileName, caption = "", voice = false) {
  const session = sessions.get(tenantId);
  if (!session || session.status !== "connected") throw new Error("WhatsApp is not connected");
  jid = canonicalJid(tenantId, jid);

  let msgContent, kind;
  if (mimeType.startsWith("image/")) { msgContent = { image: buffer, caption, mimetype: mimeType }; kind = "image"; }
  else if (mimeType.startsWith("video/")) { msgContent = { video: buffer, caption, mimetype: mimeType }; kind = "video"; }
  else if (mimeType.startsWith("audio/")) {
    kind = "audio";
    if (voice) {
      // WhatsApp voice notes must be real OGG/Opus — transcode the browser recording.
      buffer = await transcodeToOpusOgg(buffer);
      mimeType = "audio/ogg; codecs=opus";
    }
    msgContent = { audio: buffer, mimetype: mimeType, ptt: !!voice };
  }
  else { msgContent = { document: buffer, mimetype: mimeType, fileName, caption }; kind = "document"; }

  let sent;
  try {
    sent = await session.sock.sendMessage(jid, msgContent);
    console.log(`[wa:${tenantId}] SENT ${kind} → ${jid} (id ${sent?.key?.id})`);
  } catch (err) {
    console.error(`[wa:${tenantId}] SEND ${kind} FAILED → ${jid}: ${err.message}`);
    broadcast(tenantId, { type: "delivery_problem", data: { jid, id: null, code: null, reason: err.message } });
    throw err;
  }
  const ts = Date.now();
  const id = sent?.key?.id || `local-${ts}`;
  const media_url = saveOutgoingMedia(tenantId, buffer, mimeType, kind);
  const body = caption || (voice ? "🎤 Voice message" : fileName) || "📎 Attachment";
  q.insertMessage.run({
    id,
    tenant_id: tenantId,
    jid,
    from_me: 1,
    body,
    ts,
    via: "human",
    mime_type: mimeType,
    file_name: voice ? "Voice note" : fileName,
    media_url,
    status: 2,
  });
  q.upsertChat.run({ tenant_id: tenantId, jid, name: null, last_msg: body, last_ts: ts, unread: 0 });
  broadcast(tenantId, { type: "message", data: { jid, from_me: true, body, ts, via: "human", mime_type: mimeType, file_name: voice ? "Voice note" : fileName, media_url, id, status: 2 } });
  return sent;
}

/**
 * Proactively open a chat and send a message to any phone number.
 * Creates the chat record if it doesn't exist.
 */
export async function sendToPhone(tenantId, phone, text, via = "api") {
  const digits = String(phone).replace(/[^0-9]/g, "");
  if (!digits) throw new Error("Invalid phone number");
  const jid = `${digits}@s.whatsapp.net`;
  return sendText(tenantId, jid, text, via);
}

export async function stopSession(tenantId, { logout = false } = {}) {
  const session = sessions.get(tenantId);
  if (session) {
    session.stopping = true;
    try {
      if (logout) await session.sock.logout();
      else session.sock.end?.();
    } catch {}
    sessions.delete(tenantId);
  }
  // On a full logout, ALWAYS wipe the auth folder so the next pairing starts from a
  // clean encryption session. (A broken/corrupted session can't log out cleanly, so
  // we can't rely on the loggedOut event to remove it.) This fixes PreKeyError /
  // "Invalid PreKey ID" / 463 tctoken issues caused by stale Signal state.
  if (logout) {
    try {
      const authDir = path.join(AUTH_ROOT, tenantId);
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log(`[wa:${tenantId}] auth state wiped — fresh QR required`);
    } catch (err) { console.error(`[wa:${tenantId}] auth wipe failed:`, err.message); }
  }
  broadcast(tenantId, { type: "status", data: getSessionStatus(tenantId) });
}

/** On server boot, resume sessions for tenants that have linked WhatsApp before. */
export function resumeAllSessions() {
  if (!fs.existsSync(AUTH_ROOT)) return;
  for (const tenantId of fs.readdirSync(AUTH_ROOT)) {
    const tenant = q.tenantById.get(tenantId);
    if (tenant && tenant.status === "active") {
      startSession(tenantId).catch((err) =>
        console.error(`[wa:${tenantId}] resume failed:`, err.message)
      );
    }
  }
}
