import { q } from "./db.js";

/**
 * Flow definition format (stored as JSON in flows.definition):
 * {
 *   start: "n1",
 *   nodes: {
 *     n1: { type: "message", text: "Welcome!", next: "n2" },
 *     n2: { type: "question", text: "Reply 1 for prices, 2 for delivery",
 *           branches: [ { match: "1", next: "n3" }, { match: "2", next: "n4" } ],
 *           fallback: "n5" },                  // optional: where to go if no branch matches
 *     n3: { type: "message", text: "...", next: null },  // next: null = flow ends
 *     n4: { type: "handoff" },                 // flags chat for a human, flow ends
 *     n5: { type: "ai" },                      // enables the AI agent for this chat, flow ends
 *   }
 * }
 *
 * Node types: message | question | handoff | ai | end
 */

const MAX_HOPS = 25; // safety: no infinite loops
const STATE_TTL = 24 * 60 * 60 * 1000; // abandoned flows expire after 24h

/**
 * Main entry — called for every inbound customer message.
 * Returns true if a flow handled the message (pipeline should stop), false otherwise.
 * `send(text)` sends a message in the chat; `effects` lets the engine flag handoff/AI.
 */
export async function runFlows(tenantId, jid, text, send, effects = {}) {
  const lower = (text || "").toLowerCase().trim();

  // 1) Is this chat in the middle of a flow?
  const state = q.getFlowState.get(tenantId, jid);
  if (state && Date.now() - state.updated < STATE_TTL) {
    const flow = q.getFlow.get(state.flow_id, tenantId);
    if (flow && flow.active) {
      const def = safeParse(flow.definition);
      const node = def?.nodes?.[state.node_id];
      if (def && node && node.type === "question") {
        return await resumeAtQuestion(tenantId, jid, flow, def, node, lower, send, effects);
      }
    }
    q.clearFlowState.run(tenantId, jid); // stale or broken state
  } else if (state) {
    q.clearFlowState.run(tenantId, jid); // expired
  }

  // 2) Does this message trigger a flow?
  for (const flow of q.activeFlows.all(tenantId)) {
    const kw = (flow.trigger_keyword || "").toLowerCase().trim();
    if (kw && lower.includes(kw)) {
      const def = safeParse(flow.definition);
      if (def?.start && def.nodes?.[def.start]) {
        await walk(tenantId, jid, flow, def, def.start, send, effects);
        return true;
      }
    }
  }
  return false;
}

async function resumeAtQuestion(tenantId, jid, flow, def, node, lower, send, effects) {
  let nextId = null;
  for (const b of node.branches || []) {
    const m = (b.match || "").toLowerCase().trim();
    if (m && lower.includes(m)) {
      nextId = b.next;
      break;
    }
  }
  if (!nextId) nextId = node.fallback || null;

  if (!nextId) {
    // No match and no fallback: gently re-ask once, then release the chat
    q.clearFlowState.run(tenantId, jid);
    if (node.text) await send(node.text);
    return true;
  }
  await walk(tenantId, jid, flow, def, nextId, send, effects);
  return true;
}

/** Walk nodes from `nodeId` until we hit a question (pause) or a terminal. */
async function walk(tenantId, jid, flow, def, nodeId, send, effects) {
  let current = nodeId;
  for (let hops = 0; hops < MAX_HOPS && current; hops++) {
    const node = def.nodes[current];
    if (!node) break;

    switch (node.type) {
      case "message":
        if (node.text) await send(node.text);
        current = node.next || null;
        continue;

      case "question":
        if (node.text) await send(node.text);
        q.setFlowState.run(tenantId, jid, flow.id, current, Date.now());
        return; // pause — wait for the customer's reply

      case "handoff":
        if (node.text) await send(node.text);
        effects.handoff?.();
        current = null;
        continue;

      case "ai":
        effects.enableAi?.();
        current = null;
        continue;

      case "end":
      default:
        current = null;
    }
  }
  q.clearFlowState.run(tenantId, jid); // flow finished
}

/** Validate a flow definition before saving. Returns array of error strings. */
export function validateFlow(def) {
  const errors = [];
  if (!def || typeof def !== "object") return ["Definition must be an object"];
  if (!def.start || !def.nodes?.[def.start]) errors.push("Flow needs a valid start node");
  const ids = Object.keys(def.nodes || {});
  if (!ids.length) errors.push("Flow has no nodes");
  for (const id of ids) {
    const n = def.nodes[id];
    if (!["message", "question", "handoff", "ai", "end"].includes(n.type))
      errors.push(`Node ${id}: unknown type "${n.type}"`);
    if ((n.type === "message" || n.type === "question") && !n.text)
      errors.push(`Node ${id}: text is required`);
    if (n.next && !def.nodes[n.next]) errors.push(`Node ${id}: next points to missing node`);
    if (n.type === "question") {
      if (!Array.isArray(n.branches) || !n.branches.length)
        errors.push(`Node ${id}: question needs at least one branch`);
      for (const b of n.branches || []) {
        if (!b.match) errors.push(`Node ${id}: branch missing match text`);
        if (b.next && !def.nodes[b.next]) errors.push(`Node ${id}: branch points to missing node`);
      }
      if (n.fallback && !def.nodes[n.fallback])
        errors.push(`Node ${id}: fallback points to missing node`);
    }
  }
  return errors;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
