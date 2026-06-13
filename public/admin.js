/* InboxAI — Super-admin console */
"use strict";
const TOKEN = localStorage.getItem("token");
if (!TOKEN) location.href = "/login.html";
let ADMIN_TOKEN = sessionStorage.getItem("admin_token") || "";
const $ = (id) => document.getElementById(id);

async function api(method, path, body) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
  if (ADMIN_TOKEN) headers["x-admin-token"] = ADMIN_TOKEN;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    let j = {}; try { j = await res.json(); } catch {}
    if (j.code === "ADMIN_LOCKED") { ADMIN_TOKEN = ""; sessionStorage.removeItem("admin_token"); showLock(); return; }
    localStorage.removeItem("token"); location.href = "/login.html"; return;
  }
  if (res.status === 403) { location.href = "/app"; return; }
  return res.json();
}
const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const DELETE = (p) => api("DELETE", p);

function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast${type ? " " + type : ""}`;
  el.textContent = msg;
  $("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function money(n) { return "$" + (Number(n) || 0).toLocaleString(); }
function num(n) { return (Number(n) || 0).toLocaleString(); }
function date(ts) { return ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"; }
function fmtLimit(v) { return v === -1 || v == null || v > 1e9 ? "Unlimited" : num(v); }

/* nav */
function goSection(sec) {
  document.querySelectorAll("#adNav button").forEach((x) => x.classList.toggle("active", x.dataset.sec === sec));
  if (location.hash !== "#" + sec) history.replaceState(null, "", "#" + sec);
  render(sec);
}
document.querySelectorAll("#adNav button").forEach((b) => b.addEventListener("click", () => goSection(b.dataset.sec)));
window.addEventListener("hashchange", () => {
  const sec = (location.hash || "#overview").slice(1);
  if (["overview", "agencies", "users", "plans", "settings"].includes(sec)) goSection(sec);
});
$("adLogout").addEventListener("click", () => { localStorage.removeItem("token"); location.href = "/login.html"; });

/* sections */
async function render(sec) {
  const main = $("adMain");
  main.innerHTML = `<div class="ad-loading">Loading…</div>`;
  if (sec === "overview") return renderOverview(main);
  if (sec === "agencies") return renderAgencies(main);
  if (sec === "users") return renderUsers(main);
  if (sec === "plans") return renderPlans(main);
  if (sec === "settings") return renderSettings(main);
}

async function renderOverview(main) {
  const d = await GET("/api/admin/overview");
  if (!d) return;
  const planRows = Object.entries(d.byPlan || {});
  main.innerHTML = `
    <div class="ad-h">Overview</div>
    <div class="ad-sub">Everything happening across InboxAI right now.</div>
    <div class="ad-kpis">
      <div class="ad-kpi"><div class="ad-kpi-label">Agencies</div><div class="ad-kpi-val">${num(d.agencies)}</div></div>
      <div class="ad-kpi"><div class="ad-kpi-label">Users</div><div class="ad-kpi-val">${num(d.users)}</div></div>
      <div class="ad-kpi"><div class="ad-kpi-label">Live WhatsApp</div><div class="ad-kpi-val">${num(d.activeSessions)}</div></div>
      <div class="ad-kpi"><div class="ad-kpi-label">Est. MRR</div><div class="ad-kpi-val">${money(d.mrr)}</div></div>
    </div>
    <div class="ad-card">
      <div class="ad-card-title">Plan distribution</div>
      ${planRows.length ? planRows.map(([p, n]) => {
        const cfg = d.plans[p] || {};
        const pct = Math.round((n / d.agencies) * 100);
        return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:9px">
          <span style="width:90px;font-size:13px;font-weight:600">${esc(cfg.label || p)}</span>
          <div style="flex:1;background:var(--surface);border-radius:6px;height:22px;overflow:hidden"><div style="height:100%;width:${Math.max(pct,3)}%;background:var(--brand-500);border-radius:6px"></div></div>
          <span style="width:60px;text-align:right;font-weight:700;font-size:13px">${n}</span>
        </div>`;
      }).join("") : `<div class="ad-mono">No agencies yet.</div>`}
    </div>
    <div class="ad-card">
      <div class="ad-card-title">Recent sign-ups</div>
      <table class="ad-tbl"><thead><tr><th>Agency</th><th>Owner</th><th>Plan</th><th>Joined</th></tr></thead>
      <tbody>${(d.recent || []).map((r) => `<tr><td style="font-weight:600;color:var(--ink)">${esc(r.name || "Untitled")}</td><td class="ad-mono">${esc(r.owner)}</td><td><span class="ad-pill ${r.plan}">${esc(r.plan)}</span></td><td>${date(r.created)}</td></tr>`).join("") || `<tr><td colspan="4" class="ad-mono">No sign-ups yet.</td></tr>`}</tbody></table>
    </div>`;
}

async function renderAgencies(main) {
  const orgs = await GET("/api/admin/orgs") || [];
  const plans = await GET("/api/admin/plans") || {};
  const planKeys = Object.keys(plans);
  main.innerHTML = `
    <div class="ad-h">Agencies</div>
    <div class="ad-sub">${orgs.length} organization${orgs.length !== 1 ? "s" : ""}. Manage plans, suspend, impersonate, or remove.</div>
    <div class="ad-card" style="padding:0">
      <table class="ad-tbl">
        <thead><tr><th>Agency</th><th>Owner</th><th>Plan</th><th>Members</th><th>Messages</th><th>WhatsApp</th><th>Status</th><th></th></tr></thead>
        <tbody>${orgs.map((o) => `
          <tr data-id="${o.id}">
            <td style="font-weight:600;color:var(--ink)">${esc(o.name)}</td>
            <td class="ad-mono">${esc(o.owner)}</td>
            <td><select class="ad-plan-sel" data-id="${o.id}">${planKeys.map((p) => `<option value="${p}" ${p === o.plan ? "selected" : ""}>${esc(plans[p].label)}</option>`).join("")}</select></td>
            <td>${o.members}</td>
            <td>${num(o.messages)}</td>
            <td><span class="ad-dot ${o.connected ? "on" : "off"}"></span>${o.connected ? "Live" : "Off"}</td>
            <td><span class="ad-pill ${o.status === "suspended" ? "suspended" : "active"}">${o.status || "active"}</span></td>
            <td style="text-align:right">
              <button class="ad-btn ad-imp" data-id="${o.id}">Log in</button>
              <button class="ad-btn ad-susp" data-id="${o.id}" data-status="${o.status}">${o.status === "suspended" ? "Activate" : "Suspend"}</button>
              <button class="ad-btn danger ad-del" data-id="${o.id}" data-name="${esc(o.name)}">Delete</button>
            </td>
          </tr>`).join("")}</tbody>
      </table>
    </div>`;

  main.querySelectorAll(".ad-plan-sel").forEach((s) => s.addEventListener("change", async () => {
    const r = await POST(`/api/admin/orgs/${s.dataset.id}/plan`, { plan: s.value });
    toast(r?.ok ? "Plan updated" : (r?.error || "Failed"), r?.ok ? "success" : "error");
  }));
  main.querySelectorAll(".ad-susp").forEach((b) => b.addEventListener("click", async () => {
    const next = b.dataset.status === "suspended" ? "active" : "suspended";
    const r = await POST(`/api/admin/orgs/${b.dataset.id}/status`, { status: next });
    if (r?.ok) { toast(`Agency ${next === "suspended" ? "suspended" : "activated"}`, "success"); renderAgencies(main); }
  }));
  main.querySelectorAll(".ad-imp").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Log in as this agency's owner? You'll be taken into their account.")) return;
    const r = await POST(`/api/admin/orgs/${b.dataset.id}/impersonate`);
    if (r?.token) { localStorage.setItem("token", r.token); location.href = "/app"; }
    else toast(r?.error || "Couldn't impersonate", "error");
  }));
  main.querySelectorAll(".ad-del").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Delete "${b.dataset.name}" permanently? This removes the organization.`)) return;
    const r = await DELETE(`/api/admin/orgs/${b.dataset.id}`);
    if (r?.ok) { toast("Agency deleted", "success"); renderAgencies(main); }
  }));
}

async function renderUsers(main) {
  const users = await GET("/api/admin/users") || [];
  main.innerHTML = `
    <div class="ad-h">Users</div>
    <div class="ad-sub">${users.length} login${users.length !== 1 ? "s" : ""} across all agencies.</div>
    <div class="ad-card" style="padding:0">
      <table class="ad-tbl">
        <thead><tr><th>Email</th><th>Name</th><th>Organizations</th><th>Joined</th><th>Admin</th></tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            <td style="font-weight:600;color:var(--ink)">${esc(u.email)}</td>
            <td>${esc(u.name || "—")}</td>
            <td>${u.orgs}</td>
            <td>${date(u.created)}</td>
            <td><label class="ad-toggle"><input type="checkbox" class="ad-admin-tog" data-id="${u.id}" ${u.is_admin ? "checked" : ""}/> ${u.is_admin ? "Admin" : "—"}</label></td>
          </tr>`).join("")}</tbody>
      </table>
    </div>`;
  main.querySelectorAll(".ad-admin-tog").forEach((c) => c.addEventListener("change", async () => {
    const r = await POST(`/api/admin/users/${c.dataset.id}/admin`, { is_admin: c.checked });
    if (r?.ok) { toast(c.checked ? "Granted admin" : "Revoked admin", "success"); renderUsers(main); }
    else { toast(r?.error || "Failed", "error"); c.checked = !c.checked; }
  }));
}

async function renderPlans(main) {
  const plans = await GET("/api/admin/plans") || {};
  const order = ["trial", "starter", "pro", "agency"];
  main.innerHTML = `
    <div class="ad-h">Plans &amp; Tiers</div>
    <div class="ad-sub">Set the price and monthly conversation limit for each tier. Applies to every agency instantly.</div>
    <div class="ad-card">
      <div class="ad-plan-grid">${order.filter((k) => plans[k]).map((k) => {
        const p = plans[k];
        const unlimited = p.convPerMonth === -1 || p.convPerMonth > 1e9;
        return `<div class="ad-plan" data-key="${k}">
          <h4>${esc(p.label)}</h4>
          <div class="ad-field"><label>Display name</label><input class="pl-label" value="${esc(p.label)}"/></div>
          <div class="ad-field"><label>Price (USD / month)</label><input class="pl-price" type="number" value="${p.price || 0}"/></div>
          <div class="ad-field"><label>Conversations / month</label>
            <input class="pl-conv" type="number" value="${unlimited ? "" : p.convPerMonth}" placeholder="${unlimited ? "Unlimited" : ""}" ${unlimited ? "disabled" : ""}/>
            <label class="ad-toggle" style="margin-top:7px"><input type="checkbox" class="pl-unl" ${unlimited ? "checked" : ""}/> Unlimited</label>
          </div>
        </div>`;
      }).join("")}</div>
      <button class="ad-btn primary" id="plSave" style="margin-top:16px">Save plans</button>
    </div>`;

  main.querySelectorAll(".pl-unl").forEach((c) => c.addEventListener("change", () => {
    const conv = c.closest(".ad-plan").querySelector(".pl-conv");
    conv.disabled = c.checked; if (c.checked) conv.value = "";
  }));
  $("plSave").addEventListener("click", async () => {
    const out = {};
    main.querySelectorAll(".ad-plan").forEach((el) => {
      const unl = el.querySelector(".pl-unl").checked;
      out[el.dataset.key] = {
        label: el.querySelector(".pl-label").value.trim(),
        price: Number(el.querySelector(".pl-price").value) || 0,
        convPerMonth: unl ? "unlimited" : Number(el.querySelector(".pl-conv").value) || 0,
      };
    });
    const r = await POST("/api/admin/plans", { plans: out });
    toast(r?.ok ? "Plans saved" : (r?.error || "Failed"), r?.ok ? "success" : "error");
  });
}

async function renderSettings(main) {
  const s = await GET("/api/admin/settings") || {};
  main.innerHTML = `
    <div class="ad-h">Global Settings</div>
    <div class="ad-sub">Application-wide configuration — the keys and rules every agency inherits.</div>
    <div class="ad-card" style="max-width:560px">
      <div class="ad-card-title">AI provider keys</div>
      <p style="font-size:12.5px;color:var(--ink-3);margin-bottom:14px">Agencies that don't bring their own key use these. Stored securely; only a hint is shown.</p>
      <div class="ad-field">
        <label>Global OpenAI API key ${s.global_openai_key_set ? `<span class="ad-mono">(set: ${esc(s.global_openai_key_hint)})</span>` : ""}</label>
        <input id="setOpenAI" type="password" placeholder="sk-..." />
      </div>
      <div class="ad-field">
        <label>Global Anthropic API key ${s.global_anthropic_key_set ? `<span class="ad-mono">(set)</span>` : ""}</label>
        <input id="setAnthropic" type="password" placeholder="sk-ant-..." />
      </div>

      <div class="ad-card-title" style="margin-top:18px">Sign-ups &amp; trials</div>
      <div class="ad-field"><label>Default trial length (days)</label><input id="setTrial" type="number" value="${esc(s.default_trial_days)}" /></div>
      <label class="ad-toggle" style="margin:6px 0 16px"><input type="checkbox" id="setSignups" ${s.signups_enabled ? "checked" : ""}/> Allow new agency sign-ups</label>

      <button class="ad-btn primary" id="setSave">Save settings</button>
    </div>

    <div class="ad-card" style="max-width:560px">
      <div class="ad-card-title">🔒 Admin passcode</div>
      <p style="font-size:12.5px;color:var(--ink-3);margin-bottom:14px">Required to open this console, separate from your login. Choose 6+ characters.</p>
      <div class="ad-field"><label>Current passcode</label><input id="pcCurrent" type="password" placeholder="Current passcode" autocomplete="off" /></div>
      <div class="ad-field"><label>New passcode</label><input id="pcNew" type="password" placeholder="New passcode (6+ chars)" autocomplete="off" /></div>
      <button class="ad-btn primary" id="pcSave">Change passcode</button>
    </div>`;
  $("setSave").addEventListener("click", async () => {
    const body = {
      default_trial_days: $("setTrial").value,
      signups_enabled: $("setSignups").checked,
    };
    if ($("setOpenAI").value.trim()) body.global_openai_key = $("setOpenAI").value.trim();
    if ($("setAnthropic").value.trim()) body.global_anthropic_key = $("setAnthropic").value.trim();
    const r = await POST("/api/admin/settings", body);
    toast(r?.ok ? "Settings saved" : (r?.error || "Failed"), r?.ok ? "success" : "error");
    if (r?.ok) renderSettings(main);
  });
  $("pcSave").addEventListener("click", async () => {
    const r = await POST("/api/admin/passcode", {
      currentPasscode: $("pcCurrent").value,
      newPasscode: $("pcNew").value,
    });
    toast(r?.ok ? "Passcode changed" : (r?.error || "Failed"), r?.ok ? "success" : "error");
    if (r?.ok) { $("pcCurrent").value = ""; $("pcNew").value = ""; }
  });
}

/* ---------- Admin passcode gate ---------- */
let lockCreateMode = false;
function showLock() {
  $("admin").style.display = "none";
  $("adLock").style.display = "flex";
  $("adLockError").style.display = "none";
  $("adLockInput").value = "";
  $("adLockConfirm").value = "";
  $("adLockInput").focus();
}
function hideLock() {
  $("adLock").style.display = "none";
  $("admin").style.display = "flex";
}
function lockError(msg) {
  const e = $("adLockError");
  e.textContent = msg; e.style.display = "block";
}
async function doUnlock() {
  const passcode = $("adLockInput").value;
  if (!passcode) return lockError("Enter your passcode.");
  let body;
  if (lockCreateMode) {
    if (passcode.length < 6) return lockError("Passcode must be at least 6 characters.");
    if (passcode !== $("adLockConfirm").value) return lockError("Passcodes don't match.");
    body = { newPasscode: passcode };
  } else {
    body = { passcode };
  }
  // raw fetch (api() would loop on ADMIN_LOCKED)
  const res = await fetch("/api/admin/unlock", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (res.status === 403) { location.href = "/app"; return; }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.token) return lockError(j.error || "Could not unlock.");
  ADMIN_TOKEN = j.token;
  sessionStorage.setItem("admin_token", j.token);
  hideLock();
  startConsole();
}
$("adLockBtn").addEventListener("click", doUnlock);
$("adLockInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doUnlock(); });
$("adLockConfirm").addEventListener("keydown", (e) => { if (e.key === "Enter") doUnlock(); });
$("adLockLogout").addEventListener("click", () => { localStorage.removeItem("token"); sessionStorage.removeItem("admin_token"); location.href = "/login.html"; });

async function startConsole() {
  const me = await GET("/api/admin/me");
  if (!me?.admin) return; // showLock already handled by api() on ADMIN_LOCKED
  $("adWho").textContent = me.email;
  const sec = (location.hash || "#overview").slice(1);
  goSection(["overview", "agencies", "users", "plans", "settings"].includes(sec) ? sec : "overview");
}

/* boot */
(async function init() {
  // Confirm super-admin + learn whether a passcode exists yet
  const res = await fetch("/api/admin/lock-status", {
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  });
  if (res.status === 401) { localStorage.removeItem("token"); location.href = "/login.html"; return; }
  if (res.status === 403) { location.href = "/app"; return; }
  const { passcodeSet } = await res.json().catch(() => ({ passcodeSet: true }));
  lockCreateMode = !passcodeSet;
  $("adLockMsg").textContent = lockCreateMode
    ? "Set an admin passcode to protect this console. You'll enter it each session."
    : "Enter your admin passcode to continue.";
  $("adLockConfirm").style.display = lockCreateMode ? "block" : "none";
  $("adLockBtn").textContent = lockCreateMode ? "Set passcode & enter" : "Unlock";

  if (ADMIN_TOKEN && !lockCreateMode) {
    // try the cached session token; if stale, api() will surface the lock
    hideLock();
    startConsole();
  } else {
    showLock();
  }
})();
