/* Automation scheduler — follow-up sequences + broadcast campaigns */
import { q } from "./db.js";
import { sendText, isConnected } from "./sessions.js";

const BROADCAST_BATCH_PER_TICK = 8;   // max messages per broadcast per minute (ban-safe)
const NO_REPLY_SCAN = true;

let broadcast = () => {};
export function onAutomationEvent(fn) { broadcast = fn; }

export function startAutomationScheduler() {
  setInterval(() => { tick().catch((e) => console.error("[automation]", e.message)); }, 60 * 1000);
  // first run shortly after boot
  setTimeout(() => tick().catch(() => {}), 8000);
  console.log("[automation] scheduler started");
}

async function tick() {
  await processSequences();
  await processBroadcasts();
  await processReminders();
}

/* Appointment reminders — send a nudge for bookings starting within the next hour. */
async function processReminders() {
  const now = Date.now();
  const due = q.dueReminders.all(now, now + 60 * 60 * 1000);
  for (const appt of due) {
    try {
      if (!appt.jid || !isConnected(appt.tenant_id)) { q.markReminded.run(appt.id); continue; }
      const when = new Date(appt.start_ts).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
      await sendText(appt.tenant_id, appt.jid, `⏰ Reminder: your appointment "${appt.title}" is coming up at ${when} today. See you soon!`, "sequence");
      q.markReminded.run(appt.id);
    } catch (err) { console.error("[reminder]", err.message); q.markReminded.run(appt.id); }
  }
}

/* ────────────────────────────────────────────────
   Substitute {{name}} / {{first_name}} in message bodies
   ──────────────────────────────────────────────── */
function personalize(body, chat) {
  const name = chat?.name || "";
  const first = name.split(" ")[0] || "there";
  return String(body || "")
    .replace(/\{\{\s*name\s*\}\}/gi, name || "there")
    .replace(/\{\{\s*first_name\s*\}\}/gi, first);
}

/* ────────────────────────────────────────────────
   FOLLOW-UP SEQUENCES
   ──────────────────────────────────────────────── */
export function enrollInSequence(tenantId, sequenceId, jid) {
  const seq = q.getSequence.get(sequenceId, tenantId);
  if (!seq || !seq.active) return false;
  const steps = q.listSequenceSteps.all(sequenceId);
  if (!steps.length) return false;
  if (q.isEnrolled.get(tenantId, sequenceId, jid)) return false; // already enrolled
  const firstDelay = (steps[0].delay_minutes || 0) * 60 * 1000;
  q.enrollContact.run(tenantId, sequenceId, jid, Date.now() + firstDelay, Date.now());
  return true;
}

/** Fired when a chat's lifecycle changes — auto-enroll into matching sequences. */
export function onLifecycleChange(tenantId, jid, stage) {
  const seqs = q.activeSequencesByTrigger.all(tenantId, "lifecycle");
  for (const s of seqs) {
    if (s.trigger_value === stage) enrollInSequence(tenantId, s.id, jid);
  }
}

/** Fired when the customer replies — cancel any active drip so we don't nag them. */
export function onCustomerReply(tenantId, jid) {
  q.stopEnrollmentsForChat.run(tenantId, jid);
}

async function processSequences() {
  const due = q.dueEnrollments.all(Date.now());
  for (const en of due) {
    try {
      if (!isConnected(en.tenant_id)) continue; // wait until WA connected
      const steps = q.listSequenceSteps.all(en.sequence_id);
      const step = steps[en.current_step];
      if (!step) { q.advanceEnrollment.run(en.current_step, en.next_run_ts, "done", en.id); continue; }

      const chat = q.getChat.get(en.tenant_id, en.jid);
      await sendText(en.tenant_id, en.jid, personalize(step.body, chat), "sequence");

      const nextIdx = en.current_step + 1;
      const nextStep = steps[nextIdx];
      if (nextStep) {
        const nextTs = Date.now() + (nextStep.delay_minutes || 0) * 60 * 1000;
        q.advanceEnrollment.run(nextIdx, nextTs, "active", en.id);
      } else {
        q.advanceEnrollment.run(nextIdx, Date.now(), "done", en.id);
      }
    } catch (err) {
      console.error(`[sequence:${en.tenant_id}]`, err.message);
      // back off 30 min on failure
      q.advanceEnrollment.run(en.current_step, Date.now() + 30 * 60 * 1000, "active", en.id);
    }
  }

  if (NO_REPLY_SCAN) await scanNoReply();
}

/** Enroll chats that have gone quiet into 'no_reply' sequences. */
async function scanNoReply() {
  // Group sequences by tenant
  const tenants = q.listActiveTenants.all();
  for (const { id: tenantId } of tenants) {
    const seqs = q.activeSequencesByTrigger.all(tenantId, "no_reply");
    if (!seqs.length) continue;
    for (const s of seqs) {
      const hours = parseInt(s.trigger_value || "24", 10);
      const cutoff = Date.now() - hours * 3600 * 1000;
      // chats whose last activity is older than cutoff (quiet) — limited window to avoid mass-enroll on old data
      const windowStart = cutoff - 7 * 24 * 3600 * 1000;
      const chats = q.chatsAll.all(tenantId);
      for (const c of chats) {
        const chat = q.getChat.get(tenantId, c.jid);
        if (!chat) continue;
        if (chat.last_ts && chat.last_ts < cutoff && chat.last_ts > windowStart) {
          if (!q.isEnrolled.get(tenantId, s.id, c.jid)) enrollInSequence(tenantId, s.id, c.jid);
        }
      }
    }
  }
}

/* ────────────────────────────────────────────────
   BROADCAST CAMPAIGNS
   ──────────────────────────────────────────────── */
async function processBroadcasts() {
  const sending = q.sendingBroadcasts.all();
  for (const b of sending) {
    if (!isConnected(b.tenant_id)) continue;
    const recips = q.pendingRecipients.all(b.id, BROADCAST_BATCH_PER_TICK);
    if (!recips.length) {
      q.setBroadcastStatus.run("done", b.id, b.tenant_id);
      broadcast(b.tenant_id, { type: "broadcast_done", data: { id: b.id, name: b.name } });
      continue;
    }
    for (const r of recips) {
      try {
        const chat = q.getChat.get(b.tenant_id, r.jid);
        await sendText(b.tenant_id, r.jid, personalize(b.body, chat || { name: r.name }), "broadcast");
        q.markRecipientSent.run(Date.now(), r.id);
        q.incBroadcastSent.run(b.id);
        // small jitter between sends within the batch
        await sleep(800 + Math.random() * 1800);
      } catch (err) {
        console.error(`[broadcast:${b.tenant_id}]`, err.message);
        q.markRecipientFailed.run(Date.now(), r.id);
        q.incBroadcastFailed.run(b.id);
      }
    }
    broadcast(b.tenant_id, { type: "broadcast_progress", data: { id: b.id } });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
