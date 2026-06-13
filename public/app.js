/* Zaply — Frontend v2 */
"use strict";

/* ============================================================
   AUTH
   ============================================================ */
const TOKEN = localStorage.getItem("token");
if (!TOKEN) location.href = "/login.html";

// Private per-tenant uploads (media + avatars) require the auth token in the URL,
// since <img>/<audio> tags can't send an Authorization header.
function mediaUrl(u) {
  if (!u || typeof u !== "string") return u;
  if (u.startsWith("/media/") || u.startsWith("/avatars/")) {
    return u + (u.includes("?") ? "&" : "?") + "t=" + encodeURIComponent(TOKEN);
  }
  return u;
}

const $ = (id) => document.getElementById(id);

/* ============================================================
   API HELPER
   ============================================================ */
async function api(method, path, body, isFormData = false) {
  const opts = {
    method,
    headers: isFormData ? { authorization: `Bearer ${TOKEN}` } : { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  };
  if (body) opts.body = isFormData ? body : JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { localStorage.removeItem("token"); location.href = "/login.html"; return; }
  return res.json();
}
const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const PUT = (p, b) => api("PUT", p, b);
const DELETE = (p) => api("DELETE", p);
const POSTFORM = (p, fd) => api("POST", p, fd, true); // multipart upload with auth

/* ============================================================
   TOAST
   ============================================================ */
function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast${type ? " " + type : ""}`;
  el.textContent = msg;
  $("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ============================================================
   NOTIFICATION SOUND (incoming message ping)
   ============================================================ */
let soundOn = localStorage.getItem("zaply_sound") !== "0";
let _audioCtx = null;
let _lastPing = 0;
function notifyPing() {
  if (!soundOn) return;
  const now = Date.now();
  if (now - _lastPing < 1200) return; // don't machine-gun on bursts
  _lastPing = now;
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    // Two-tone "ti-doo" chime, soft attack/decay.
    const notes = [[880, 0], [1318.5, 0.12]];
    for (const [freq, at] of notes) {
      const t = ctx.currentTime + at;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.24);
    }
  } catch {}
}
function updateSoundBtn() {
  const b = $("soundToggle");
  if (!b) return;
  b.classList.toggle("muted", !soundOn);
  b.title = soundOn ? "Sound on for new messages — click to mute" : "Sound muted — click to enable";
  b.innerHTML = soundOn
    ? `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7M18.5 6a8 8 0 010 12"/></svg>`
    : `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>`;
}

/* "Answer every chat with AI" (sleep mode) toggle in the Conversations panel */
function updateAllChatsBar() {
  const bar = $("allChatsBar");
  if (!bar) return;
  bar.classList.toggle("on", aiAllChats);
  bar.setAttribute("aria-checked", String(aiAllChats));
  const sub = $("allChatsSub");
  if (sub) sub.textContent = aiAllChats
    ? "On — AI is answering every chat"
    : "Sleep mode — turn AI on for every conversation";
}
if ($("allChatsBar")) {
  $("allChatsBar").addEventListener("click", async () => {
    const next = !aiAllChats;
    aiAllChats = next;
    updateAllChatsBar();
    renderChatList();
    const r = await POST("/api/ai/all-chats", { enabled: next });
    if (r?.ok) {
      toast(next ? "AI is now answering every chat" : "AI on-all-chats turned off", "success");
    } else {
      aiAllChats = !next; updateAllChatsBar(); renderChatList(); // revert on failure
      toast("Couldn't update — try again", "error");
    }
    // Keep the Settings checkbox in sync if it's mounted
    if ($("aiAllChats")) $("aiAllChats").checked = aiAllChats;
  });
}

if ($("soundToggle")) {
  $("soundToggle").addEventListener("click", () => {
    soundOn = !soundOn;
    localStorage.setItem("zaply_sound", soundOn ? "1" : "0");
    updateSoundBtn();
    if (soundOn) notifyPing(); // confirm with a sample chime
  });
  updateSoundBtn();
}

/* ============================================================
   LIFECYCLE HELPERS
   ============================================================ */
const LIFECYCLE = {
  new_lead: { label: "New Lead", emoji: "🆕" },
  hot_lead: { label: "Hot Lead", emoji: "🔥" },
  payment:  { label: "Payment", emoji: "💰" },
  customer: { label: "Customer", emoji: "😊" },
  closed_won: { label: "Closed-Won", emoji: "🏆" },
};
function lifecycleBadge(lc) {
  const l = LIFECYCLE[lc] || LIFECYCLE.new_lead;
  return `<span class="lifecycle-badge lc-${lc}">${l.emoji} ${l.label}</span>`;
}

/* ============================================================
   AVATAR HELPERS
   ============================================================ */
const AV_CLASSES = ["av-a", "av-b", "av-c", "av-d"];
function avatarClass(jid) {
  let h = 0;
  for (const c of jid) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return AV_CLASSES[h % AV_CLASSES.length];
}
function initials(name, jid) {
  if (name) {
    const parts = name.trim().split(" ");
    return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
  }
  const digits = (jid || "").replace(/[^0-9]/g, "");
  return digits.slice(-2) || "??";
}

/* ============================================================
   VIEW ROUTING
   ============================================================ */
const VIEWS = ["chats", "agents", "rules", "settings", "billing", "flows", "integrations", "templates", "analytics", "sequences", "broadcasts", "contacts", "pipeline", "branding", "bookings", "leads"];

document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    VIEWS.forEach((v) => $(`view-${v}`).classList.toggle("hidden", v !== btn.dataset.view));
    const view = btn.dataset.view;
    activeView = view;
    updatePairingBanner();
    if (view === "rules") loadRules();
    if (view === "settings") loadSettings();
    if (view === "billing") loadBilling();
    if (view === "flows") loadFlows();
    if (view === "integrations") loadIntegrations();
    if (view === "agents") { loadAgents(); loadPacks(); }
    if (view === "templates") loadTemplates();
    if (view === "analytics") loadAnalytics();
    if (view === "sequences") loadSequences();
    if (view === "broadcasts") loadBroadcasts();
    if (view === "contacts") loadContacts();
    if (view === "pipeline") loadPipeline();
    if (view === "branding") loadBranding();
    if (view === "bookings") loadBookings();
    if (view === "leads") loadLeads();
  });
});

/* ============================================================
   CONNECTION STATUS / QR
   ============================================================ */
let connStatus = "connecting";
let activeView = "chats";
let aiAllChats = false; // global "answer every chat" switch (sleep mode)
// Effective AI state for a chat: a per-chat opt-out wins; otherwise global-all OR per-chat opt-in.
const chatAiOn = (c) => (c && c.ai_off ? false : (aiAllChats || !!(c && c.ai_enabled)));

function renderStatus(s) {
  const dot = $("connDot");
  const label = $("connLabel");
  const prevStatus = connStatus;
  connStatus = s.status;

  dot.className = "conn-dot";
  if (s.status === "connected") {
    dot.classList.add("connected");
    label.textContent = `Connected · ${s.me || ""}`;
    // Once linked, the QR is useless: auto-close the enlarged modal and clear it.
    $("qrModal").classList.add("hidden");
    $("qrModalImg").src = "";
    $("qrImg").src = "";
    if (prevStatus && prevStatus !== "connected") toast("WhatsApp connected", "success");
  } else if (s.status === "qr") {
    dot.classList.add("qr");
    label.textContent = "Scan QR code to connect";
    $("qrImg").src = s.qr || "";
    $("pairingNote").textContent = "Point your phone camera at the QR code";
  } else {
    label.textContent = "Not connected";
    $("qrImg").src = "";
    $("pairingNote").textContent = "Generate a QR code to link your WhatsApp";
  }
  updatePairingBanner();
}

// The pairing banner only shows on the Chats view while not connected.
function updatePairingBanner() {
  const show = activeView === "chats" && connStatus !== "connected";
  $("pairing").classList.toggle("hidden", !show);
}

// Click the small QR to open a large, easy-to-scan version
$("qrImg").addEventListener("click", () => {
  const src = $("qrImg").src;
  if (!src) return;
  $("qrModalImg").src = src;
  $("qrModal").classList.remove("hidden");
});
$("qrModalClose").addEventListener("click", () => $("qrModal").classList.add("hidden"));
$("qrModal").addEventListener("click", (e) => { if (e.target.id === "qrModal") $("qrModal").classList.add("hidden"); });

$("connectBtn").addEventListener("click", async () => {
  $("connectBtn").disabled = true;
  $("pairingNote").textContent = "Generating QR…";
  await POST("/api/connect");
  $("connectBtn").disabled = false;
});

$("logoutBtn").addEventListener("click", async () => {
  if (confirm("Disconnect your WhatsApp? You'll need to re-scan the QR code.")) {
    await POST("/api/logout");
  }
});
$("signoutBtn").addEventListener("click", () => {
  localStorage.removeItem("token");
  location.href = "/login.html";
});

/* ============================================================
   WEBSOCKET
   ============================================================ */
let ws, wsRetryMs = 1000;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => { wsRetryMs = 1000; };
  ws.onmessage = (e) => {
    try { handleWsEvent(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => { setTimeout(connectWs, wsRetryMs); wsRetryMs = Math.min(wsRetryMs * 2, 30000); };
}
connectWs();

function handleWsEvent({ type, data }) {
  if (type === "status") renderStatus(data);
  if (type === "message") handleIncomingMessage(data);
  if (type === "quota_exceeded") toast("Conversation quota reached — upgrade your plan", "error");
  if (type === "status_update") updateMessageTick(data);
  if (type === "delivery_problem") showDeliveryBanner(data);
  if (type === "ai_error") toast(`🤖 AI couldn't reply: ${data.message}. Check your OpenAI key in AI Agents.`, "error");
  if (type === "avatar") {
    const c = allChats.find((x) => x.jid === data.jid);
    if (c) { c.profile_pic = data.url; renderChatList(); }
    if (data.jid === activeJid) {
      const av = $("convAvatar");
      av.innerHTML = `<img class="avatar-img" src="${mediaUrl(data.url)}" alt="">`;
    }
  }
  if (type === "broadcast_progress") { if (!$("view-broadcasts").classList.contains("hidden")) loadBroadcasts(); }
  if (type === "broadcast_done") { toast(`✅ Broadcast "${data.name}" finished sending`, "success"); if (!$("view-broadcasts").classList.contains("hidden")) loadBroadcasts(); }
}

/* ============================================================
   CHAT LIST
   ============================================================ */
let allChats = [];
let activeJid = null;
let chatFilter = "all";
let lifecycleFilter = "";
let tagFilter = "";
let searchQuery = "";

async function loadChats() {
  const unread = chatFilter === "unread";
  allChats = await GET(`/api/chats${unread ? "?unread=1" : ""}`);
  populateTagFilter();
  renderChatList();
  updateUnreadBadge();
}

// Build the set of chats matching the active search + lifecycle + tag filters
function getFilteredChats() {
  const qlc = searchQuery.trim().toLowerCase();
  const qDigits = searchQuery.replace(/[^0-9]/g, "");
  return allChats.filter((c) => {
    if (lifecycleFilter && (c.lifecycle || "new_lead") !== lifecycleFilter) return false;
    if (tagFilter && !(c.tags || []).includes(tagFilter)) return false;
    if (qlc) {
      const name = (c.name || "").toLowerCase();
      const number = (c.jid || "").replace(/[^0-9]/g, "");
      const nameMatch = name.includes(qlc);
      const numMatch = qDigits && number.includes(qDigits);
      if (!nameMatch && !numMatch) return false;
    }
    return true;
  });
}

// Refresh the tag dropdown from whatever tags currently exist across chats
function populateTagFilter() {
  const sel = $("tagFilter");
  const tags = [...new Set(allChats.flatMap((c) => c.tags || []))].sort();
  const prev = tagFilter;
  sel.innerHTML = `<option value="">All tags</option>` +
    tags.map((t) => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join("");
  // keep current selection if it still exists
  if (prev && tags.includes(prev)) sel.value = prev;
  else if (prev) { tagFilter = ""; sel.value = ""; }
}

function updateFilterClear() {
  const active = lifecycleFilter || tagFilter || chatFilter === "unread";
  $("filterClear").classList.toggle("hidden", !active);
}

function renderChatList() {
  const container = $("chatItems");
  updateFilterClear();
  const visible = getFilteredChats();
  if (!visible.length) {
    const filtered = lifecycleFilter || tagFilter || chatFilter === "unread" || searchQuery.trim();
    const msg = searchQuery.trim()
      ? `No chats match “${escHtml(searchQuery.trim())}”.`
      : filtered ? "No conversations match these filters."
      : "No conversations yet. When customers message you, they appear here.";
    container.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  container.innerHTML = visible.map((c) => {
    const init = initials(c.name, c.jid);
    const avCls = avatarClass(c.jid);
    const tags = (c.tags || []).map((t) => `<span class="tag-chip" style="font-size:10px;padding:1px 7px">${t}</span>`).join("");
    const lc = c.lifecycle || "new_lead";
    return `<div class="chat-item${c.jid === activeJid ? " active" : ""}" data-jid="${c.jid}">
      <div class="chat-avatar ${avCls}">${c.profile_pic ? `<img class="avatar-img" src="${escHtml(mediaUrl(c.profile_pic))}" alt="">` : init}</div>
      <div class="chat-body">
        <div class="chat-top">
          <span class="chat-name">${escHtml(c.name || formatJid(c.jid))}</span>
          <span class="chat-time">${formatTime(c.last_ts)}</span>
        </div>
        <div class="chat-preview">${escHtml(c.last_msg || "")}</div>
        <div class="chat-badges" style="gap:4px;margin-top:4px">
          ${c.unread ? `<span class="badge badge-unread">${c.unread}</span>` : ""}
          ${chatAiOn(c) ? `<span class="badge badge-ai">AI</span>` : ""}
          ${lifecycleBadge(lc)}
          ${tags}
        </div>
      </div>
      <button class="chat-del" data-jid="${escHtml(c.jid)}" title="Delete conversation">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 6h10M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>
      </button>
    </div>`;
  }).join("");

  container.querySelectorAll(".chat-item").forEach((el) => {
    el.addEventListener("click", () => openChat(el.dataset.jid));
  });
  container.querySelectorAll(".chat-del").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const jid = b.dataset.jid;
    if (!confirm("Delete this conversation from your inbox? This removes it here (it does not delete anything on WhatsApp).")) return;
    const r = await DELETE(`/api/chats/${encodeURIComponent(jid)}`);
    if (r?.ok) {
      allChats = allChats.filter((c) => c.jid !== jid);
      if (activeJid === jid) { activeJid = null; $("messages").innerHTML = ""; $("convName").textContent = "Select a chat"; $("chatDetail").classList.add("hidden"); $("composer").style.display = "none"; }
      renderChatList(); updateUnreadBadge();
      toast("Conversation deleted", "success");
    } else toast(r?.error || "Couldn't delete", "error");
  }));
}

function updateUnreadBadge() {
  const total = allChats.reduce((s, c) => s + (c.unread || 0), 0);
  const badge = $("navUnreadBadge");
  badge.textContent = total;
  badge.classList.toggle("hidden", total === 0);
}

// Filter buttons (All / Unread)
document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    chatFilter = btn.dataset.filter;
    loadChats();
  });
});

// Search by name or number (instant, client-side)
$("chatSearch").addEventListener("input", (e) => {
  searchQuery = e.target.value;
  $("chatSearchClear").classList.toggle("hidden", !searchQuery);
  renderChatList();
});
$("chatSearch").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("chatSearch").value = ""; searchQuery = ""; $("chatSearchClear").classList.add("hidden"); renderChatList(); }
});
$("chatSearchClear").addEventListener("click", () => {
  $("chatSearch").value = ""; searchQuery = "";
  $("chatSearchClear").classList.add("hidden");
  renderChatList();
  $("chatSearch").focus();
});

// Lifecycle + tag dropdown filters (applied client-side, instant)
$("lifecycleFilter").addEventListener("change", (e) => { lifecycleFilter = e.target.value; renderChatList(); });
$("tagFilter").addEventListener("change", (e) => { tagFilter = e.target.value; renderChatList(); });

// Clear all filters
$("filterClear").addEventListener("click", () => {
  lifecycleFilter = ""; tagFilter = ""; chatFilter = "all";
  $("lifecycleFilter").value = ""; $("tagFilter").value = "";
  document.querySelectorAll(".filter-btn").forEach((b) => b.classList.toggle("active", b.dataset.filter === "all"));
  loadChats();
});

/* New chat button */
$("newChatHeaderBtn").addEventListener("click", () => {
  $("newChatModal").classList.remove("hidden");
  $("ncPhone").focus();
});
$("newChatModalClose").addEventListener("click", () => $("newChatModal").classList.add("hidden"));
$("newChatModalCancel").addEventListener("click", () => $("newChatModal").classList.add("hidden"));
$("newChatModalSend").addEventListener("click", async () => {
  const phone = $("ncPhone").value.trim();
  const text = $("ncText").value.trim();
  if (!phone || !text) return toast("Phone and message required", "error");
  const r = await POST("/api/send-to-phone", { phone, text });
  if (r?.ok) {
    $("newChatModal").classList.add("hidden");
    $("ncPhone").value = "";
    $("ncText").value = "";
    toast("Message sent!", "success");
    loadChats();
  } else {
    toast(r?.error || "Failed to send", "error");
  }
});

// Integrations page new chat send
document.addEventListener("DOMContentLoaded", () => {});
document.addEventListener("click", (e) => {
  if (e.target.id === "newChatSend") {
    const phone = $("newChatPhone").value.trim();
    const text = $("newChatText").value.trim();
    if (!phone || !text) return toast("Phone and message are required", "error");
    POST("/api/send-to-phone", { phone, text }).then((r) => {
      if (r?.ok) {
        toast("Message sent!", "success");
        $("newChatPhone").value = "";
        $("newChatText").value = "";
        loadChats();
      } else toast(r?.error || "Failed", "error");
    });
  }
});

/* ============================================================
   OPEN CHAT
   ============================================================ */
async function openChat(jid) {
  activeJid = jid;
  const chat = allChats.find((c) => c.jid === jid) || { jid };
  const init = initials(chat.name, jid);
  const avCls = avatarClass(jid);

  // Header avatar (photo if we have one, else initials)
  const av = $("convAvatar");
  av.className = `conv-header-avatar ${avCls}`;
  if (chat.profile_pic) av.innerHTML = `<img class="avatar-img" src="${escHtml(mediaUrl(chat.profile_pic))}" alt="">`;
  else av.textContent = init;

  // Real phone number: prefer the stored phone (for @lid contacts the JID digits
  // are an internal id, NOT the phone). Fall back to the JID digits for plain numbers.
  const jidDigits = jid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/@g\.us$/, "");
  const phone = chat.phone || (jid.endsWith("@s.whatsapp.net") ? jidDigits : "");
  const displayName = chat.name || (phone ? `+${phone}` : jidDigits);
  $("convName").textContent = displayName;

  // Phone row — always show the real number when we know it
  const phoneEl = $("convPhone");
  if (phone) { phoneEl.textContent = `📞 +${phone}`; phoneEl.style.display = ""; }
  else { phoneEl.textContent = ""; phoneEl.style.display = "none"; }

  // Chat ID / JID (the internal WhatsApp address)
  $("convJidLabel").textContent = `ID: ${jid}`;

  // Update header right
  renderConvHeaderRight(chat);

  // Show detail sidebar, load tags/notes/lifecycle
  $("chatDetail").classList.remove("hidden");
  loadChatDetail(jid, chat);

  // Load messages
  const msgs = await GET(`/api/messages?jid=${encodeURIComponent(jid)}`);
  renderMessages(msgs);

  // Reply vs new-conversation indicator: if the customer has ever messaged us,
  // replying is safe; if not, we'd be starting a (restriction-prone) new chat.
  const tt = $("convThreadType");
  const hasInbound = Array.isArray(msgs) && msgs.some((m) => !m.from_me);
  tt.classList.remove("hidden");
  if (hasInbound) {
    tt.textContent = "↩ Reply";
    tt.className = "thread-type reply";
    tt.title = "This customer messaged you first — your replies deliver normally.";
  } else {
    tt.textContent = "⚠ New conversation";
    tt.className = "thread-type cold";
    tt.title = "You're starting this chat. WhatsApp may restrict messages to people who haven't contacted you first.";
  }

  // Per-chat "Learn behaviour" button: gated to 100+ messages in this thread
  updateLearnButton(Array.isArray(msgs) ? msgs.length : 0);

  // Re-render chat list (clear unread highlight)
  renderChatList();
  updateUnreadBadge();

  // Show composer
  $("composer").style.display = "";
}

function renderConvHeaderRight(chat) {
  const jid = chat.jid;
  const right = $("convHeaderRight");
  const on = chatAiOn(chat);
  right.innerHTML = `
    <div class="ai-switch${on ? " on" : ""}" id="aiSwitch" role="switch" aria-checked="${on}" tabindex="0" title="When on, your AI agent replies to this chat automatically">
      <svg class="ai-switch-icon" width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.5l1.8 5.2 5.2 1.8-5.2 1.8L10 15.5l-1.8-5.2L3 8.5l5.2-1.8z"/></svg>
      <span class="ai-switch-label">AI Agent</span>
      <span class="ai-switch-track"><span class="ai-switch-knob"></span></span>
    </div>
    <button class="hdr-btn" id="detailToggleBtn" title="Chat details">
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 13a3 3 0 100-6 3 3 0 000 6z"/><path d="M16.2 12.3a1.3 1.3 0 00.26 1.43l.05.05a1.6 1.6 0 11-2.26 2.26l-.05-.05a1.3 1.3 0 00-1.43-.26 1.3 1.3 0 00-.79 1.19V17a1.6 1.6 0 11-3.2 0v-.08a1.3 1.3 0 00-.85-1.19 1.3 1.3 0 00-1.43.26l-.05.05a1.6 1.6 0 11-2.26-2.26l.05-.05a1.3 1.3 0 00.26-1.43 1.3 1.3 0 00-1.19-.79H3a1.6 1.6 0 110-3.2h.08a1.3 1.3 0 001.19-.85 1.3 1.3 0 00-.26-1.43l-.05-.05a1.6 1.6 0 112.26-2.26l.05.05a1.3 1.3 0 001.43.26H8.2a1.3 1.3 0 00.79-1.19V3a1.6 1.6 0 113.2 0v.08a1.3 1.3 0 00.79 1.19 1.3 1.3 0 001.43-.26l.05-.05a1.6 1.6 0 112.26 2.26l-.05.05a1.3 1.3 0 00-.26 1.43V8.2a1.3 1.3 0 001.19.79H17a1.6 1.6 0 110 3.2h-.08a1.3 1.3 0 00-1.19.79z"/></svg>
    </button>`;

  const toggleAi = async () => {
    const enabled = !chatAiOn(chat);
    // Mirror the server: enable = opt-in; disable = hard opt-out (overrides global-all)
    chat.ai_enabled = enabled ? 1 : 0;
    chat.ai_off = enabled ? 0 : 1;
    const sw = $("aiSwitch");
    sw.classList.toggle("on", enabled);
    sw.setAttribute("aria-checked", String(enabled));
    await POST("/api/chats/ai", { jid, enabled });
    toast(enabled ? "🤖 AI agent is now handling this chat" : "AI agent paused for this chat", "success");
    renderChatList();
  };

  const sw = $("aiSwitch");
  sw.addEventListener("click", toggleAi);
  sw.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleAi(); } });

  $("detailToggleBtn").addEventListener("click", () => {
    $("chatDetail").classList.toggle("hidden");
  });
}

/* ============================================================
   CHAT DETAIL (lifecycle, tags, notes, agent)
   ============================================================ */
async function loadChatDetail(jid, chat) {
  $("chatSummary").classList.add("hidden");
  $("chatSummaryContent").innerHTML = "";
  // Lifecycle
  const lc = chat.lifecycle || "new_lead";
  $("lifecycleSelect").value = lc;

  // Agent selector — when agents exist, "Auto" uses the default (first active) agent,
  // not the generic global AI Settings.
  const agents = (await GET("/api/agents")) || [];
  const agentSel = $("chatAgentSelect");
  const autoLabel = agents.length ? "⚡ Auto — default agent" : "— Use global AI settings —";
  agentSel.innerHTML = `<option value="">${autoLabel}</option>` +
    agents.map((a) => `<option value="${a.id}" ${a.id == chat.agent_id ? "selected" : ""}>${a.emoji || "🤖"} ${escHtml(a.name)}</option>`).join("");

  // Pipeline deal
  loadChatDeal(jid);

  // Tags
  loadChatTags(jid);

  // Notes
  loadChatNotes(jid);
}

/* Show this chat's pipeline deal (or a button to create one) */
async function loadChatDeal(jid) {
  const deals = await GET(`/api/deals?jid=${encodeURIComponent(jid)}`) || [];
  if (!pipeStages.length) { const d = await GET("/api/pipeline"); pipeStages = d?.stages || []; pipeDeals = d?.deals || []; }
  const wrap = $("chatDeal");
  if (!deals.length) {
    wrap.innerHTML = `<button class="ghost-btn" id="chatDealCreate" style="width:100%;font-size:12.5px">+ Add to pipeline</button>`;
    $("chatDealCreate").addEventListener("click", () => {
      const chat = allChats.find((c) => c.jid === jid);
      openDealModal(null, jid, chat?.name || "");
    });
    return;
  }
  wrap.innerHTML = deals.map((d) => {
    const opts = pipeStages.map((s) => `<option value="${s.id}" ${s.id === d.stage_id ? "selected" : ""}>${escHtml(s.name)}</option>`).join("");
    return `<div class="chat-deal-card" data-id="${d.id}">
      <div class="chat-deal-top"><span class="chat-deal-title">${escHtml(d.title)}</span><span class="chat-deal-value">${fmtMoney(d.value, d.currency)}</span></div>
      <select class="chat-deal-stage" data-id="${d.id}">${opts}</select>
    </div>`;
  }).join("");
  wrap.querySelectorAll(".chat-deal-stage").forEach((sel) => sel.addEventListener("change", async (e) => {
    await POST(`/api/deals/${sel.dataset.id}/move`, { stage_id: parseInt(e.target.value, 10) });
    toast("Deal stage updated", "success");
  }));
  wrap.querySelectorAll(".chat-deal-title").forEach((el) => el.addEventListener("click", () => {
    const id = el.closest(".chat-deal-card").dataset.id;
    openDealModal(deals.find((d) => d.id == id));
  }));
}

$("lifecycleSelect").addEventListener("change", async (e) => {
  if (!activeJid) return;
  await POST("/api/chats/lifecycle", { jid: activeJid, lifecycle: e.target.value });
  const chat = allChats.find((c) => c.jid === activeJid);
  if (chat) chat.lifecycle = e.target.value;
  renderChatList();
  toast("Lifecycle updated");
});

$("chatAgentSelect").addEventListener("change", async (e) => {
  if (!activeJid) return;
  await POST("/api/chats/agent", { jid: activeJid, agent_id: e.target.value || null });
  toast("Agent assigned");
});

async function loadChatTags(jid) {
  const tags = await GET(`/api/chats/${encodeURIComponent(jid)}/tags`);
  renderTags(jid, tags || []);
  // Keep the chat list + filter dropdown in sync with tag changes
  const chat = allChats.find((c) => c.jid === jid);
  if (chat) {
    chat.tags = tags || [];
    populateTagFilter();
    renderChatList();
  }
}

function renderTags(jid, tags) {
  $("tagList").innerHTML = tags.map((t) => `
    <span class="tag-chip">
      ${escHtml(t)}
      <button data-tag="${escHtml(t)}" data-jid="${jid}" class="tag-del-btn">×</button>
    </span>`).join("");
  document.querySelectorAll(".tag-del-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await DELETE(`/api/chats/${encodeURIComponent(btn.dataset.jid)}/tags/${encodeURIComponent(btn.dataset.tag)}`);
      loadChatTags(btn.dataset.jid);
    });
  });
}

$("tagAddBtn").addEventListener("click", addTag);
$("tagInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addTag(); });
async function addTag() {
  if (!activeJid) return;
  const tag = $("tagInput").value.trim().toLowerCase();
  if (!tag) return;
  await POST(`/api/chats/${encodeURIComponent(activeJid)}/tags`, { tag });
  $("tagInput").value = "";
  loadChatTags(activeJid);
}

async function loadChatNotes(jid) {
  const notes = await GET(`/api/chats/${encodeURIComponent(jid)}/notes`);
  $("notesList").innerHTML = (notes || []).map((n) => `
    <div class="note-item">
      <button class="note-del" data-id="${n.id}">×</button>
      ${escHtml(n.body)}
      <div class="note-item-time">${new Date(n.created).toLocaleString()}</div>
    </div>`).join("") || `<div style="font-size:12px;color:var(--ink-4);padding:4px 0">No notes yet.</div>`;
  document.querySelectorAll(".note-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await DELETE(`/api/notes/${btn.dataset.id}`);
      loadChatNotes(activeJid);
    });
  });
}

$("noteAddBtn").addEventListener("click", addNote);
async function addNote() {
  if (!activeJid) return;
  const body = $("noteInput").value.trim();
  if (!body) return;
  await POST(`/api/chats/${encodeURIComponent(activeJid)}/notes`, { body });
  $("noteInput").value = "";
  loadChatNotes(activeJid);
}

/* ============================================================
   MESSAGES
   ============================================================ */
function renderMessages(msgs) {
  const container = $("messages");
  if (!msgs.length) { container.innerHTML = `<div class="empty" style="text-align:center">No messages yet.</div>`; return; }
  let lastDate = "";
  container.innerHTML = msgs.map((m) => {
    const d = new Date(m.ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const sep = d !== lastDate ? `<div class="msg-date-sep">${d}</div>` : "";
    lastDate = d;
    return sep + renderBubble(m);
  }).join("");
  container.scrollTop = container.scrollHeight;
}

function statusTick(status) {
  // 0 ERROR · 1 pending · 2 sent · 3 delivered · 4/5 read
  if (status === 0) return `<span class="tick failed" title="Failed to send">✕</span>`;
  if (status == null || status === 1) return `<span class="tick pending" title="Sending…">🕓</span>`;
  if (status === 2) return `<span class="tick sent" title="Sent to WhatsApp">✓</span>`;
  if (status === 3) return `<span class="tick delivered" title="Delivered">✓✓</span>`;
  return `<span class="tick read" title="Read">✓✓</span>`; // 4 or 5
}

function renderBubble(m) {
  const cls = m.from_me ? "out" : "in";
  const time = new Date(m.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const tick = m.from_me ? statusTick(m.status) : "";
  const idAttr = m.id ? ` data-id="${escHtml(m.id)}"` : "";

  const metaInner = m.from_me
    ? `${m.via === "ai" ? `<span class="via-pill via-ai">AI</span>` : m.via === "rule" ? `<span class="via-pill via-rule">Rule</span>` : ""}<span>${time}</span>${tick}`
    : `<span>${time}</span>`;
  const meta = `<div class="bubble-meta">${metaInner}</div>`;

  // Media bubble — render the actual content
  if (m.mime_type && m.media_url) {
    const mt = m.mime_type;
    const url = mediaUrl(m.media_url);
    const caption = m.body && !/^(📷|🎬|🎤|📎|🌟)/.test(m.body) ? `<div class="media-caption">${escHtml(m.body)}</div>` : "";
    let inner;
    if (mt.startsWith("image/")) {
      inner = `<a href="${url}" target="_blank"><img class="media-img" src="${url}" alt="image"></a>${caption}`;
    } else if (mt.startsWith("video/")) {
      inner = `<video class="media-video" src="${url}" controls preload="metadata"></video>${caption}`;
    } else if (mt.startsWith("audio/")) {
      inner = `<div class="media-voice"><span class="media-voice-icon">🎤</span><audio src="${url}" controls preload="metadata"></audio></div>`;
    } else {
      inner = `<a class="media-doc" href="${url}" target="_blank" download><span class="media-doc-icon">📄</span><span class="media-doc-info"><span class="media-doc-name">${escHtml(m.file_name || "Document")}</span><span class="media-doc-sub">Tap to download</span></span></a>`;
    }
    return `<div class="bubble media ${cls}"${idAttr}>${inner}${meta}</div>`;
  }

  // Media we couldn't download (rare) — show a small placeholder
  if (m.mime_type) {
    return `<div class="bubble media ${cls}"${idAttr}><div class="media-doc"><span class="media-doc-icon">📎</span><span class="media-doc-info"><span class="media-doc-name">${escHtml(m.file_name || m.body || "Attachment")}</span><span class="media-doc-sub">${escHtml(m.mime_type)}</span></span></div>${meta}</div>`;
  }

  return `<div class="bubble ${cls}"${idAttr}>${escHtml(m.body)}${meta}</div>`;
}

// Surface a banner when WhatsApp rejects messages (delivery failures)
const KNOWN_WA_CODES = {
  463: "Rate / trust restriction — WhatsApp is temporarily limiting outbound messages from this number.",
  479: "Recipient restriction — they may not accept messages from new senders.",
  403: "Forbidden — the number may be blocked or restricted by WhatsApp.",
  429: "Too many messages too fast — slow down sending.",
};
let deliveryFailCount = 0;
function showDeliveryBanner(data) {
  deliveryFailCount++;
  const code = data?.code;
  const hint = code && KNOWN_WA_CODES[code] ? ` ${KNOWN_WA_CODES[code]}` : "";
  const codeStr = code ? ` (WhatsApp error ${code})` : " (no code returned by WhatsApp)";
  $("deliveryBannerText").innerHTML =
    `WhatsApp is rejecting messages${codeStr} — ${deliveryFailCount} not delivered. ` +
    `They leave the app but never reach the recipient.${hint} ` +
    `<a href="#" id="dbPauseAi">Pause AI replies</a> and try sending from your phone for a while.`;
  $("deliveryBanner").classList.remove("hidden");
  const pause = document.getElementById("dbPauseAi");
  if (pause) pause.onclick = (e) => {
    e.preventDefault();
    if (activeJid) { POST("/api/chats/ai", { jid: activeJid, enabled: false }); toast("AI paused for this chat", "success"); }
  };
}
$("deliveryBannerClose").addEventListener("click", () => { $("deliveryBanner").classList.add("hidden"); deliveryFailCount = 0; });

// Live-update a sent message's delivery tick (✓ → ✓✓ → read / ✕ failed)
function updateMessageTick(data) {
  if (data.jid !== activeJid || !data.id) return;
  const bubble = $("messages").querySelector(`.bubble[data-id="${CSS.escape(data.id)}"]`);
  if (!bubble) return;
  const old = bubble.querySelector(".tick");
  if (old) old.outerHTML = statusTick(data.status);
}

function handleIncomingMessage(data) {
  const { jid, from_me, body, ts, name, via, mime_type, file_name, media_url, id, status } = data;

  // Audible ping for genuinely new inbound messages (not your own, not history).
  if (!from_me) notifyPing();

  // Update chat in list
  const existing = allChats.find((c) => c.jid === jid);
  if (existing) {
    existing.last_msg = body;
    existing.last_ts = ts;
    if (!from_me && jid !== activeJid) existing.unread = (existing.unread || 0) + 1;
  } else {
    allChats.unshift({ jid, name: name || null, last_msg: body, last_ts: ts, unread: from_me ? 0 : 1, ai_enabled: 0, ai_off: 0, lifecycle: "new_lead", tags: [] });
  }
  renderChatList();
  updateUnreadBadge();

  // Append to active conversation
  if (jid === activeJid) {
    const msg = { from_me: !!from_me, body, ts, via, mime_type, file_name, media_url, id, status };
    const container = $("messages");
    const el = document.createElement("div");
    el.innerHTML = renderBubble(msg);
    container.appendChild(el.firstElementChild);
    container.scrollTop = container.scrollHeight;
    // A customer message turns this into a safe "reply" thread
    if (!from_me) {
      const tt = $("convThreadType");
      tt.textContent = "↩ Reply"; tt.className = "thread-type reply";
      tt.title = "This customer messaged you first — your replies deliver normally.";
    }
  }
}

/* ============================================================
   COMPOSER — SEND TEXT
   ============================================================ */
// Auto-resize textarea
const composerInput = $("composerInput");
composerInput.addEventListener("input", () => {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(composerInput.scrollHeight, 120) + "px";
  // Show template picker on "/"
  if (composerInput.value === "/") showTemplatePicker();
  else if (!composerInput.value.startsWith("/")) hideTemplatePicker();
});

$("sendBtn").addEventListener("click", sendMessage);
composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  if (e.key === "Escape") hideTemplatePicker();
});

async function sendMessage() {
  if (!activeJid) return;
  const text = composerInput.value.trim();
  if (!text) return;
  composerInput.value = "";
  composerInput.style.height = "";
  hideTemplatePicker();
  const r = await POST("/api/send", { jid: activeJid, text });
  if (r?.error) toast(r.error, "error");
}

/* ============================================================
   COMPOSER — FILE ATTACHMENT
   ============================================================ */
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !activeJid) return;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("jid", activeJid);
  const caption = composerInput.value.trim();
  if (caption) fd.append("caption", caption);
  const r = await api("POST", "/api/send-media", fd, true);
  if (r?.ok) {
    composerInput.value = "";
    toast("Attachment sent!", "success");
  } else {
    toast(r?.error || "Failed to send attachment", "error");
  }
  e.target.value = "";
});

/* ============================================================
   COMPOSER — VOICE NOTE (record & send)
   ============================================================ */
let mediaRecorder = null, voiceChunks = [], voiceTimer = null;
$("recordBtn").addEventListener("click", async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") { stopRecording(); return; }
  if (!activeJid) return toast("Open a chat first", "error");
  if (!navigator.mediaDevices?.getUserMedia) return toast("Recording isn't supported in this browser", "error");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    voiceChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) voiceChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(voiceChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      const fd = new FormData();
      fd.append("file", blob, "voice.ogg");
      fd.append("jid", activeJid);
      fd.append("voice", "1");
      const r = await api("POST", "/api/send-media", fd, true);
      toast(r?.ok ? "🎤 Voice message sent" : (r?.error || "Failed to send"), r?.ok ? "success" : "error");
    };
    mediaRecorder.start();
    // recording UI
    const btn = $("recordBtn");
    btn.classList.add("recording");
    let secs = 0;
    voiceTimer = setInterval(() => { secs++; btn.title = `Recording ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} — tap to send`; }, 1000);
    toast("Recording… tap the mic again to send", "");
  } catch (err) {
    toast("Microphone access denied", "error");
  }
});
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  clearInterval(voiceTimer);
  $("recordBtn").classList.remove("recording");
  $("recordBtn").title = "Record a voice message";
}

/* ============================================================
   COMPOSER — AI ASSIST
   ============================================================ */
$("aiAssistBtn").addEventListener("click", async () => {
  const draft = composerInput.value.trim();
  if (!draft) return toast("Type a message first, then tap AI Assist to polish it.");
  const btn = $("aiAssistBtn");
  if (btn.classList.contains("loading")) return;
  btn.classList.add("loading");
  const r = await POST("/api/ai/improve", { draft, jid: activeJid });
  btn.classList.remove("loading");
  if (r?.improved) {
    composerInput.value = r.improved;
    composerInput.style.height = "auto";
    composerInput.style.height = Math.min(composerInput.scrollHeight, 120) + "px";
    composerInput.focus();
    toast("✨ Message polished by AI", "success");
  } else {
    toast(r?.error || "AI not available", "error");
  }
});

/* ============================================================
   TEMPLATE PICKER
   ============================================================ */
let templates = [];

$("templateBtn").addEventListener("click", () => {
  const picker = $("templatePicker");
  if (picker.classList.contains("hidden")) showTemplatePicker();
  else hideTemplatePicker();
});

function showTemplatePicker() {
  const picker = $("templatePicker");
  if (!templates.length) {
    picker.innerHTML = `<div class="no-templates-hint">No templates yet — create them in <strong>Templates</strong>.</div>`;
  } else {
    const q = composerInput.value.replace(/^\//, "").toLowerCase();
    const filtered = q ? templates.filter((t) => t.name.toLowerCase().includes(q) || (t.shortcut || "").toLowerCase().includes(q)) : templates;
    picker.innerHTML = `<div class="template-picker-header">Templates — click to insert</div>` +
      (filtered.length ? filtered.map((t) => `
        <div class="template-item" data-id="${t.id}">
          <div class="template-item-name">${escHtml(t.name)}${t.shortcut ? `<span class="template-shortcut">${escHtml(t.shortcut)}</span>` : ""}</div>
          <div class="template-item-body">${escHtml(t.body)}</div>
        </div>`).join("") : `<div class="no-templates-hint">No matching templates.</div>`);
    picker.querySelectorAll(".template-item").forEach((el) => {
      el.addEventListener("click", () => {
        const tpl = templates.find((t) => t.id == el.dataset.id);
        if (tpl) {
          composerInput.value = tpl.body;
          composerInput.style.height = "auto";
          composerInput.style.height = Math.min(composerInput.scrollHeight, 120) + "px";
          composerInput.focus();
        }
        hideTemplatePicker();
      });
    });
  }
  picker.classList.remove("hidden");
  $("templateBtn").classList.add("active");
}

function hideTemplatePicker() {
  $("templatePicker").classList.add("hidden");
  $("templateBtn").classList.remove("active");
}

async function loadTemplateCache() {
  templates = await GET("/api/templates") || [];
}

/* ============================================================
   TEMPLATES VIEW
   ============================================================ */
async function loadTemplates() {
  templates = await GET("/api/templates") || [];
  const list = $("templateList");
  list.innerHTML = templates.length
    ? templates.map((t) => `
        <div class="rule-item">
          <div class="rule-body">
            <div class="rule-kw">${escHtml(t.name)} ${t.shortcut ? `<small style="color:var(--brand-500)">${escHtml(t.shortcut)}</small>` : ""}</div>
            <div class="rule-reply">${escHtml(t.body)}</div>
          </div>
          <div class="rule-actions">
            <button class="del" data-id="${t.id}">Delete</button>
          </div>
        </div>`).join("")
    : `<div class="empty">No templates yet.</div>`;
  list.querySelectorAll(".del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await DELETE(`/api/templates/${btn.dataset.id}`);
      loadTemplates();
    });
  });
}

$("tplAdd").addEventListener("click", async () => {
  const name = $("tplName").value.trim();
  const body = $("tplBody").value.trim();
  const shortcut = $("tplShortcut").value.trim();
  if (!name || !body) return toast("Name and body required", "error");
  const r = await POST("/api/templates", { name, shortcut, body });
  if (r?.ok) {
    $("tplName").value = "";
    $("tplShortcut").value = "";
    $("tplBody").value = "";
    loadTemplates();
    toast("Template saved", "success");
  }
});

/* ============================================================
   AI AGENTS
   ============================================================ */
async function loadAgents() {
  const agents = await GET("/api/agents") || [];
  const knowledge = await GET("/api/knowledge") || [];

  // Agents list
  const list = $("agentList");
  list.innerHTML = agents.length
    ? agents.map((a) => `
      <div class="agent-card${a.active ? " active-agent" : ""}" data-id="${a.id}">
        <div class="agent-emoji">${a.emoji || "🤖"}</div>
        <div class="agent-info">
          <div class="agent-name">${escHtml(a.name)}</div>
          <div class="agent-desc">${escHtml(a.instructions?.slice(0, 80) || "No instructions yet")}…</div>
        </div>
        <div class="agent-actions">
          <button class="ghost-btn edit-agent-btn" data-id="${a.id}" style="font-size:12px;padding:6px 12px">Edit</button>
          <button class="danger-btn del-agent-btn" data-id="${a.id}" style="font-size:12px;padding:6px 12px">Delete</button>
        </div>
      </div>`).join("")
    : `<div class="empty">No agents yet. Create your first agent above.</div>`;

  list.querySelectorAll(".edit-agent-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); openAgentModal(agents.find((a) => a.id == btn.dataset.id)); });
  });
  list.querySelectorAll(".del-agent-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this agent?")) return;
      await DELETE(`/api/agents/${btn.dataset.id}`);
      loadAgents();
      toast("Agent deleted");
    });
  });

  // Knowledge list
  const kl = $("knowledgeList");
  kl.innerHTML = knowledge.map((k) => `
    <div class="ks-item">
      <span class="ks-icon">📄</span>
      <span class="ks-name">${escHtml(k.file_name)}</span>
      <span style="font-size:11px;color:var(--ink-4);flex-shrink:0;margin-right:8px">${k.agent_id ? "Agent #" + k.agent_id : "Global"}</span>
      <button class="ks-del" data-id="${k.id}">×</button>
    </div>`).join("") || "";

  kl.querySelectorAll(".ks-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await DELETE(`/api/knowledge/${btn.dataset.id}`);
      loadAgents();
    });
  });
}

$("newAgentBtn").addEventListener("click", () => openAgentModal(null));

function openAgentModal(agent) {
  $("agentModalTitle").textContent = agent ? "Edit AI Agent" : "Create AI Agent";
  $("agentModalId").value = agent?.id || "";
  $("agentEmoji").value = agent?.emoji || "🤖";
  $("agentName").value = agent?.name || "";
  $("agentInstructions").value = agent?.instructions || "";
  $("agentPlaybook").value = agent?.playbook || "";
  $("agentRules").value = agent?.rules || "";
  $("agentStyle").value = agent?.writing_style || "";
  $("agentStyleFiles").value = "";
  $("agentApiKey").value = ""; // never pre-fill API keys
  $("agentModel").value = agent?.model || "gpt-4o-mini";
  resetAgentTester();
  $("agentTester").classList.add("hidden");
  $("agentModal").classList.remove("hidden");
}

$("agentModalClose").addEventListener("click", () => $("agentModal").classList.add("hidden"));
$("agentModalCancel").addEventListener("click", () => $("agentModal").classList.add("hidden"));

/* ============================================================
   AGENT PHONE TESTER (live test, even unsaved)
   ============================================================ */
let testMsgs = [];
function resetAgentTester() {
  testMsgs = [];
  if ($("testMessages")) $("testMessages").innerHTML = `<div class="phone-bubble them">👋 Send a message to test your agent.</div>`;
}
function renderAgentTester(typing) {
  const box = $("testMessages");
  box.innerHTML = testMsgs.map((m) =>
    `<div class="phone-bubble ${m.role === "assistant" ? "them" : "me"}">${escHtml(m.content)}</div>`
  ).join("") || `<div class="phone-bubble them">👋 Send a message to test your agent.</div>`;
  if (typing) box.innerHTML += `<div class="phone-bubble them typing">typing…</div>`;
  box.scrollTop = box.scrollHeight;
}
$("agentTestToggle").addEventListener("click", () => {
  const t = $("agentTester");
  t.classList.toggle("hidden");
  if (!t.classList.contains("hidden")) {
    $("testAvatar").textContent = $("agentEmoji").value.trim() || "🤖";
    $("testName").textContent = $("agentName").value.trim() || "Your Agent";
    if (!testMsgs.length) resetAgentTester();
  }
});
$("testReset").addEventListener("click", resetAgentTester);
async function sendAgentTest() {
  const input = $("testInput");
  const text = input.value.trim();
  if (!text) return;
  $("testAvatar").textContent = $("agentEmoji").value.trim() || "🤖";
  $("testName").textContent = $("agentName").value.trim() || "Your Agent";
  testMsgs.push({ role: "user", content: text });
  input.value = "";
  renderAgentTester(true);
  $("testSend").disabled = true;
  const r = await POST("/api/agents/test", {
    instructions: $("agentInstructions").value,
    playbook: $("agentPlaybook").value,
    rules: $("agentRules").value,
    writing_style: $("agentStyle").value,
    model: $("agentModel").value,
    openai_api_key: $("agentApiKey").value.trim(),
    messages: testMsgs,
  });
  $("testSend").disabled = false;
  if (r?.reply) {
    testMsgs.push({ role: "assistant", content: r.reply });
  } else {
    testMsgs.push({ role: "assistant", content: "⚠ " + (r?.error || "AI couldn't reply — check your API key.") });
  }
  renderAgentTester(false);
}
$("testSend").addEventListener("click", sendAgentTest);
$("testInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendAgentTest(); } });

// AI-assist buttons on the agent's instructions / playbook / rules fields:
// expand the user's few words (or write from scratch) into a polished section.
document.querySelectorAll(".ai-write-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const field = btn.dataset.field;
    const ta = $(btn.dataset.target);
    if (!ta) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "✨ Writing…";
    try {
      const r = await POST("/api/ai/draft-agent-field", {
        field,
        draft: ta.value,
        agentName: $("agentName").value.trim(),
      });
      if (r?.text) {
        ta.value = r.text.trim();
        toast("AI drafted this section — edit as you like", "success");
      } else {
        toast(r?.error || "AI couldn't write this", "error");
      }
    } catch {
      toast("AI request failed", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
});

// Learn THIS agent's writing style from uploaded chat files → fills the field
$("agentStyleImportBtn").addEventListener("click", async () => {
  const files = $("agentStyleFiles").files;
  if (!files.length) return toast("Pick at least one .txt export", "error");
  const btn = $("agentStyleImportBtn");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "⚡ Learning…";
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  let r;
  try { r = await POSTFORM("/api/ai/learn-style-from-files", fd); }
  catch { r = { error: "Upload failed, try again" }; }
  btn.disabled = false; btn.textContent = original;
  if (r?.style) {
    $("agentStyle").value = r.style.trim();
    toast(`Style learned from ${r.imported || 0} messages — edit as you like`, "success");
  } else {
    toast(r?.error || "Couldn't learn from these files", "error");
  }
});

$("agentModalSave").addEventListener("click", async () => {
  const id = $("agentModalId").value;
  const body = {
    name: $("agentName").value.trim(),
    emoji: $("agentEmoji").value.trim() || "🤖",
    instructions: $("agentInstructions").value.trim(),
    playbook: $("agentPlaybook").value.trim(),
    rules: $("agentRules").value.trim(),
    writing_style: $("agentStyle").value.trim(),
    model: $("agentModel").value,
    openai_api_key: $("agentApiKey").value.trim(),
  };
  if (!body.name) return toast("Agent name is required", "error");
  const r = id ? await PUT(`/api/agents/${id}`, body) : await POST("/api/agents", body);
  if (r?.ok) {
    $("agentModal").classList.add("hidden");
    loadAgents();
    toast(id ? "Agent updated" : "Agent created", "success");
  } else {
    toast(r?.error || "Failed to save", "error");
  }
});

// Knowledge source upload
$("ksFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const r = await api("POST", "/api/knowledge", fd, true);
  if (r?.ok) { toast(`"${r.file_name}" uploaded`, "success"); loadAgents(); }
  else toast(r?.error || "Upload failed", "error");
  e.target.value = "";
});

/* ============================================================
   RULES
   ============================================================ */
async function loadRules() {
  const rules = await GET("/api/rules") || [];
  const list = $("ruleList");
  list.innerHTML = rules.length
    ? rules.map((r) => `
      <div class="rule-item${r.active ? "" : " inactive"}">
        <div class="rule-body">
          <div class="rule-kw">${escHtml(r.keyword)} <small>(${r.match_type})</small></div>
          <div class="rule-reply">${escHtml(r.reply)}</div>
        </div>
        <div class="rule-actions">
          <button class="toggle-rule" data-id="${r.id}" data-active="${r.active}">${r.active ? "Disable" : "Enable"}</button>
          <button class="del del-rule" data-id="${r.id}">Delete</button>
        </div>
      </div>`).join("")
    : `<div class="empty">No rules yet.</div>`;

  list.querySelectorAll(".toggle-rule").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await POST(`/api/rules/${btn.dataset.id}/toggle`, { active: btn.dataset.active !== "1" });
      loadRules();
    });
  });
  list.querySelectorAll(".del-rule").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await DELETE(`/api/rules/${btn.dataset.id}`);
      loadRules();
    });
  });
}

$("ruleAdd").addEventListener("click", async () => {
  const keyword = $("ruleKeyword").value.trim();
  const reply = $("ruleReply").value.trim();
  const match_type = $("ruleMatch").value;
  if (!keyword || !reply) return toast("Keyword and reply required", "error");
  const r = await POST("/api/rules", { keyword, reply, match_type });
  if (r?.ok) {
    $("ruleKeyword").value = "";
    $("ruleReply").value = "";
    loadRules();
  }
});

/* ============================================================
   SETTINGS
   ============================================================ */
async function loadSettings() {
  const s = await GET("/api/settings");
  aiAllChats = s?.ai_all_chats === "1";
  updateAllChatsBar();
  $("aiHandoff").value = s?.ai_handoff_keywords || "";
}

$("settingsSave").addEventListener("click", async () => {
  const r = await POST("/api/settings", {
    ai_handoff_keywords: $("aiHandoff").value,
  });
  if (r?.ok) {
    $("savedNote").classList.remove("hidden");
    setTimeout(() => $("savedNote").classList.add("hidden"), 2000);
  }
});

/* ============================================================
   INTEGRATIONS
   ============================================================ */
async function loadIntegrations() {
  const d = await GET("/api/integrations");
  $("webhookUrl").value = d?.webhook_url || "";
  $("apiKeyField").value = d?.api_key || "";
  // E-commerce recovery
  const ecom = await GET("/api/ecommerce/info");
  if (ecom) {
    $("ecomWebhook").value = ecom.webhook_url;
    $("ecomSample").textContent = `POST ${ecom.webhook_url}\nX-API-Key: ${ecom.api_key || "wak_…"}\n${JSON.stringify(ecom.sample, null, 2)}`;
  }
  // Stripe status
  const ps = await GET("/api/payments/settings");
  $("stripeStatus").textContent = ps?.stripe_set ? "✅ Stripe connected — payment links are live." : "Not connected — payment links run in demo mode.";
}
$("ecomCopy")?.addEventListener("click", () => { navigator.clipboard?.writeText($("ecomWebhook").value); toast("Webhook URL copied", "success"); });
$("stripeSave")?.addEventListener("click", async () => {
  const key = $("stripeKey").value.trim();
  if (!key) return toast("Paste your Stripe secret key", "error");
  const r = await POST("/api/payments/settings", { stripe_key: key });
  if (r?.ok) { $("stripeKey").value = ""; toast("Stripe key saved", "success"); loadIntegrations(); }
  else toast(r?.error || "Failed", "error");
});

$("webhookSave").addEventListener("click", async () => {
  const r = await POST("/api/integrations/webhook", { url: $("webhookUrl").value.trim() });
  if (r?.ok) toast("Webhook saved", "success");
  else toast(r?.error || "Error", "error");
});

$("apiKeyGen").addEventListener("click", async () => {
  if (!confirm("Generate a new API key? The old one stops working immediately.")) return;
  const r = await POST("/api/integrations/apikey");
  if (r?.api_key) {
    $("apiKeyField").value = r.api_key;
    toast("New API key generated", "success");
  }
});

/* ============================================================
   BILLING
   ============================================================ */
async function loadBilling() {
  const d = await GET("/api/me");
  const t = d?.tenant;
  const quota = d?.quota;
  if (!t) return;
  let status = `You're on the <strong>${t.plan_label}</strong> plan.`;
  if (t.plan === "trial" && t.trial_ends) {
    const days = Math.max(0, Math.ceil((t.trial_ends - Date.now()) / 86400000));
    status += ` Trial ends in <strong>${days} day${days !== 1 ? "s" : ""}</strong>.`;
  }
  if (quota) status += ` <strong>${quota.used}/${quota.limit === Infinity ? "∞" : quota.limit}</strong> automated conversations used this month.`;
  $("billingStatus").innerHTML = status;
  document.querySelectorAll(".plan-card").forEach((card) => {
    card.classList.toggle("current", card.dataset.plan === t.plan);
    card.querySelector("button").textContent = card.dataset.plan === t.plan ? "Current plan" : `Choose ${card.querySelector("h3").textContent}`;
  });
  $("portalBtn").classList.toggle("hidden", !d?.billingEnabled || t.plan === "trial");
}

document.querySelectorAll(".plan-card button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const plan = btn.closest(".plan-card").dataset.plan;
    const r = await POST("/api/billing/checkout", { plan });
    if (r?.url) location.href = r.url;
    else toast(r?.error || "Billing not configured", "error");
  });
});

$("portalBtn").addEventListener("click", async () => {
  const r = await POST("/api/billing/portal");
  if (r?.url) location.href = r.url;
});

/* ============================================================
   FLOW BUILDER — Make.com-style module canvas
   ============================================================ */
const MODULE_META = {
  trigger: { label: "Trigger", icon: "⚡", color: "var(--brand-600)", desc: "When a customer message contains a keyword" },
  message: { label: "Send Message", icon: "💬", color: "oklch(0.55 0.14 250)", desc: "Send a text message to the customer" },
  question: { label: "Ask a Question", icon: "❓", color: "oklch(0.62 0.16 300)", desc: "Ask, then branch on the customer's reply" },
  ai: { label: "AI Takeover", icon: "✨", color: "var(--gold)", desc: "Hand the chat to your AI agent" },
  handoff: { label: "Human Handoff", icon: "🙋", color: "oklch(0.62 0.15 35)", desc: "Flag the chat for a human to reply" },
  end: { label: "End Flow", icon: "🏁", color: "oklch(0.55 0.02 240)", desc: "Stop the flow here" },
};
const ADDABLE_MODULES = ["message", "question", "ai", "handoff", "end"];

let flows = [];
let editingFlowId = null;
let flowNodes = {};      // id -> node ({start,nodes} backend format)
let flowStart = null;    // first action node id
let flowTrigger = "";    // trigger keyword
let openModuleId = null; // currently expanded module editor
let pendingInsert = null; // insertion descriptor while palette is open

function newNodeId() { return "n" + Math.random().toString(36).slice(2, 9); }
function makeNode(type) {
  if (type === "message") return { id: newNodeId(), type, text: "", next: null };
  if (type === "question") return { id: newNodeId(), type, text: "", branches: [{ match: "", next: null }, { match: "", next: null }], fallback: null };
  if (type === "handoff") return { id: newNodeId(), type, text: "" };
  return { id: newNodeId(), type }; // ai, end
}

async function loadFlows() {
  flows = await GET("/api/flows") || [];
  const sel = $("flowSelect");
  if (!flows.length) {
    sel.classList.add("hidden");
    $("flowEditor").classList.add("hidden");
    $("flowEmpty").classList.remove("hidden");
    return;
  }
  $("flowEmpty").classList.add("hidden");
  sel.classList.remove("hidden");
  sel.innerHTML = flows.map((f) => `<option value="${f.id}">${escHtml(f.name)}</option>`).join("");
  openFlow(editingFlowId && flows.some((f) => f.id === editingFlowId) ? editingFlowId : flows[0].id);
}

function startNewFlow() {
  editingFlowId = null;
  flowTrigger = "";
  flowNodes = {};
  flowStart = null;
  openModuleId = null;
  $("flowName").value = "";
  $("flowSelect").classList.add("hidden");
  $("flowEmpty").classList.add("hidden");
  $("flowEditor").classList.remove("hidden");
  $("flowToggle").classList.add("hidden");
  $("flowDelete").classList.add("hidden");
  renderFlow();
}
$("flowNew").addEventListener("click", startNewFlow);
$("flowNewEmpty").addEventListener("click", startNewFlow);
$("flowSelect").addEventListener("change", () => openFlow(parseInt($("flowSelect").value)));

function openFlow(id) {
  const f = flows.find((x) => x.id === id);
  if (!f) return;
  editingFlowId = id;
  flowTrigger = f.trigger_keyword || "";
  $("flowName").value = f.name || "";
  // Load definition in {start, nodes} format; fall back to empty if legacy/invalid
  const def = f.definition;
  if (def && def.nodes && typeof def.nodes === "object") {
    flowNodes = JSON.parse(JSON.stringify(def.nodes));
    flowStart = def.start || null;
  } else {
    flowNodes = {}; flowStart = null;
  }
  openModuleId = null;
  $("flowEditor").classList.remove("hidden");
  $("flowSelect").classList.remove("hidden");
  $("flowToggle").classList.remove("hidden");
  $("flowDelete").classList.remove("hidden");
  $("flowToggle").textContent = f.active ? "Deactivate" : "Activate";
  $("flowToggle").classList.toggle("flow-active", !!f.active);
  renderFlow();
}

/* ---------- Render the module canvas ---------- */
function renderFlow() {
  const canvas = $("flowCanvas");
  // Trigger module (always first, fixed)
  let html = `
    <div class="flow-mod flow-trigger">
      <div class="flow-mod-head">
        <span class="flow-mod-icon" style="background:${MODULE_META.trigger.color}">${MODULE_META.trigger.icon}</span>
        <div class="flow-mod-info">
          <div class="flow-mod-type">Trigger — when message contains</div>
          <input class="flow-trigger-input" id="flowTriggerInput" placeholder="e.g. hello, menu, price" value="${escHtml(flowTrigger)}" />
        </div>
      </div>
    </div>`;
  html += connector(flowStart, { kind: "start" });
  canvas.innerHTML = html;
  bindCanvas();
}

function connector(childId, insertPoint) {
  if (childId && flowNodes[childId]) {
    return `<div class="flow-line"></div>` + nodeHtml(childId);
  }
  return `<div class="flow-line short"></div>` + addButton(insertPoint);
}

function addButton(insertPoint) {
  return `<button class="flow-add" data-insert='${JSON.stringify(insertPoint)}' title="Add a module">
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4v12M4 10h12"/></svg>
  </button>`;
}

function nodeHtml(id) {
  const n = flowNodes[id];
  if (!n) return "";
  const meta = MODULE_META[n.type] || MODULE_META.message;
  const editing = id === openModuleId;
  let html = `<div class="flow-mod${editing ? " editing" : ""}" data-id="${id}">
    <div class="flow-mod-head" data-act="toggle" data-id="${id}">
      <span class="flow-mod-icon" style="background:${meta.color}">${meta.icon}</span>
      <div class="flow-mod-info">
        <div class="flow-mod-type">${meta.label}</div>
        <div class="flow-mod-preview${nodePreview(n) ? "" : " placeholder"}">${nodePreview(n) || meta.desc}</div>
      </div>
      <button class="flow-mod-del" data-act="del" data-id="${id}" title="Delete module">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 6h10M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>
      </button>
    </div>
    ${editing ? moduleEditor(n) : ""}
  </div>`;

  // Downstream
  if (n.type === "message") {
    html += connector(n.next, { kind: "next", nodeId: id });
  } else if (n.type === "question") {
    html += `<div class="flow-branches">`;
    (n.branches || []).forEach((b, i) => {
      const label = b.match ? escHtml(b.match) : "(set reply)";
      html += `<div class="flow-branch">
        <div class="flow-branch-label">${label}</div>
        ${connector(b.next, { kind: "branch", nodeId: id, branchIndex: i })}
      </div>`;
    });
    html += `</div>`;
  }
  // ai / handoff / end are terminal — nothing after
  return html;
}

function nodePreview(n) {
  if (n.type === "message" || n.type === "handoff") return n.text ? escHtml(n.text) : "";
  if (n.type === "question") return n.text ? escHtml(n.text) : "";
  if (n.type === "ai") return "AI agent answers from here on";
  if (n.type === "end") return "Conversation flow stops";
  return "";
}

/* ---------- Inline module editor ---------- */
function moduleEditor(n) {
  if (n.type === "message") {
    return `<div class="flow-mod-edit">
      <label class="flow-edit-label">Message to send</label>
      <textarea class="flow-edit-text" rows="3" placeholder="Hi! Thanks for reaching out 👋">${escHtml(n.text || "")}</textarea>
      ${editorButtons(n.id)}
    </div>`;
  }
  if (n.type === "handoff") {
    return `<div class="flow-mod-edit">
      <label class="flow-edit-label">Optional message before handing off</label>
      <textarea class="flow-edit-text" rows="2" placeholder="One moment, connecting you to our team…">${escHtml(n.text || "")}</textarea>
      ${editorButtons(n.id)}
    </div>`;
  }
  if (n.type === "question") {
    const branches = (n.branches || []).map((b, i) => `
      <div class="flow-branch-edit" data-i="${i}">
        <input class="flow-branch-match" placeholder="If reply contains… (e.g. 1, price)" value="${escHtml(b.match || "")}" />
        <button class="flow-branch-rm" data-i="${i}" title="Remove option">×</button>
      </div>`).join("");
    return `<div class="flow-mod-edit">
      <label class="flow-edit-label">Question to ask</label>
      <textarea class="flow-edit-text" rows="2" placeholder="Reply 1 for prices, 2 for delivery">${escHtml(n.text || "")}</textarea>
      <label class="flow-edit-label">Answer options — each becomes a branch</label>
      <div class="flow-branch-edits">${branches}</div>
      <button class="ghost-btn flow-branch-add" style="font-size:12px;padding:5px 12px">+ Add option</button>
      ${editorButtons(n.id)}
    </div>`;
  }
  // ai / end — no fields
  return `<div class="flow-mod-edit">
    <p class="flow-edit-note">${MODULE_META[n.type].desc}. No setup needed.</p>
    ${editorButtons(n.id)}
  </div>`;
}
function editorButtons(id) {
  return `<div class="flow-edit-actions">
    <button class="primary-btn flow-edit-done" data-id="${id}" style="padding:6px 16px;font-size:12.5px">Done</button>
  </div>`;
}

/* ---------- Canvas event binding ---------- */
function bindCanvas() {
  const canvas = $("flowCanvas");

  // trigger keyword (no re-render while typing)
  const trig = $("flowTriggerInput");
  if (trig) trig.addEventListener("input", (e) => { flowTrigger = e.target.value; });

  // + add buttons
  canvas.querySelectorAll(".flow-add").forEach((b) => {
    b.addEventListener("click", () => openPalette(JSON.parse(b.dataset.insert)));
  });

  // module head: toggle editor / delete
  canvas.querySelectorAll('.flow-mod-head[data-act="toggle"]').forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="del"]')) return;
      const id = el.dataset.id;
      if (openModuleId && openModuleId !== id) applyEditor(openModuleId);
      openModuleId = openModuleId === id ? null : id;
      renderFlow();
    });
  });
  canvas.querySelectorAll('[data-act="del"]').forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); deleteModule(el.dataset.id); });
  });

  // editor controls
  canvas.querySelectorAll(".flow-edit-done").forEach((el) => {
    el.addEventListener("click", () => { applyEditor(el.dataset.id); openModuleId = null; renderFlow(); });
  });
  canvas.querySelectorAll(".flow-branch-add").forEach((el) => {
    el.addEventListener("click", () => {
      applyEditor(openModuleId);
      flowNodes[openModuleId].branches.push({ match: "", next: null });
      renderFlow();
    });
  });
  canvas.querySelectorAll(".flow-branch-rm").forEach((el) => {
    el.addEventListener("click", () => {
      applyEditor(openModuleId);
      const n = flowNodes[openModuleId];
      if (n.branches.length <= 1) return toast("A question needs at least one option", "error");
      n.branches.splice(parseInt(el.dataset.i, 10), 1);
      renderFlow();
    });
  });
}

// Read editor inputs into the model (called before re-render / structural change)
function applyEditor(id) {
  const n = flowNodes[id];
  if (!n || id !== openModuleId) return;
  const card = $("flowCanvas").querySelector(`.flow-mod[data-id="${id}"]`);
  if (!card) return;
  const textEl = card.querySelector(".flow-edit-text");
  if (textEl && (n.type === "message" || n.type === "handoff" || n.type === "question")) n.text = textEl.value;
  if (n.type === "question") {
    const matches = [...card.querySelectorAll(".flow-branch-match")];
    n.branches = n.branches.map((b, i) => ({ match: matches[i] ? matches[i].value.trim() : b.match, next: b.next }));
  }
}

/* ---------- Module palette ---------- */
function openPalette(insertPoint) {
  if (openModuleId) { applyEditor(openModuleId); openModuleId = null; }
  pendingInsert = insertPoint;
  $("paletteGrid").innerHTML = ADDABLE_MODULES.map((t) => {
    const m = MODULE_META[t];
    return `<button class="palette-item" data-type="${t}">
      <span class="palette-icon" style="background:${m.color}">${m.icon}</span>
      <span class="palette-text"><span class="palette-name">${m.label}</span><span class="palette-desc">${m.desc}</span></span>
    </button>`;
  }).join("");
  $("paletteGrid").querySelectorAll(".palette-item").forEach((b) => {
    b.addEventListener("click", () => { addModule(b.dataset.type); });
  });
  $("modulePalette").classList.remove("hidden");
}
$("paletteClose").addEventListener("click", () => $("modulePalette").classList.add("hidden"));
$("modulePalette").addEventListener("click", (e) => { if (e.target.id === "modulePalette") $("modulePalette").classList.add("hidden"); });

function addModule(type) {
  const node = makeNode(type);
  flowNodes[node.id] = node;
  const ip = pendingInsert;
  if (ip.kind === "start") flowStart = node.id;
  else if (ip.kind === "next") flowNodes[ip.nodeId].next = node.id;
  else if (ip.kind === "branch") flowNodes[ip.nodeId].branches[ip.branchIndex].next = node.id;
  $("modulePalette").classList.add("hidden");
  openModuleId = (type === "ai" || type === "end") ? null : node.id; // auto-open editor for configurable modules
  renderFlow();
}

function deleteModule(id) {
  // Re-link the parent's pointer to this node's `next` (so the chain survives)
  const node = flowNodes[id];
  const successor = node && node.type === "message" ? node.next : null;
  // find & repoint references
  if (flowStart === id) flowStart = successor;
  for (const k of Object.keys(flowNodes)) {
    const n = flowNodes[k];
    if (n.type === "message" && n.next === id) n.next = successor;
    if (n.type === "question") (n.branches || []).forEach((b) => { if (b.next === id) b.next = successor; });
  }
  // Remove the node and any orphaned sub-trees (for questions, drop the whole subtree)
  collectAndDelete(id, successor);
  if (openModuleId === id) openModuleId = null;
  renderFlow();
}
function collectAndDelete(id, keepId) {
  const n = flowNodes[id];
  if (!n) return;
  delete flowNodes[id];
  if (n.type === "message" && n.next && n.next !== keepId) collectAndDelete(n.next, keepId);
  if (n.type === "question") (n.branches || []).forEach((b) => { if (b.next) collectAndDelete(b.next, keepId); });
}

/* ---------- Save / toggle / delete flow ---------- */
$("flowSave").addEventListener("click", async () => {
  if (openModuleId) applyEditor(openModuleId);
  const name = $("flowName").value.trim();
  if (!name) return toast("Give your flow a name", "error");
  if (!flowTrigger.trim()) return toast("Set a trigger keyword in the first module", "error");
  if (!flowStart) return toast("Add at least one module after the trigger", "error");

  // Friendly client-side validation + cleanup
  for (const id of Object.keys(flowNodes)) {
    const n = flowNodes[id];
    if ((n.type === "message" || n.type === "question") && !(n.text || "").trim())
      return toast(`A ${MODULE_META[n.type].label} module is empty — add its text`, "error");
    if (n.type === "question") {
      n.branches = (n.branches || []).filter((b) => (b.match || "").trim());
      if (!n.branches.length) return toast("Each question needs at least one answer option", "error");
    }
  }

  const definition = { start: flowStart, nodes: flowNodes };
  const body = { name, trigger_keyword: flowTrigger.trim(), definition };
  const r = editingFlowId ? await PUT(`/api/flows/${editingFlowId}`, body) : await POST("/api/flows", body);
  if (r?.ok) {
    $("flowSaved").classList.remove("hidden");
    setTimeout(() => $("flowSaved").classList.add("hidden"), 2000);
    toast(editingFlowId ? "Flow saved" : "Flow created", "success");
    if (r.id) editingFlowId = r.id;
    loadFlows();
  } else toast(r?.error || "Error saving flow", "error");
});

$("flowToggle").addEventListener("click", async () => {
  if (!editingFlowId) return;
  const f = flows.find((x) => x.id === editingFlowId);
  await POST(`/api/flows/${editingFlowId}/toggle`, { active: !f?.active });
  toast(f?.active ? "Flow deactivated" : "Flow activated", "success");
  loadFlows();
});

$("flowDelete").addEventListener("click", async () => {
  if (!editingFlowId || !confirm("Delete this flow?")) return;
  await DELETE(`/api/flows/${editingFlowId}`);
  editingFlowId = null;
  loadFlows();
});

/* ============================================================
   ANALYTICS — professional dashboard with SVG charts
   ============================================================ */
async function loadAnalytics() {
  const d = await GET("/api/analytics");
  if (!d) return;

  const limit = d.quota.limit === null || d.quota.limit > 1e9 ? "∞" : d.quota.limit;
  const pl = d.pipeline || { openValue: 0, wonValue: 0, openCount: 0, wonCount: 0 };

  // KPI cards (no emoji — clean eyebrow + tabular figure + caption)
  $("kpiRow").innerHTML = [
    kpiCard("Conversations", num(d.totalChats), `${d.activeChats7} active this week`, "brand"),
    kpiCard("Messages · 30d", num(d.inbound30 + d.outbound30), `${num(d.inbound30)} received · ${num(d.outbound30)} sent`, "ink"),
    kpiCard("AI handled", d.outbound30 ? d.aiHandledPct + "%" : "—", `${num(d.automatedReplies30)} automated replies`, "gold"),
    kpiCard("Conversion", d.conversionRate + "%", `${num(d.customers)} customers won`, "teal"),
    kpiCard("Pipeline value", fmtMoney(pl.openValue, "USD"), `${fmtMoney(pl.wonValue, "USD")} won · ${pl.openCount} open`, "brand"),
  ].join("");

  renderAreaChart($("anAreaChart"), d.daily || []);
  renderDonut($("anDonut"), d.via || {});
  renderFunnel($("anFunnel"), d.lifecycle || {});
}

function num(n) { return (Number(n) || 0).toLocaleString(); }

function kpiCard(label, value, sub, tone) {
  return `<div class="kpi-card kpi-${tone}">
    <div class="kpi-eyebrow">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;
}

/* ---- Smooth area chart with interactive crosshair ---- */
function niceMax(v) {
  if (v <= 4) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}
function smoothPath(pts) {
  if (!pts.length) return "";
  if (pts.length < 2) return `M${pts[0].x},${pts[0].y}`;
  let dd = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    dd += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x},${p2.y}`;
  }
  return dd;
}

function renderAreaChart(el, daily) {
  if (!daily.length) { el.innerHTML = `<div class="an-empty">No message data yet.</div>`; return; }
  const W = 760, H = 250, pL = 34, pR = 14, pT = 16, pB = 26;
  const plotW = W - pL - pR, plotH = H - pT - pB;
  const maxV = niceMax(Math.max(1, ...daily.map((x) => Math.max(x.inbound, x.outbound))));
  const xAt = (i) => pL + (daily.length === 1 ? plotW / 2 : (i / (daily.length - 1)) * plotW);
  const yAt = (v) => pT + plotH - (v / maxV) * plotH;

  const inPts = daily.map((x, i) => ({ x: xAt(i), y: yAt(x.inbound) }));
  const outPts = daily.map((x, i) => ({ x: xAt(i), y: yAt(x.outbound) }));
  const areaPath = (pts) => `${smoothPath(pts)} L${pts[pts.length - 1].x},${pT + plotH} L${pts[0].x},${pT + plotH} Z`;

  // gridlines + y labels (4 ticks)
  let grid = "", yl = "";
  for (let t = 0; t <= 4; t++) {
    const v = (maxV / 4) * t, y = yAt(v);
    grid += `<line x1="${pL}" y1="${y}" x2="${W - pR}" y2="${y}" class="an-grid-line"/>`;
    yl += `<text x="${pL - 8}" y="${y + 3}" class="an-axis y">${Math.round(v)}</text>`;
  }
  // x labels (~6 evenly)
  let xl = "";
  const step = Math.max(1, Math.ceil(daily.length / 6));
  daily.forEach((x, i) => {
    if (i % step === 0 || i === daily.length - 1) {
      const dt = new Date(x.d + "T00:00:00");
      const lbl = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      xl += `<text x="${xAt(i)}" y="${H - 8}" class="an-axis x">${lbl}</text>`;
    }
  });

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="an-svg" preserveAspectRatio="none">
      <defs>
        <linearGradient id="gradIn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--brand-500)" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="var(--brand-500)" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="gradOut" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--gold)" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${areaPath(inPts)}" fill="url(#gradIn)"/>
      <path d="${areaPath(outPts)}" fill="url(#gradOut)"/>
      <path d="${smoothPath(outPts)}" class="an-line an-line-out"/>
      <path d="${smoothPath(inPts)}" class="an-line an-line-in"/>
      ${yl}${xl}
      <g class="an-cross hidden">
        <line class="an-cross-line"/>
        <circle class="an-cross-dot an-dot-in" r="4"/>
        <circle class="an-cross-dot an-dot-out" r="4"/>
      </g>
      <rect x="${pL}" y="${pT}" width="${plotW}" height="${plotH}" fill="transparent" class="an-hit"/>
    </svg>
    <div class="an-tip hidden" id="anTip"></div>`;

  // interactivity
  const svg = el.querySelector(".an-svg");
  const hit = el.querySelector(".an-hit");
  const cross = el.querySelector(".an-cross");
  const cl = el.querySelector(".an-cross-line");
  const dIn = el.querySelector(".an-dot-in");
  const dOut = el.querySelector(".an-dot-out");
  const tip = el.querySelector("#anTip");
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let i = Math.round(((px - pL) / plotW) * (daily.length - 1));
    i = Math.max(0, Math.min(daily.length - 1, i));
    const x = xAt(i);
    cross.classList.remove("hidden");
    cl.setAttribute("x1", x); cl.setAttribute("x2", x); cl.setAttribute("y1", pT); cl.setAttribute("y2", pT + plotH);
    dIn.setAttribute("cx", x); dIn.setAttribute("cy", yAt(daily[i].inbound));
    dOut.setAttribute("cx", x); dOut.setAttribute("cy", yAt(daily[i].outbound));
    const dt = new Date(daily[i].d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    tip.classList.remove("hidden");
    tip.innerHTML = `<div class="an-tip-date">${dt}</div><div class="an-tip-row"><i class="lg-dot lg-in"></i>Received <b>${daily[i].inbound}</b></div><div class="an-tip-row"><i class="lg-dot lg-out"></i>Sent <b>${daily[i].outbound}</b></div>`;
    const leftPct = (x / W) * 100;
    tip.style.left = `${leftPct}%`;
  });
  hit.addEventListener("mouseleave", () => { cross.classList.add("hidden"); tip.classList.add("hidden"); });
}

/* ---- Donut: reply sources ---- */
function renderDonut(el, via) {
  const SRC = [
    { key: "ai", label: "AI agent", color: "var(--brand-600)" },
    { key: "rule", label: "Keyword rules", color: "var(--brand-400)" },
    { key: "flow", label: "Flows", color: "var(--gold)" },
    { key: "sequence", label: "Sequences", color: "oklch(0.68 0.1 200)" },
    { key: "human", label: "Manual", color: "oklch(0.78 0.012 240)" },
  ];
  const data = SRC.map((s) => ({ ...s, n: via[s.key] || 0 })).filter((s) => s.n > 0);
  const total = data.reduce((a, b) => a + b.n, 0);
  if (!total) { el.innerHTML = `<div class="an-empty">No replies sent yet.</div>`; return; }

  const r = 56, cx = 70, cy = 70, C = 2 * Math.PI * r;
  let offset = 0;
  const arcs = data.map((s) => {
    const frac = s.n / total;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="20"
      stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset * C).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})" class="an-arc"/>`;
    offset += frac;
    return seg;
  }).join("");

  const legend = data.map((s) => `
    <div class="donut-leg">
      <i class="donut-dot" style="background:${s.color}"></i>
      <span class="donut-leg-label">${s.label}</span>
      <span class="donut-leg-val">${Math.round((s.n / total) * 100)}%</span>
    </div>`).join("");

  el.innerHTML = `
    <svg viewBox="0 0 140 140" class="donut-svg">${arcs}
      <text x="70" y="66" class="donut-total">${num(total)}</text>
      <text x="70" y="84" class="donut-cap">replies</text>
    </svg>
    <div class="donut-legend">${legend}</div>`;
}

/* ---- Lifecycle funnel ---- */
function renderFunnel(el, lc) {
  const stages = [
    ["new_lead", "New Lead"], ["hot_lead", "Hot Lead"], ["payment", "Payment"],
    ["customer", "Customer"], ["closed_won", "Closed-Won"],
  ];
  const first = lc[stages[0][0]] || 0;
  const fMax = Math.max(1, ...stages.map(([k]) => lc[k] || 0));
  // deepening green ramp
  const tones = ["oklch(0.78 0.08 165)", "oklch(0.70 0.11 162)", "oklch(0.62 0.13 160)", "oklch(0.54 0.14 159)", "oklch(0.46 0.13 158)"];
  el.innerHTML = stages.map(([k, label], i) => {
    const n = lc[k] || 0;
    const w = Math.round((n / fMax) * 100);
    const conv = first ? Math.round((n / first) * 100) : 0;
    return `<div class="funnel2-row">
      <span class="funnel2-label">${label}</span>
      <div class="funnel2-track">
        <div class="funnel2-bar" style="width:${Math.max(w, 3)}%;background:${tones[i]}"></div>
        <span class="funnel2-count">${n}</span>
      </div>
      <span class="funnel2-pct">${conv}%</span>
    </div>`;
  }).join("");
}

/* ============================================================
   FOLLOW-UP SEQUENCES
   ============================================================ */
const LC_LABELS = { new_lead: "🆕 New Lead", hot_lead: "🔥 Hot Lead", payment: "💰 Payment", customer: "😊 Customer", closed_won: "🏆 Closed-Won" };

async function loadSequences() {
  const seqs = await GET("/api/sequences") || [];
  const list = $("sequenceList");
  list.innerHTML = seqs.length ? seqs.map((s) => {
    const trig = s.trigger_type === "lifecycle" ? `When chat → ${LC_LABELS[s.trigger_value] || s.trigger_value}`
      : s.trigger_type === "no_reply" ? `When quiet for ${s.trigger_value || 24}h`
      : "Manual enrollment";
    return `<div class="seq-card${s.active ? "" : " inactive"}">
      <div class="seq-card-main">
        <div class="seq-card-top">
          <span class="seq-name">${escHtml(s.name)}</span>
          <span class="seq-trigger-pill">${trig}</span>
          ${s.active ? "" : `<span class="seq-paused">Paused</span>`}
        </div>
        <div class="seq-card-meta">${s.steps.length} step${s.steps.length !== 1 ? "s" : ""} · ${s.active_enrollments} active now</div>
      </div>
      <div class="seq-card-actions">
        <button class="ghost-btn seq-edit" data-id="${s.id}">Edit</button>
        <button class="ghost-btn seq-toggle" data-id="${s.id}" data-active="${s.active}">${s.active ? "Pause" : "Activate"}</button>
        <button class="danger-btn seq-del" data-id="${s.id}">Delete</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty">No sequences yet. Create one to automatically follow up with leads.</div>`;

  list.querySelectorAll(".seq-edit").forEach((b) => b.addEventListener("click", () => openSequenceModal(seqs.find((s) => s.id == b.dataset.id))));
  list.querySelectorAll(".seq-toggle").forEach((b) => b.addEventListener("click", async () => {
    await POST(`/api/sequences/${b.dataset.id}/toggle`, { active: b.dataset.active !== "1" });
    loadSequences();
  }));
  list.querySelectorAll(".seq-del").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this sequence?")) return;
    await DELETE(`/api/sequences/${b.dataset.id}`);
    loadSequences();
  }));
}

$("newSequenceBtn").addEventListener("click", () => openSequenceModal(null));

function seqStepRow(step = { delay_minutes: 60, body: "" }, idx = 0) {
  return `<div class="seq-step" data-idx="${idx}">
    <div class="seq-step-head">
      <span class="seq-step-num">Step ${idx + 1}</span>
      <label class="seq-delay">send after
        <input type="number" class="seq-step-delay" min="0" value="${step.delay_minutes}" /> min
      </label>
      <button class="seq-step-del" title="Remove step">×</button>
    </div>
    <textarea class="seq-step-body" rows="2" placeholder="Message… use {{first_name}}">${escHtml(step.body || "")}</textarea>
  </div>`;
}

function renderSeqSteps(steps) {
  const wrap = $("seqSteps");
  wrap.innerHTML = steps.map((s, i) => seqStepRow(s, i)).join("");
  wrap.querySelectorAll(".seq-step-del").forEach((b) => b.addEventListener("click", (e) => {
    e.target.closest(".seq-step").remove();
    renumberSteps();
  }));
}
function renumberSteps() {
  $("seqSteps").querySelectorAll(".seq-step").forEach((el, i) => {
    el.dataset.idx = i;
    el.querySelector(".seq-step-num").textContent = `Step ${i + 1}`;
  });
}

function openSequenceModal(seq) {
  $("seqModalTitle").textContent = seq ? "Edit sequence" : "New follow-up sequence";
  $("seqModalId").value = seq?.id || "";
  $("seqName").value = seq?.name || "";
  $("seqTrigger").value = seq?.trigger_type || "manual";
  if (seq?.trigger_type === "no_reply") {
    $("seqTriggerValHours").value = seq.trigger_value || 24;
  } else if (seq?.trigger_type === "lifecycle") {
    $("seqTriggerValLifecycle").value = seq.trigger_value || "new_lead";
  }
  updateSeqTriggerUI();
  renderSeqSteps(seq?.steps?.length ? seq.steps : [{ delay_minutes: 0, body: "" }]);
  $("sequenceModal").classList.remove("hidden");
}

function updateSeqTriggerUI() {
  const t = $("seqTrigger").value;
  const lcSel = $("seqTriggerValLifecycle");
  const hrs = $("seqTriggerValHours");
  const label = $("seqTriggerValLabel");
  const field = label.parentElement;
  if (t === "lifecycle") { field.style.display = ""; label.textContent = "Lifecycle stage"; lcSel.classList.remove("hidden"); hrs.classList.add("hidden"); }
  else if (t === "no_reply") { field.style.display = ""; label.textContent = "Quiet for (hours)"; lcSel.classList.add("hidden"); hrs.classList.remove("hidden"); }
  else { field.style.display = "none"; }
}
$("seqTrigger").addEventListener("change", updateSeqTriggerUI);
$("seqAddStep").addEventListener("click", () => {
  const wrap = $("seqSteps");
  const idx = wrap.querySelectorAll(".seq-step").length;
  wrap.insertAdjacentHTML("beforeend", seqStepRow({ delay_minutes: 60, body: "" }, idx));
  wrap.querySelector(".seq-step:last-child .seq-step-del").addEventListener("click", (e) => { e.target.closest(".seq-step").remove(); renumberSteps(); });
});
$("seqModalClose").addEventListener("click", () => $("sequenceModal").classList.add("hidden"));
$("seqModalCancel").addEventListener("click", () => $("sequenceModal").classList.add("hidden"));

$("seqModalSave").addEventListener("click", async () => {
  const id = $("seqModalId").value;
  const trigger_type = $("seqTrigger").value;
  const trigger_value = trigger_type === "lifecycle" ? $("seqTriggerValLifecycle").value
    : trigger_type === "no_reply" ? String($("seqTriggerValHours").value || 24) : "";
  const steps = [...$("seqSteps").querySelectorAll(".seq-step")].map((el) => ({
    delay_minutes: parseInt(el.querySelector(".seq-step-delay").value, 10) || 0,
    body: el.querySelector(".seq-step-body").value.trim(),
  })).filter((s) => s.body);
  const name = $("seqName").value.trim();
  if (!name) return toast("Sequence name required", "error");
  if (!steps.length) return toast("Add at least one step with a message", "error");
  const payload = { name, trigger_type, trigger_value, steps };
  const r = id ? await PUT(`/api/sequences/${id}`, payload) : await POST("/api/sequences", payload);
  if (r?.ok) {
    $("sequenceModal").classList.add("hidden");
    loadSequences();
    toast(id ? "Sequence updated" : "Sequence created", "success");
  } else toast(r?.error || "Failed to save", "error");
});

/* ============================================================
   BROADCAST CAMPAIGNS
   ============================================================ */
async function loadBroadcasts() {
  await refreshBroadcastCount();
  const list = await GET("/api/broadcasts") || [];
  $("broadcastList").innerHTML = list.length ? list.map((b) => {
    const pct = b.total ? Math.round((b.sent / b.total) * 100) : 0;
    const statusPill = {
      draft: `<span class="bc-status draft">Draft</span>`,
      sending: `<span class="bc-status sending">Sending… ${pct}%</span>`,
      paused: `<span class="bc-status paused">Paused</span>`,
      done: `<span class="bc-status done">Done</span>`,
    }[b.status] || b.status;
    return `<div class="bc-card">
      <div class="bc-card-main">
        <div class="bc-card-top"><span class="bc-card-name">${escHtml(b.name || "Broadcast")}</span>${statusPill}</div>
        <div class="bc-card-meta">${b.sent}/${b.total} sent${b.failed ? ` · ${b.failed} failed` : ""}</div>
        <div class="bc-progress"><div class="bc-progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="bc-card-actions">
        ${b.status === "sending" ? `<button class="ghost-btn bc-pause" data-id="${b.id}">Pause</button>` : ""}
        ${b.status === "paused" ? `<button class="ghost-btn bc-resume" data-id="${b.id}">Resume</button>` : ""}
        <button class="danger-btn bc-del" data-id="${b.id}">Delete</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty">No campaigns yet.</div>`;

  $("broadcastList").querySelectorAll(".bc-pause").forEach((b) => b.addEventListener("click", async () => { await POST(`/api/broadcasts/${b.dataset.id}/pause`); loadBroadcasts(); }));
  $("broadcastList").querySelectorAll(".bc-resume").forEach((b) => b.addEventListener("click", async () => { await POST(`/api/broadcasts/${b.dataset.id}/start`); loadBroadcasts(); }));
  $("broadcastList").querySelectorAll(".bc-del").forEach((b) => b.addEventListener("click", async () => { if (confirm("Delete this campaign?")) { await DELETE(`/api/broadcasts/${b.dataset.id}`); loadBroadcasts(); } }));
}

function bcSegmentPayload() {
  const type = $("bcSegment").value;
  let value = "";
  if (type === "lifecycle") value = $("bcSegmentValue").value;
  else if (type === "tag") value = $("bcTagValue").value.trim();
  return { segment_type: type, segment_value: value };
}

async function refreshBroadcastCount() {
  const r = await POST("/api/broadcasts/preview", bcSegmentPayload());
  $("bcCount").textContent = r ? `${r.count} recipient${r.count !== 1 ? "s" : ""}` : "—";
}

$("bcSegment").addEventListener("change", () => {
  const t = $("bcSegment").value;
  $("bcSegmentValue").classList.toggle("hidden", t !== "lifecycle");
  $("bcTagValue").classList.toggle("hidden", t !== "tag");
  refreshBroadcastCount();
});
$("bcSegmentValue").addEventListener("change", refreshBroadcastCount);
$("bcTagValue").addEventListener("input", refreshBroadcastCount);

$("bcSend").addEventListener("click", async () => {
  const body = $("bcBody").value.trim();
  if (!body) return toast("Write a message first", "error");
  const seg = bcSegmentPayload();
  const preview = await POST("/api/broadcasts/preview", seg);
  if (!preview || preview.count === 0) return toast("No recipients match this segment", "error");
  if (!confirm(`Send this broadcast to ${preview.count} recipient${preview.count !== 1 ? "s" : ""}?`)) return;
  const r = await POST("/api/broadcasts", { name: $("bcName").value.trim() || "Broadcast", body, ...seg, send_now: true });
  if (r?.ok) {
    $("bcName").value = ""; $("bcBody").value = "";
    toast(`📣 Broadcast queued to ${r.total} contacts`, "success");
    loadBroadcasts();
  } else toast(r?.error || "Failed to start broadcast", "error");
});

/* ============================================================
   CONTACTS
   ============================================================ */
let contacts = [];
let contactFields = [];
let contactSearch = "";

async function loadContacts() {
  const d = await GET("/api/contacts");
  contacts = d?.contacts || [];
  contactFields = d?.fields || [];
  renderContacts();
}

function renderContacts() {
  const q = contactSearch.trim().toLowerCase();
  const qd = contactSearch.replace(/[^0-9]/g, "");
  const rows = contacts.filter((c) => {
    if (!q) return true;
    return (c.name || "").toLowerCase().includes(q) ||
      (c.email || "").toLowerCase().includes(q) ||
      (c.company || "").toLowerCase().includes(q) ||
      (qd && (c.phone || "").replace(/[^0-9]/g, "").includes(qd));
  });

  const customCols = contactFields.map((f) => `<th>${escHtml(f.label)}</th>`).join("");
  const head = `<thead><tr>
    <th>Name</th><th>Phone</th><th>Email</th><th>Company</th>${customCols}<th style="width:90px"></th>
  </tr></thead>`;

  const body = rows.length ? rows.map((c) => {
    const init = initials(c.name, c.jid);
    const custom = customCols ? contactFields.map((f) => `<td>${escHtml(c.custom?.[f.field_key] || "")}</td>`).join("") : "";
    return `<tr data-id="${c.id}" data-jid="${escHtml(c.jid || "")}">
      <td class="ct-name"><span class="ct-avatar ${avatarClass(c.jid || String(c.id))}">${init}</span><span>${escHtml(c.name || "—")}</span></td>
      <td>${c.phone ? "+" + escHtml(c.phone) : "—"}</td>
      <td>${escHtml(c.email || "—")}</td>
      <td>${escHtml(c.company || "—")}</td>
      ${custom}
      <td class="ct-actions">
        ${c.jid ? `<button class="ct-chat" data-jid="${escHtml(c.jid)}" title="Open chat">Chat</button>` : ""}
        <button class="ct-edit" data-id="${c.id}" title="Edit">Edit</button>
      </td>
    </tr>`;
  }).join("") : `<tr><td colspan="${5 + contactFields.length}" class="ct-empty">${contactSearch ? "No contacts match your search." : "No contacts yet."}</td></tr>`;

  $("contactsTable").innerHTML = head + `<tbody>${body}</tbody>`;

  $("contactsTable").querySelectorAll(".ct-chat").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelector('.nav-btn[data-view="chats"]').click();
    openChat(b.dataset.jid);
  }));
  $("contactsTable").querySelectorAll(".ct-edit").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    openContactModal(contacts.find((c) => c.id == b.dataset.id));
  }));
  // Click row → open chat if linked
  $("contactsTable").querySelectorAll("tbody tr[data-jid]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const jid = tr.dataset.jid;
      if (jid) { document.querySelector('.nav-btn[data-view="chats"]').click(); openChat(jid); }
      else openContactModal(contacts.find((c) => c.id == tr.dataset.id));
    });
  });
}

$("contactSearch").addEventListener("input", (e) => { contactSearch = e.target.value; renderContacts(); });

/* Contact add/edit modal */
$("contactAddBtn").addEventListener("click", () => openContactModal(null));
$("contactModalClose").addEventListener("click", () => $("contactModal").classList.add("hidden"));
$("contactCancelBtn").addEventListener("click", () => $("contactModal").classList.add("hidden"));

function openContactModal(c) {
  $("contactModalTitle").textContent = c ? "Edit contact" : "Add contact";
  $("contactModalId").value = c?.id || "";
  $("cf_name").value = c?.name || "";
  $("cf_phone").value = c?.phone ? (c.phone.startsWith("+") ? c.phone : "+" + c.phone) : "";
  $("cf_email").value = c?.email || "";
  $("cf_company").value = c?.company || "";
  $("cf_notes").value = c?.notes || "";
  $("cf_custom").innerHTML = contactFields.map((f) => `
    <div class="modal-field"><label>${escHtml(f.label)}</label>
      <input data-key="${f.field_key}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" value="${escHtml(c?.custom?.[f.field_key] || "")}" /></div>`).join("");
  $("contactDeleteBtn").classList.toggle("hidden", !c);
  $("contactDeleteBtn").onclick = c ? async () => {
    if (!confirm("Delete this contact?")) return;
    await DELETE(`/api/contacts/${c.id}`);
    $("contactModal").classList.add("hidden");
    loadContacts();
  } : null;
  $("contactModal").classList.remove("hidden");
}

$("contactSaveBtn").addEventListener("click", async () => {
  const id = $("contactModalId").value;
  const custom = {};
  $("cf_custom").querySelectorAll("input[data-key]").forEach((i) => { if (i.value) custom[i.dataset.key] = i.value; });
  const body = {
    name: $("cf_name").value.trim(), phone: $("cf_phone").value.trim(),
    email: $("cf_email").value.trim(), company: $("cf_company").value.trim(),
    notes: $("cf_notes").value.trim(), custom,
  };
  if (!body.name && !body.phone && !body.email) return toast("Add at least a name, phone, or email", "error");
  const r = id ? await PUT(`/api/contacts/${id}`, body) : await POST("/api/contacts", body);
  if (r?.ok) { $("contactModal").classList.add("hidden"); loadContacts(); toast(id ? "Contact updated" : "Contact added", "success"); }
  else toast(r?.error || "Failed to save", "error");
});

/* Custom fields modal */
$("contactFieldsBtn").addEventListener("click", () => { renderFieldsModal(); $("fieldsModal").classList.remove("hidden"); });
$("fieldsModalClose").addEventListener("click", () => { $("fieldsModal").classList.add("hidden"); loadContacts(); });
function renderFieldsModal() {
  $("fieldsList").innerHTML = contactFields.length
    ? contactFields.map((f) => `<div class="field-row"><span>${escHtml(f.label)} <small>${f.type}</small></span><button class="field-del" data-id="${f.id}">×</button></div>`).join("")
    : `<div style="font-size:13px;color:var(--ink-4);padding:6px 0">No custom columns yet.</div>`;
  $("fieldsList").querySelectorAll(".field-del").forEach((b) => b.addEventListener("click", async () => {
    await DELETE(`/api/contact-fields/${b.dataset.id}`);
    const d = await GET("/api/contacts"); contactFields = d?.fields || []; renderFieldsModal();
  }));
}
$("addFieldBtn").addEventListener("click", async () => {
  const label = $("newFieldLabel").value.trim();
  if (!label) return toast("Column name required", "error");
  const r = await POST("/api/contact-fields", { label, type: $("newFieldType").value });
  if (r?.ok) { $("newFieldLabel").value = ""; const d = await GET("/api/contacts"); contactFields = d?.fields || []; renderFieldsModal(); }
});

/* Import / Export */
$("contactExportBtn").addEventListener("click", () => downloadCsv("/api/contacts/export.csv", "contacts.csv"));
$("contactImportBtn").addEventListener("click", () => { $("importDropText").textContent = "Click to choose a CSV file"; $("importFile").value = ""; $("importModal").classList.remove("hidden"); });
$("importModalClose").addEventListener("click", () => $("importModal").classList.add("hidden"));
$("importCancelBtn").addEventListener("click", () => $("importModal").classList.add("hidden"));
$("downloadSampleBtn").addEventListener("click", () => downloadCsv("/api/contacts/sample.csv", "contacts-sample.csv"));
$("importFile").addEventListener("change", (e) => { $("importDropText").textContent = e.target.files[0]?.name || "Click to choose a CSV file"; });
$("importRunBtn").addEventListener("click", async () => {
  const file = $("importFile").files[0];
  if (!file) return toast("Choose a CSV file first", "error");
  const fd = new FormData(); fd.append("file", file);
  const r = await api("POST", "/api/contacts/import", fd, true);
  if (r?.ok) { $("importModal").classList.add("hidden"); loadContacts(); toast(`Imported — ${r.added} added, ${r.updated} updated`, "success"); }
  else toast(r?.error || "Import failed", "error");
});

async function downloadCsv(path, filename) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${TOKEN}` } });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ============================================================
   PIPELINE (deals kanban)
   ============================================================ */
let pipeStages = [];
let pipeDeals = [];
let dragDealId = null;

async function loadPipeline() {
  const d = await GET("/api/pipeline");
  pipeStages = d?.stages || [];
  pipeDeals = d?.deals || [];
  renderPipeline();
}

function fmtMoney(v, cur) {
  const n = Number(v) || 0;
  const sym = { USD: "$", EUR: "€", GBP: "£", PKR: "₨", AED: "د.إ", INR: "₹" }[cur] || "";
  return `${sym}${n.toLocaleString()}${sym ? "" : " " + (cur || "")}`;
}

function renderPipeline() {
  const board = $("pipelineBoard");
  board.innerHTML = pipeStages.map((s) => {
    const deals = pipeDeals.filter((d) => d.stage_id === s.id);
    const total = deals.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
    const cur = deals[0]?.currency || "USD";
    const cards = deals.map((d) => `
      <div class="deal-card" draggable="true" data-id="${d.id}">
        <div class="deal-title">${escHtml(d.title)}</div>
        <div class="deal-meta">
          <span class="deal-contact">${escHtml(d.contact_name || "—")}</span>
          <span class="deal-value">${fmtMoney(d.value, d.currency)}</span>
        </div>
      </div>`).join("");
    return `<div class="pipe-col${s.is_won ? " pipe-won" : ""}${s.is_lost ? " pipe-lost" : ""}" data-stage="${s.id}">
      <div class="pipe-col-head">
        <span class="pipe-col-name">${escHtml(s.name)} <span class="pipe-col-count">(${deals.length})</span></span>
        <span class="pipe-col-total">${total ? fmtMoney(total, cur) : ""}</span>
        ${pipeStages.length > 1 ? `<button class="pipe-col-del" data-id="${s.id}" title="Delete stage">×</button>` : ""}
      </div>
      <div class="pipe-col-body" data-stage="${s.id}">${cards}</div>
    </div>`;
  }).join("");

  // Card click → client details
  board.querySelectorAll(".deal-card").forEach((el) => {
    el.addEventListener("click", () => {
      const deal = pipeDeals.find((d) => d.id == el.dataset.id);
      if (deal) openClientDrawer(deal.jid, deal.contact_name, deal);
    });
    el.addEventListener("dragstart", (e) => { dragDealId = el.dataset.id; el.classList.add("dragging"); });
    el.addEventListener("dragend", () => { dragDealId = null; el.classList.remove("dragging"); board.querySelectorAll(".pipe-col-body").forEach((c) => c.classList.remove("drop-hover")); });
  });
  // Column drop targets
  board.querySelectorAll(".pipe-col-body").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop-hover"); });
    col.addEventListener("dragleave", () => col.classList.remove("drop-hover"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drop-hover");
      if (!dragDealId) return;
      const stageId = parseInt(col.dataset.stage, 10);
      const deal = pipeDeals.find((d) => d.id == dragDealId);
      if (deal && deal.stage_id !== stageId) {
        deal.stage_id = stageId;
        renderPipeline();
        await POST(`/api/deals/${dragDealId}/move`, { stage_id: stageId });
      }
    });
  });
  // Stage delete
  board.querySelectorAll(".pipe-col-del").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this stage? Its deals move to another stage.")) return;
    const r = await DELETE(`/api/pipeline/stages/${b.dataset.id}`);
    if (r?.ok) loadPipeline(); else toast(r?.error || "Couldn't delete", "error");
  }));
}

$("stageAddBtn").addEventListener("click", async () => {
  const name = prompt("New stage name:");
  if (!name?.trim()) return;
  const r = await POST("/api/pipeline/stages", { name: name.trim() });
  if (r?.ok) loadPipeline();
});

/* Deal modal */
$("dealAddBtn").addEventListener("click", () => openDealModal(null));
$("dealModalClose").addEventListener("click", () => $("dealModal").classList.add("hidden"));
$("dealCancelBtn").addEventListener("click", () => $("dealModal").classList.add("hidden"));

function openDealModal(d, presetJid, presetContact) {
  $("dealModalTitle").textContent = d ? "Edit deal" : "Add deal";
  $("dealModalId").value = d?.id || "";
  $("df_title").value = d?.title || "";
  $("df_contact").value = d?.contact_name || presetContact || "";
  $("df_value").value = d?.value || "";
  $("df_currency").value = d?.currency || "USD";
  $("df_stage").innerHTML = pipeStages.map((s) => `<option value="${s.id}" ${d && d.stage_id === s.id ? "selected" : ""}>${escHtml(s.name)}</option>`).join("");
  $("dealModal").dataset.jid = d?.jid || presetJid || "";
  $("dealDeleteBtn").classList.toggle("hidden", !d);
  $("dealDeleteBtn").onclick = d ? async () => {
    if (!confirm("Delete this deal?")) return;
    await DELETE(`/api/deals/${d.id}`);
    $("dealModal").classList.add("hidden");
    loadPipeline();
    if (activeJid) loadChatDeal(activeJid);
  } : null;
  $("dealModal").classList.remove("hidden");
}

$("dealSaveBtn").addEventListener("click", async () => {
  const id = $("dealModalId").value;
  const body = {
    title: $("df_title").value.trim(),
    contact_name: $("df_contact").value.trim(),
    value: $("df_value").value,
    currency: $("df_currency").value,
    stage_id: parseInt($("df_stage").value, 10),
    jid: $("dealModal").dataset.jid || null,
  };
  if (!body.title) return toast("Deal title required", "error");
  // ensure stages loaded for stage_id default
  if (!pipeStages.length) await loadPipeline();
  const r = id ? await PUT(`/api/deals/${id}`, body) : await POST("/api/deals", body);
  if (r?.ok) {
    $("dealModal").classList.add("hidden");
    loadPipeline();
    if (activeJid) loadChatDeal(activeJid);
    toast(id ? "Deal updated" : "Deal added", "success");
  } else toast(r?.error || "Failed to save", "error");
});

/* ============================================================
   CLIENT DETAILS DRAWER (from pipeline / contacts)
   ============================================================ */
$("clientClose").addEventListener("click", () => $("clientDrawer").classList.add("hidden"));
$("clientDrawer").addEventListener("click", (e) => { if (e.target.id === "clientDrawer") $("clientDrawer").classList.add("hidden"); });

async function openClientDrawer(jid, fallbackName, presetDeal) {
  const data = jid ? await GET(`/api/client?jid=${encodeURIComponent(jid)}`) : { contact: null, deals: presetDeal ? [presetDeal] : [], fields: [] };
  if (data.fields) contactFields = data.fields;
  const c = data.contact;
  const name = c?.name || fallbackName || "Unknown client";
  const phone = c?.phone || (jid ? jid.replace(/@s\.whatsapp\.net$/, "") : "");
  const deals = data.deals?.length ? data.deals : (presetDeal ? [presetDeal] : []);

  const row = (label, value, isLink) => value ? `<div class="cd-row"><span class="cd-label">${label}</span><span class="cd-val">${isLink ? value : escHtml(value)}</span></div>` : "";
  const customRows = c ? contactFields.map((f) => row(escHtml(f.label), c.custom?.[f.field_key])).join("") : "";

  const dealCards = deals.map((d) => {
    const stage = pipeStages.find((s) => s.id === d.stage_id);
    return `<div class="cd-deal" data-id="${d.id}">
      <div class="cd-deal-top"><span class="cd-deal-title">${escHtml(d.title)}</span><span class="cd-deal-val">${fmtMoney(d.value, d.currency)}</span></div>
      <div class="cd-deal-stage">${escHtml(stage?.name || "—")}</div>
    </div>`;
  }).join("") || `<div class="cd-empty">No deals yet.</div>`;

  $("clientBody").innerHTML = `
    <div class="cd-header">
      <span class="cd-avatar ${avatarClass(jid || name)}">${initials(name, jid)}</span>
      <div class="cd-headinfo">
        <div class="cd-name">${escHtml(name)}</div>
        ${phone ? `<div class="cd-phone">+${escHtml(phone)}</div>` : ""}
      </div>
    </div>
    <div class="cd-actions">
      ${jid ? `<button class="primary-btn" id="cdChat">Open chat</button>` : ""}
      ${c ? `<button class="ghost-btn" id="cdEditContact">Edit contact</button>` : `<button class="ghost-btn" id="cdAddContact">Add as contact</button>`}
    </div>
    <div class="cd-section">
      <div class="cd-section-title">Details</div>
      ${row("Email", c?.email)}
      ${row("Company", c?.company)}
      ${customRows}
      ${c?.notes ? `<div class="cd-notes">${escHtml(c.notes)}</div>` : ""}
      ${!c?.email && !c?.company && !customRows && !c?.notes ? `<div class="cd-empty">No extra details yet.</div>` : ""}
    </div>
    <div class="cd-section">
      <div class="cd-section-title">Deals <button class="cd-add-deal" id="cdAddDeal">+ Add</button></div>
      ${dealCards}
    </div>`;

  // wire actions
  $("cdChat") && $("cdChat").addEventListener("click", () => {
    $("clientDrawer").classList.add("hidden");
    document.querySelector('.nav-btn[data-view="chats"]').click();
    openChat(jid);
  });
  $("cdEditContact") && $("cdEditContact").addEventListener("click", () => { $("clientDrawer").classList.add("hidden"); openContactModal(c); });
  $("cdAddContact") && $("cdAddContact").addEventListener("click", () => {
    $("clientDrawer").classList.add("hidden");
    openContactModal({ name, phone: phone ? "+" + phone : "", jid });
  });
  $("cdAddDeal") && $("cdAddDeal").addEventListener("click", async () => {
    $("clientDrawer").classList.add("hidden");
    if (!pipeStages.length) await loadPipeline();
    openDealModal(null, jid, name);
  });
  $("clientBody").querySelectorAll(".cd-deal").forEach((el) => el.addEventListener("click", () => {
    const deal = deals.find((d) => d.id == el.dataset.id);
    $("clientDrawer").classList.add("hidden");
    if (deal) openDealModal(deal);
  }));

  $("clientDrawer").classList.remove("hidden");
}

/* ============================================================
   BRANDING (white-label)
   ============================================================ */
const BRAND_SWATCHES = [
  { name: "Emerald", h: 158 }, { name: "Teal", h: 195 }, { name: "Blue", h: 250 },
  { name: "Violet", h: 290 }, { name: "Magenta", h: 350 }, { name: "Crimson", h: 25 },
  { name: "Amber", h: 70 },
];
let brandingState = null;

async function loadBranding() {
  const b = await GET("/api/branding");
  if (!b) return;
  brandingState = b;
  $("bvName").value = b.app_name === "Zaply" ? "" : b.app_name;
  $("bvSubtitle").value = b.login_subtitle || "";
  $("bvPoweredBy").checked = !!b.powered_by;
  $("bvDomain").value = b.custom_domain || "";
  $("bvHue").value = b.hue;
  renderLogoPreview(b.logo);

  // swatches
  $("bvSwatches").innerHTML = BRAND_SWATCHES.map((s) => `
    <button class="brand-swatch${s.h === Number(b.hue) ? " active" : ""}" data-h="${s.h}" title="${s.name}"
      style="background:oklch(0.55 0.15 ${s.h})"></button>`).join("");
  $("bvSwatches").querySelectorAll(".brand-swatch").forEach((el) => el.addEventListener("click", () => {
    $("bvHue").value = el.dataset.h;
    $("bvSwatches").querySelectorAll(".brand-swatch").forEach((s) => s.classList.remove("active"));
    el.classList.add("active");
    previewBranding();
  }));

  previewBranding();
}

function renderLogoPreview(logo) {
  const el = $("bvLogoPreview");
  el.innerHTML = logo ? `<img src="${logo}" alt="logo"/>` : `<span>No logo</span>`;
  el.dataset.logo = logo || "";
}

// Live preview from current form values
function previewBranding() {
  const hue = $("bvHue").value;
  const name = $("bvName").value.trim() || "Zaply";
  const logo = $("bvLogoPreview").dataset.logo || "";
  $("bvHueChip").style.background = `oklch(0.50 0.14 ${hue})`;
  // preview card
  const card = $("bvPreviewCard");
  card.style.setProperty("--brand-h", hue);
  $("bpName").textContent = name;
  $("bpLogo").innerHTML = logo ? `<img src="${logo}" style="width:100%;height:100%;object-fit:contain"/>` : "";
  $("bpLogo").style.background = logo ? "transparent" : `oklch(0.50 0.14 ${hue})`;
}

["bvName", "bvHue"].forEach((id) => $(id).addEventListener("input", previewBranding));

$("bvLogoFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append("file", file);
  const r = await api("POST", "/api/branding/logo", fd, true);
  if (r?.logo) { renderLogoPreview(r.logo); previewBranding(); applyBranding({ ...brandingState, logo: r.logo, hue: $("bvHue").value, app_name: $("bvName").value.trim() || "Zaply" }); toast("Logo uploaded", "success"); }
  else toast(r?.error || "Upload failed", "error");
  e.target.value = "";
});
$("bvLogoRemove").addEventListener("click", async () => {
  await DELETE("/api/branding/logo");
  renderLogoPreview(""); previewBranding();
  applyBranding({ ...brandingState, logo: "", hue: $("bvHue").value, app_name: $("bvName").value.trim() || "Zaply" });
});

$("bvSave").addEventListener("click", async () => {
  const body = {
    app_name: $("bvName").value.trim() || "Zaply",
    hue: Number($("bvHue").value),
    login_subtitle: $("bvSubtitle").value.trim(),
    powered_by: $("bvPoweredBy").checked,
    custom_domain: $("bvDomain").value.trim(),
  };
  const r = await POST("/api/branding", body);
  if (r?.ok) {
    brandingState = r.branding;
    applyBranding(r.branding);
    $("bvSaved").classList.remove("hidden");
    setTimeout(() => $("bvSaved").classList.add("hidden"), 2000);
    toast("Branding saved", "success");
  } else toast(r?.error || "Couldn't save", "error");
});

/* ============================================================
   STARTER PACKS
   ============================================================ */
async function loadPacks() {
  const packs = await GET("/api/starter-packs") || [];
  $("packsList").innerHTML = packs.map((p) => `
    <div class="pack-card">
      <div class="pack-emoji">${p.emoji}</div>
      <div class="pack-name">${escHtml(p.name)}</div>
      <div class="pack-desc">${escHtml(p.description)}</div>
      <div class="pack-meta">1 agent · ${p.templates} templates · ${p.rules} auto-replies</div>
      <button class="ghost-btn pack-install" data-id="${p.id}" data-name="${escHtml(p.name)}">Install pack</button>
    </div>`).join("");
  $("packsList").querySelectorAll(".pack-install").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Install the ${b.dataset.name} pack? It adds an AI agent, templates and auto-replies.`)) return;
    b.disabled = true; b.textContent = "Installing…";
    const r = await POST(`/api/starter-packs/${b.dataset.id}/install`);
    if (r?.ok) { toast(`✅ ${b.dataset.name} pack installed`, "success"); loadAgents(); loadTemplateCache(); }
    else toast(r?.error || "Failed", "error");
    b.disabled = false; b.textContent = "Install pack";
  }));
}

/* ============================================================
   AI MAGIC — smart replies + summarize
   ============================================================ */
$("suggestBtn").addEventListener("click", async () => {
  if (!activeJid) return;
  const pop = $("suggestPopover");
  pop.classList.remove("hidden");
  pop.innerHTML = `<div class="suggest-loading">✨ Thinking of replies…</div>`;
  const r = await POST("/api/ai/suggest", { jid: activeJid });
  if (r?.suggestions?.length) {
    pop.innerHTML = `<div class="suggest-head">Suggested replies — click to use</div>` +
      r.suggestions.map((s) => `<div class="suggest-item">${escHtml(s)}</div>`).join("");
    pop.querySelectorAll(".suggest-item").forEach((el) => el.addEventListener("click", () => {
      composerInput.value = el.textContent;
      composerInput.dispatchEvent(new Event("input"));
      pop.classList.add("hidden");
      composerInput.focus();
    }));
  } else {
    pop.innerHTML = `<div class="suggest-loading">${escHtml(r?.error || "No suggestions available")}</div>`;
    setTimeout(() => pop.classList.add("hidden"), 2500);
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#suggestPopover") && !e.target.closest("#suggestBtn")) $("suggestPopover").classList.add("hidden");
});

// Show the summary panel and return its content element (the × stays put).
function openSummary() {
  $("chatSummary").classList.remove("hidden");
  return $("chatSummaryContent");
}
$("chatSummaryClose").addEventListener("click", () => {
  $("chatSummary").classList.add("hidden");
  $("chatSummaryContent").innerHTML = "";
});

$("qaSummarize").addEventListener("click", async () => {
  if (!activeJid) return;
  const box = openSummary();
  box.innerHTML = `<div class="suggest-loading">✨ Summarizing…</div>`;
  const r = await POST("/api/ai/summarize", { jid: activeJid });
  box.innerHTML = r?.summary ? `<div class="chat-summary-body">${escHtml(r.summary).replace(/\n/g, "<br>")}</div>` : `<div class="suggest-loading">${escHtml(r?.error || "Couldn't summarize")}</div>`;
});

/* ============================================================
   LEARN BEHAVIOUR (per-chat) — gated to 100+ messages
   ============================================================ */
const LEARN_THRESHOLD = 100;
function updateLearnButton(count) {
  const btn = $("qaLearn");
  const label = $("qaLearnLabel");
  if (!btn || !label) return;
  if (count >= LEARN_THRESHOLD) {
    btn.disabled = false;
    btn.title = "Have the AI study this conversation's tone & style, and reply in kind.";
    label.textContent = "Learn behaviour";
  } else {
    btn.disabled = true;
    btn.title = `Available at ${LEARN_THRESHOLD} messages in this chat.`;
    label.textContent = `Learn behaviour (${count}/${LEARN_THRESHOLD})`;
  }
}

$("qaLearn").addEventListener("click", async () => {
  if (!activeJid) return;
  const box = openSummary();
  box.innerHTML = `<div class="suggest-loading">🧠 Studying this conversation…</div>`;
  const r = await POST(`/api/chats/${encodeURIComponent(activeJid)}/learn`, {});
  if (r?.error) {
    box.innerHTML = `<div class="suggest-loading">${escHtml(r.error)}</div>`;
    return;
  }
  const summary = r?.summary ? `<div class="chat-summary-body"><strong>Summary</strong><br>${escHtml(r.summary).replace(/\n/g, "<br>")}</div>` : "";
  const style = r?.style ? `<div class="chat-summary-body" style="margin-top:10px"><strong>Detected style</strong><br>${escHtml(r.style).replace(/\n/g, "<br>")}</div>` : "";
  box.innerHTML = (summary + style) || `<div class="suggest-loading">Couldn't learn from this chat</div>`;
  toast("Behaviour learned — AI will reply in this chat's style", "success");
});

/* ============================================================
   FEED CHAT HISTORY (import WhatsApp export .txt)
   ============================================================ */
$("qaFeedHistory").addEventListener("click", () => {
  if (!activeJid) return toast("Open a chat first", "error");
  $("feedHistoryFile").value = "";
  $("feedOwnerName").value = "";
  $("feedHistoryResult").classList.add("hidden");
  $("feedHistoryResult").innerHTML = "";
  $("feedHistoryModal").classList.remove("hidden");
});
const closeFeedHistory = () => $("feedHistoryModal").classList.add("hidden");
$("feedHistoryClose").addEventListener("click", closeFeedHistory);
$("feedHistoryCancel").addEventListener("click", closeFeedHistory);

$("feedHistorySubmit").addEventListener("click", async () => {
  if (!activeJid) return;
  const file = $("feedHistoryFile").files[0];
  if (!file) return toast("Pick the .txt file from your WhatsApp export", "error");
  const res = $("feedHistoryResult");
  res.classList.remove("hidden");
  res.innerHTML = `<div class="suggest-loading">📥 Reading the history & learning…</div>`;
  const fd = new FormData();
  fd.append("file", file);
  if ($("feedOwnerName").value.trim()) fd.append("ownerName", $("feedOwnerName").value.trim());
  let r;
  try { r = await POSTFORM(`/api/chats/${encodeURIComponent(activeJid)}/import-history`, fd); }
  catch { r = { error: "Upload failed, try again" }; }
  if (r?.error) {
    res.innerHTML = `<div class="suggest-loading">${escHtml(r.error)}</div>`;
    return;
  }
  const summary = r?.summary ? `<div class="chat-summary-body"><strong>Summary</strong><br>${escHtml(r.summary).replace(/\n/g, "<br>")}</div>` : "";
  const style = r?.style ? `<div class="chat-summary-body" style="margin-top:10px"><strong>Detected style</strong><br>${escHtml(r.style).replace(/\n/g, "<br>")}</div>` : "";
  res.innerHTML = `<div class="chat-summary-body" style="color:var(--brand-600)">✓ Learned from ${r.imported || 0} past messages.</div>` + summary + style;
  toast("History fed — AI now knows this conversation's past", "success");
});

/* ============================================================
   PAYMENTS (in-chat)
   ============================================================ */
$("qaPayment").addEventListener("click", () => openPaymentModal(activeJid));
$("payClose").addEventListener("click", () => $("payModal").classList.add("hidden"));
$("payCancel").addEventListener("click", () => $("payModal").classList.add("hidden"));
async function openPaymentModal(jid) {
  if (!jid) return toast("Open a chat first", "error");
  $("payJid").value = jid;
  $("payDesc").value = ""; $("payAmount").value = "";
  const s = await GET("/api/payments/settings");
  $("payStripeNote").textContent = s?.stripe_set ? "Powered by your Stripe account." : "Demo mode — connect Stripe in Integrations to take real payments.";
  $("payModal").classList.remove("hidden");
}
$("paySend").addEventListener("click", async () => {
  const amount = parseFloat($("payAmount").value);
  if (!amount) return toast("Enter an amount", "error");
  const r = await POST("/api/payments/request", {
    jid: $("payJid").value, amount, currency: $("payCurrency").value, description: $("payDesc").value.trim() || "Payment request",
  });
  if (r?.ok) { $("payModal").classList.add("hidden"); toast(`💳 Payment link sent (${r.provider})`, "success"); }
  else toast(r?.error || "Failed", "error");
});

/* ============================================================
   ROI REPORT (branded, printable)
   ============================================================ */
$("reportBtn").addEventListener("click", async () => {
  const d = await GET("/api/report");
  if (!d) return;
  const b = d.branding || {};
  const accent = `oklch(0.50 0.14 ${b.hue ?? 158})`;
  const money = (v) => "$" + (Number(v) || 0).toLocaleString();
  const lc = d.lifecycle || {};
  const w = window.open("", "_blank");
  w.document.write(`<!DOCTYPE html><html><head><title>Report — ${escHtml(d.org || b.app_name)}</title>
    <style>
      *{box-sizing:border-box;margin:0;font-family:Inter,-apple-system,sans-serif}
      body{padding:48px;color:#1a2520;max-width:820px;margin:auto}
      .hd{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid ${accent};padding-bottom:18px;margin-bottom:30px}
      .logo{font-size:22px;font-weight:800;color:${accent}}
      .meta{text-align:right;font-size:12px;color:#667}
      h1{font-size:26px;margin-bottom:6px}.sub{color:#667;margin-bottom:28px}
      .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:28px}
      .kpi{border:1px solid #e3e8e6;border-radius:12px;padding:18px}
      .kpi .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#889}
      .kpi .val{font-size:26px;font-weight:800;margin-top:6px;color:#1a2520}
      .sec{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#889;margin:24px 0 12px}
      .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef2f0;font-size:14px}
      .ft{margin-top:36px;font-size:11px;color:#aab;text-align:center}
      @media print{body{padding:24px}}
    </style></head><body>
    <div class="hd"><div class="logo">${b.logo ? `<img src="${b.logo}" style="height:34px">` : escHtml(b.app_name || "Zaply")}</div>
      <div class="meta">${escHtml(d.org || "")}<br>${new Date(d.generatedAt).toLocaleDateString()}</div></div>
    <h1>Performance Report</h1><div class="sub">${escHtml(d.period)}</div>
    <div class="kpis">
      <div class="kpi"><div class="lbl">Messages handled</div><div class="val">${(d.inbound + d.outbound).toLocaleString()}</div></div>
      <div class="kpi"><div class="lbl">AI automation</div><div class="val">${d.aiPct}%</div></div>
      <div class="kpi"><div class="lbl">Hours saved</div><div class="val">${d.hoursSaved}</div></div>
      <div class="kpi"><div class="lbl">Conversations</div><div class="val">${d.totalChats.toLocaleString()}</div></div>
      <div class="kpi"><div class="lbl">Open pipeline</div><div class="val">${money(d.pipeline.openValue)}</div></div>
      <div class="kpi"><div class="lbl">Revenue won</div><div class="val">${money(d.pipeline.wonValue)}</div></div>
    </div>
    <div class="sec">Message activity (30 days)</div>
    <div class="row"><span>Received from customers</span><b>${d.inbound.toLocaleString()}</b></div>
    <div class="row"><span>Sent</span><b>${d.outbound.toLocaleString()}</b></div>
    <div class="row"><span>Automated by AI</span><b>${d.automated.toLocaleString()}</b></div>
    <div class="sec">Sales funnel</div>
    ${["new_lead","hot_lead","payment","customer","closed_won"].map((k,i)=>`<div class="row"><span>${["New Lead","Hot Lead","Payment","Customer","Closed-Won"][i]}</span><b>${lc[k]||0}</b></div>`).join("")}
    <div class="ft">Generated by ${escHtml(b.app_name || "Zaply")} · ${new Date(d.generatedAt).toLocaleString()}</div>
    <script>setTimeout(()=>window.print(),400)<\/script>
    </body></html>`);
  w.document.close();
});

/* ============================================================
   BOOKINGS
   ============================================================ */
async function loadBookings() {
  const appts = await GET("/api/appointments") || [];
  const now = Date.now();
  const list = $("bookingsList");
  if (!appts.length) { list.innerHTML = `<div class="empty">No bookings yet. Click “+ New booking” to add one.</div>`; return; }
  list.innerHTML = appts.map((a) => {
    const dt = new Date(a.start_ts);
    const past = a.start_ts < now;
    return `<div class="booking-card${past ? " past" : ""}" data-id="${a.id}">
      <div class="booking-date"><span class="bk-day">${dt.toLocaleDateString("en-US", { day: "numeric" })}</span><span class="bk-mon">${dt.toLocaleDateString("en-US", { month: "short" })}</span></div>
      <div class="booking-body">
        <div class="booking-title">${escHtml(a.title)}</div>
        <div class="booking-meta">${escHtml(a.contact_name || "—")} · ${dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} · ${a.duration}min</div>
      </div>
      <button class="ghost-btn booking-edit" data-id="${a.id}">Edit</button>
    </div>`;
  }).join("");
  list.querySelectorAll(".booking-edit").forEach((b) => b.addEventListener("click", () => openApptModal(appts.find((a) => a.id == b.dataset.id))));
}

$("apptAddBtn").addEventListener("click", () => openApptModal(null));
$("apptClose").addEventListener("click", () => $("apptModal").classList.add("hidden"));
$("apptCancel").addEventListener("click", () => $("apptModal").classList.add("hidden"));
$("qaBooking").addEventListener("click", () => {
  const chat = allChats.find((c) => c.jid === activeJid);
  openApptModal(null, { jid: activeJid, name: chat?.name, phone: activeJid ? activeJid.replace(/@s\.whatsapp\.net$/, "") : "" });
});

function openApptModal(a, preset) {
  $("apptTitle").textContent = a ? "Edit booking" : "New booking";
  $("apptId").value = a?.id || "";
  $("apptName").value = a?.title || "";
  $("apptContact").value = a?.contact_name || preset?.name || "";
  $("apptPhone").value = a?.jid ? a.jid.replace(/@s\.whatsapp\.net$/, "") : (preset?.phone ? (preset.phone.startsWith("+") ? preset.phone : "+" + preset.phone) : "");
  const dt = a?.start_ts ? new Date(a.start_ts) : new Date(Date.now() + 86400000);
  $("apptWhen").value = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("apptDuration").value = a?.duration || 30;
  $("apptNotes").value = a?.notes || "";
  $("apptModal").dataset.jid = a?.jid || preset?.jid || "";
  $("apptDelete").classList.toggle("hidden", !a);
  $("apptDelete").onclick = a ? async () => { if (confirm("Delete this booking?")) { await DELETE(`/api/appointments/${a.id}`); $("apptModal").classList.add("hidden"); loadBookings(); } } : null;
  $("apptModal").classList.remove("hidden");
}

$("apptSave").addEventListener("click", async () => {
  const id = $("apptId").value;
  const title = $("apptName").value.trim();
  const when = $("apptWhen").value;
  if (!title || !when) return toast("Title and date/time required", "error");
  const phone = $("apptPhone").value.trim().replace(/[^0-9]/g, "");
  // Prefer the exact chat JID (so the confirmation lands in the SAME conversation,
  // not a new one). Only fall back to building a phone JID for standalone bookings.
  const chatJid = $("apptModal").dataset.jid || "";
  const body = {
    title, contact_name: $("apptContact").value.trim(),
    start_ts: new Date(when).getTime(), duration: parseInt($("apptDuration").value, 10) || 30,
    notes: $("apptNotes").value.trim(),
    jid: chatJid || (phone ? `${phone}@s.whatsapp.net` : null),
    send_confirmation: $("apptConfirm").checked,
  };
  const r = id ? await PUT(`/api/appointments/${id}`, { ...body, status: "confirmed" }) : await POST("/api/appointments", body);
  if (r?.ok) { $("apptModal").classList.add("hidden"); loadBookings(); toast(id ? "Booking updated" : "Booking saved", "success"); }
  else toast(r?.error || "Failed", "error");
});

/* ============================================================
   LEAD TOOLS (click-to-WhatsApp)
   ============================================================ */
let leadNumber = "";
async function loadLeads() {
  const info = await GET("/api/lead/number");
  leadNumber = (info?.number || "").replace(/[^0-9]/g, "");
  const note = $("leadNumberNote");
  if (!leadNumber) { note.style.display = ""; note.innerHTML = "Connect your WhatsApp first — your links point to your connected number."; }
  else { note.style.display = ""; note.innerHTML = `Links point to your number <strong>+${escHtml(leadNumber)}</strong>.`; }
  $("leadOutput").classList.add("hidden");
  loadLeadSources();
}

async function loadLeadSources() {
  const sources = await GET("/api/lead/sources") || [];
  $("leadSourceList").innerHTML = sources.length ? sources.map((s) => `
    <div class="lead-src" data-id="${s.id}">
      <div><div class="lead-src-name">${escHtml(s.name)}</div><div class="lead-src-meta">${s.leads} lead${s.leads !== 1 ? "s" : ""} · ref ${escHtml(s.ref)}</div></div>
      <div>
        <button class="ghost-btn lead-show" data-name="${escHtml(s.name)}" data-ref="${escHtml(s.ref)}" data-prefill="${escHtml(s.prefill || "")}">Link</button>
        <button class="ghost-btn lead-del" data-id="${s.id}">×</button>
      </div>
    </div>`).join("") : `<div class="empty">No tracked sources yet.</div>`;
  $("leadSourceList").querySelectorAll(".lead-del").forEach((b) => b.addEventListener("click", async () => { await DELETE(`/api/lead/sources/${b.dataset.id}`); loadLeadSources(); }));
  $("leadSourceList").querySelectorAll(".lead-show").forEach((b) => b.addEventListener("click", () => showLeadOutput(b.dataset.name, b.dataset.ref, b.dataset.prefill)));
}

$("leadCreate").addEventListener("click", async () => {
  const name = $("leadName").value.trim();
  if (!name) return toast("Give the source a name", "error");
  const prefill = $("leadPrefill").value.trim();
  const r = await POST("/api/lead/sources", { name, prefill });
  if (r?.ok) {
    $("leadName").value = ""; $("leadPrefill").value = "";
    loadLeadSources();
    showLeadOutput(name, r.ref, prefill);
  } else toast(r?.error || "Failed", "error");
});

async function showLeadOutput(name, ref, prefill) {
  if (!leadNumber) return toast("Connect WhatsApp first", "error");
  const text = `${prefill || "Hi! I'm interested"} (ref: ${ref})`;
  const link = `https://wa.me/${leadNumber}?text=${encodeURIComponent(text)}`;
  const widget = `<a href="${link}" target="_blank" style="display:inline-flex;align-items:center;gap:8px;background:#25D366;color:#fff;padding:12px 20px;border-radius:999px;font-family:sans-serif;font-weight:600;text-decoration:none">💬 Chat on WhatsApp</a>`;
  const out = $("leadOutput");
  out.classList.remove("hidden");
  out.innerHTML = `
    <div class="lead-out-title">${escHtml(name)} — your lead link</div>
    <div class="lead-out-row"><input readonly value="${escHtml(link)}" id="leadLinkInput"/><button class="ghost-btn" id="leadCopyLink">Copy</button></div>
    <div class="lead-out-qr"><img id="leadQrImg" alt="QR"/><div class="lead-out-qr-cap">Print this QR on flyers, packaging, or a storefront.</div></div>
    <div class="lead-out-title" style="margin-top:14px">Website button — paste into your site</div>
    <textarea class="lead-widget" readonly rows="3">${widget.replace(/</g, "&lt;")}</textarea>`;
  const r = await GET(`/api/lead/qr?text=${encodeURIComponent(link)}`);
  if (r?.dataUrl) $("leadQrImg").src = r.dataUrl;
  $("leadCopyLink").addEventListener("click", () => { navigator.clipboard?.writeText(link); toast("Link copied", "success"); });
}

/* ============================================================
   GUIDE / TOUR (unchanged)
   ============================================================ */
const TOUR_STEPS = [
  { title: "Welcome to Zaply 🎉", text: "Your WhatsApp AI inbox is ready. This quick tour shows you the key features.", art: `<svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="36" fill="oklch(0.95 0.03 158)"/><text x="40" y="52" text-anchor="middle" font-size="32">📱</text></svg>` },
  { title: "Connect WhatsApp", text: "Click 'Disconnect WhatsApp' is only needed to switch numbers. Your connection persists across restarts.", art: `<svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="36" fill="oklch(0.95 0.04 240)"/><text x="40" y="52" text-anchor="middle" font-size="32">🔗</text></svg>` },
  { title: "AI Agents", text: "Create named agents with their own instructions, playbook, OpenAI API key, and knowledge sources. Assign them per chat.", art: `<svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="36" fill="oklch(0.95 0.04 60)"/><text x="40" y="52" text-anchor="middle" font-size="32">🤖</text></svg>` },
  { title: "Templates", text: "Press / in any chat or click the template button to quickly insert saved message templates.", art: `<svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="36" fill="oklch(0.95 0.04 310)"/><text x="40" y="52" text-anchor="middle" font-size="32">📝</text></svg>` },
  { title: "AI Assist & Attachments", text: "In any chat: click AI Assist to improve your draft, attach files with the paperclip, and manage tags and notes in the sidebar.", art: `<svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="36" fill="oklch(0.95 0.04 158)"/><text x="40" y="52" text-anchor="middle" font-size="32">✨</text></svg>` },
];

let tourStep = 0;
function renderTour() {
  const step = TOUR_STEPS[tourStep];
  $("tourArt").innerHTML = step.art;
  $("tourTitle").textContent = step.title;
  $("tourText").textContent = step.text;
  $("tourDots").innerHTML = TOUR_STEPS.map((_, i) => `<i class="${i === tourStep ? "on" : ""}"></i>`).join("");
  $("tourNext").textContent = tourStep < TOUR_STEPS.length - 1 ? "Next" : "Get started";
}

$("guideBtn").addEventListener("click", () => { tourStep = 0; renderTour(); $("tour").classList.remove("hidden"); });
$("tourSkip").addEventListener("click", () => $("tour").classList.add("hidden"));
$("tourNext").addEventListener("click", () => {
  if (tourStep < TOUR_STEPS.length - 1) { tourStep++; renderTour(); }
  else $("tour").classList.add("hidden");
});

/* ============================================================
   UTILS
   ============================================================ */
function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function formatJid(jid) {
  return (jid || "").replace("@s.whatsapp.net", "").replace("@g.us", " (group)");
}
function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* ============================================================
   ORGANIZATIONS — switcher, create, team
   ============================================================ */
let myOrgs = [];
let myRole = "agent";

function applyMe(me) {
  if (!me?.tenant) return;
  const t = me.tenant;
  myOrgs = me.orgs || [];
  myRole = me.role || "agent";

  // Plan pill
  let label = t.plan_label;
  if (t.plan === "trial" && t.trial_ends) {
    const days = Math.max(0, Math.ceil((t.trial_ends - Date.now()) / 86400000));
    label += ` · ${days} day${days !== 1 ? "s" : ""} left`;
  }
  $("planPill").textContent = label;

  // Org switcher
  const name = t.business_name || "My Organization";
  $("orgCurrentName").textContent = name;
  $("orgCurrentRole").textContent = roleLabel(myRole);
  $("orgAvatar").textContent = (name.trim()[0] || "·").toUpperCase();
  $("orgAvatar").className = "org-avatar " + avatarClass(t.id);
  renderOrgList(t.id);

  // Hide owner/admin-only actions for agents
  const canManage = myRole === "owner" || myRole === "admin";
  $("orgTeamBtn").style.display = canManage ? "" : "none";
  if ($("navBranding")) $("navBranding").style.display = canManage ? "" : "none";

  // Super-admin link
  if ($("orgAdminBtn")) $("orgAdminBtn").style.display = me.user?.is_admin ? "" : "none";

  // White-label branding
  applyBranding(me.branding);
}

if ($("orgAdminBtn")) $("orgAdminBtn").addEventListener("click", () => { location.href = "/admin.html"; });

/* Apply white-label branding across the app */
function applyBranding(b) {
  if (!b) return;
  document.documentElement.style.setProperty("--brand-h", b.hue);
  const name = b.app_name || "Zaply";
  document.title = `${name} — WhatsApp Portal`;
  const brand = document.querySelector(".brand");
  if (brand) {
    brand.innerHTML = b.logo
      ? `<img src="${b.logo}" alt="${escHtml(name)}" class="brand-logo-img"/><span class="brand-name">${escHtml(name)}</span>`
      : `<span class="brand-mark"></span><span class="brand-name">${escHtml(name)}</span>`;
  }
}

function roleLabel(r) { return ({ owner: "Owner", admin: "Admin", agent: "Agent" })[r] || r; }

function renderOrgList(activeId) {
  $("orgList").innerHTML = myOrgs.map((o) => `
    <button class="org-item${o.id === activeId ? " active" : ""}" data-id="${o.id}">
      <span class="org-avatar sm ${avatarClass(o.id)}">${(o.name.trim()[0] || "·").toUpperCase()}</span>
      <span class="org-item-info">
        <span class="org-item-name">${escHtml(o.name)}</span>
        <span class="org-item-role">${roleLabel(o.role)} · ${o.plan_label}</span>
      </span>
      ${o.id === activeId ? `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 10l3.5 3.5L15 6"/></svg>` : ""}
    </button>`).join("");
  $("orgList").querySelectorAll(".org-item").forEach((b) => {
    b.addEventListener("click", () => { if (b.dataset.id !== activeId) switchOrg(b.dataset.id); });
  });
}

// Toggle menu
$("orgSwitchBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("orgMenu").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#orgSwitcher")) $("orgMenu").classList.add("hidden");
});

async function switchOrg(orgId) {
  const r = await POST("/api/orgs/switch", { orgId });
  if (r?.token) {
    localStorage.setItem("token", r.token);
    location.reload();
  } else toast(r?.error || "Couldn't switch organization", "error");
}

// Create organization
$("orgCreateBtn").addEventListener("click", () => {
  $("orgMenu").classList.add("hidden");
  $("orgCreateName").value = "";
  $("orgCreateModal").classList.remove("hidden");
  $("orgCreateName").focus();
});
$("orgCreateClose").addEventListener("click", () => $("orgCreateModal").classList.add("hidden"));
$("orgCreateCancel").addEventListener("click", () => $("orgCreateModal").classList.add("hidden"));
$("orgCreateSave").addEventListener("click", async () => {
  const name = $("orgCreateName").value.trim();
  if (!name) return toast("Organization name required", "error");
  const r = await POST("/api/orgs", { name });
  if (r?.token) {
    localStorage.setItem("token", r.token);
    toast("Organization created — connect its WhatsApp next", "success");
    location.reload();
  } else toast(r?.error || "Couldn't create organization", "error");
});

// Team management
$("orgTeamBtn").addEventListener("click", () => {
  $("orgMenu").classList.add("hidden");
  openTeamModal();
});
$("teamClose").addEventListener("click", () => $("teamModal").classList.add("hidden"));

async function openTeamModal() {
  $("teamOrgName").textContent = $("orgCurrentName").textContent;
  const canManage = myRole === "owner" || myRole === "admin";
  $("teamAddWrap").style.display = canManage ? "" : "none";
  $("teamModal").classList.remove("hidden");
  await loadTeam();
}

async function loadTeam() {
  const members = await GET("/api/orgs/members") || [];
  const canManage = myRole === "owner" || myRole === "admin";
  $("teamList").innerHTML = members.map((m) => `
    <div class="team-row">
      <span class="org-avatar sm ${avatarClass(m.id)}">${(m.email[0] || "?").toUpperCase()}</span>
      <span class="team-row-info">
        <span class="team-row-email">${escHtml(m.email)}</span>
        <span class="team-row-role role-${m.role}">${roleLabel(m.role)}</span>
      </span>
      ${canManage && m.role !== "owner" ? `<button class="team-rm" data-id="${m.id}" title="Remove">Remove</button>` : ""}
    </div>`).join("");
  $("teamList").querySelectorAll(".team-rm").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("Remove this member's access to this organization?")) return;
      const r = await DELETE(`/api/orgs/members/${b.dataset.id}`);
      if (r?.ok) loadTeam(); else toast(r?.error || "Couldn't remove", "error");
    });
  });
}

$("teamAddBtn").addEventListener("click", async () => {
  const email = $("teamEmail").value.trim();
  const password = $("teamPassword").value;
  const role = $("teamRole").value;
  if (!email) return toast("Email required", "error");
  const r = await POST("/api/orgs/members", { email, password, role });
  if (r?.ok) {
    $("teamEmail").value = ""; $("teamPassword").value = "";
    toast("Team member added", "success");
    loadTeam();
  } else toast(r?.error || "Couldn't add member", "error");
});

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  // Load account + org info
  const me = await GET("/api/me");
  applyMe(me);
  // Global AI "all chats" state (drives effective per-chat AI display)
  try { const s = await GET("/api/settings"); aiAllChats = s?.ai_all_chats === "1"; } catch {}
  updateAllChatsBar();

  // Load status
  const status = await GET("/api/status");
  renderStatus(status);

  // Load chats + templates
  await Promise.all([loadChats(), loadTemplateCache()]);

  // Auto-open chat from URL param e.g. /?chat=17162145420@s.whatsapp.net
  const params = new URLSearchParams(location.search);
  const urlChat = params.get("chat");
  if (urlChat) openChat(decodeURIComponent(urlChat));

  // Deep-link to a view e.g. /?view=analytics
  const urlView = params.get("view");
  if (urlView) {
    const navBtn = document.querySelector(`.nav-btn[data-view="${urlView}"]`);
    if (navBtn) navBtn.click();
  }
  // Deep-link to open the new-sequence dialog e.g. /?view=sequences&seq=new
  if (params.get("seq") === "new") setTimeout(() => openSequenceModal(null), 150);
  // Deep-links for org management e.g. /?org=team  or  /?org=new
  if (params.get("org") === "team") setTimeout(openTeamModal, 150);
  if (params.get("org") === "new") setTimeout(() => $("orgCreateModal").classList.remove("hidden"), 150);
  // Deep-link to open a client drawer e.g. /?client=<jid>
  const urlClient = params.get("client");
  if (urlClient) setTimeout(async () => { await loadPipeline(); openClientDrawer(decodeURIComponent(urlClient)); }, 200);

  // Show guide on first visit
  if (!localStorage.getItem("tour_done")) {
    tourStep = 0;
    renderTour();
    $("tour").classList.remove("hidden");
    localStorage.setItem("tour_done", "1");
  }
}

init();
