import { q, getSetting } from "./db.js";

/**
 * Generate an AI reply for a tenant's chat.
 * Uses per-chat agent if set, otherwise falls back to global settings.
 */
export async function generateReply(tenantId, jid) {
  // Per-chat hourly cap is only an anti-runaway backstop now (no plans/limits).
  // Effectively unlimited by default; override with AI_MAX_REPLIES_PER_HOUR.
  const maxPerHour = parseInt(process.env.AI_MAX_REPLIES_PER_HOUR || "1000", 10);
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const { n } = q.countRecentAiReplies.get(tenantId, jid, oneHourAgo);
  if (n >= maxPerHour) return null;

  const recent = q.recentMessages.all(tenantId, jid, 20).reverse();
  if (recent.length === 0) return null;

  const lastCustomerMsg = [...recent].reverse().find((m) => !m.from_me);
  if (!lastCustomerMsg) return null;

  // Check for handoff keywords
  const handoffKw = (getSetting(tenantId, "ai_handoff_keywords") || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const lower = lastCustomerMsg.body.toLowerCase();
  if (handoffKw.some((k) => k && lower.includes(k))) return null;

  // AI replies are powered ONLY by AI Agents. If the tenant has no active
  // agent, Zaply does not auto-reply (no generic global fallback).
  const chat = q.getChat.get(tenantId, jid);
  const agent = resolveAgent(tenantId, chat);
  if (!agent) return null;

  const systemPrompt = buildSystemPrompt(tenantId, agent, chat);
  const turns = buildTurns(recent);
  if (!turns.length) return null;

  const { apiKey, model, provider } = resolveProviderConfig(tenantId, agent);

  if (!apiKey) { const e = new Error("No AI API key configured"); e.aiProviderError = true; throw e; }
  try {
    if (provider === "openai") return await callOpenAI(systemPrompt, turns, apiKey, model);
    return await callAnthropic(systemPrompt, turns);
  } catch (err) {
    console.error(`[ai:${tenantId}] reply failed:`, err.message);
    // Surface provider errors (e.g. invalid OpenAI key) instead of failing silently.
    const e = new Error(err.message); e.aiProviderError = true; throw e;
  }
}

/**
 * Improve / rewrite a drafted message.
 */
export async function improveMessage(tenantId, draft, jid) {
  const chat = jid ? q.getChat.get(tenantId, jid) : null;
  const agent = resolveAgent(tenantId, chat);
  const { apiKey, model, provider } = resolveProviderConfig(tenantId, agent);

  const system = "You are a professional WhatsApp business communication assistant. Rewrite the given draft message to be clearer, more professional, and friendly — while preserving the original intent and keeping it concise (2-3 lines max). Return ONLY the improved message, no explanations.";
  const turns = [{ role: "user", content: `Improve this message:\n\n${draft}` }];

  try {
    if (provider === "openai") return await callOpenAI(system, turns, apiKey, model);
    return await callAnthropic(system, turns);
  } catch (err) {
    console.error(`[ai-improve:${tenantId}]`, err.message);
    return null;
  }
}

/**
 * Help the user author an AI agent. Given the field being written
 * (instructions | playbook | rules), the user's rough draft (a few words or
 * lines), and the agent's name/business context, produce a polished version
 * of just that field. Returns a string (or null on provider error).
 */
export async function draftAgentField(tenantId, { field, draft = "", agentName = "" } = {}) {
  const { apiKey, model, provider } = resolveProviderConfig(tenantId, null);
  if (!apiKey) { const e = new Error("No AI API key configured"); e.aiProviderError = true; throw e; }

  const specs = {
    instructions: "the agent's INSTRUCTIONS — a clear paragraph describing the agent's role, who it serves, its communication style/tone, and its goals. Write 3-6 sentences in second person ('You are…').",
    playbook: "the agent's PLAYBOOK — a numbered, step-by-step conversation guide the agent follows from greeting to close or human handoff. Output 5-8 concise numbered steps.",
    rules: "the agent's ADDITIONAL RULES — hard constraints the agent must always follow. Output 4-7 concise bullet points starting with '- '.",
    style: "the agent's WRITING STYLE — a short guide for how this agent should sound: tone (warm/formal/casual), formality, emoji & punctuation habits, sentence length, greeting/sign-off, language. Write it as direct instructions, e.g. 'Keep replies short and upbeat. Use one emoji max...'. Max ~120 words.",
  };
  const spec = specs[field] || specs.instructions;
  const ctx = agentName ? ` The agent is named "${agentName}".` : "";
  const basis = draft.trim()
    ? `Expand and polish the user's rough notes into ${spec}${ctx}\n\nUser's notes:\n${draft.trim()}`
    : `Write ${spec}${ctx} Use sensible, professional defaults for a WhatsApp business assistant.`;
  const system = "You help business owners configure an AI WhatsApp agent. You write ONLY the requested section — no preamble, no headings, no explanations, no markdown code fences. Keep it practical and ready to paste directly into the field.";
  const turns = [{ role: "user", content: basis }];
  try {
    if (provider === "openai") return await callOpenAI(system, turns, apiKey, model);
    return await callAnthropic(system, turns);
  } catch (err) {
    console.error(`[ai-draft-field:${tenantId}]`, err.message);
    const e = new Error("AI couldn't write this — check your API key."); e.aiProviderError = true; throw e;
  }
}

/** Suggest 3 short reply options for the current conversation. Returns string[]. */
export async function suggestReplies(tenantId, jid) {
  const recent = q.recentMessages.all(tenantId, jid, 12).reverse();
  if (!recent.length) return [];
  const agent = resolveAgent(tenantId, q.getChat.get(tenantId, jid));
  const { apiKey, model, provider } = resolveProviderConfig(tenantId, agent);
  const convo = recent.map((m) => `${m.from_me ? "Me" : "Customer"}: ${m.body}`).join("\n");
  const system = "You are helping a business owner reply on WhatsApp. Given the conversation, propose exactly 3 short, distinct reply options the owner could send next. Each under 220 characters, friendly and professional. Return ONLY a JSON array of 3 strings, nothing else.";
  const turns = [{ role: "user", content: `Conversation:\n${convo}\n\nReturn 3 reply options as a JSON array.` }];
  try {
    const raw = provider === "openai" ? await callOpenAI(system, turns, apiKey, model) : await callAnthropic(system, turns);
    const match = (raw || "").match(/\[[\s\S]*\]/);
    const arr = match ? JSON.parse(match[0]) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, 3) : [];
  } catch (err) { console.error(`[ai-suggest:${tenantId}]`, err.message); return []; }
}

/** Summarize a conversation into a few bullet points. Returns string. */
export async function summarizeChat(tenantId, jid) {
  const recent = q.recentMessages.all(tenantId, jid, 40).reverse();
  if (!recent.length) return null;
  const agent = resolveAgent(tenantId, q.getChat.get(tenantId, jid));
  const { apiKey, model, provider } = resolveProviderConfig(tenantId, agent);
  const convo = recent.map((m) => `${m.from_me ? "Business" : "Customer"}: ${m.body}`).join("\n");
  const system = "Summarize this WhatsApp conversation for a busy business owner. Give a 1-line summary, then 2-4 short bullet points covering what the customer wants, key details, and any next action needed. Be concise. Use plain text with '•' bullets.";
  const turns = [{ role: "user", content: convo }];
  try {
    return provider === "openai" ? await callOpenAI(system, turns, apiKey, model) : await callAnthropic(system, turns);
  } catch (err) { console.error(`[ai-summarize:${tenantId}]`, err.message); return null; }
}

/** Learn how the BUSINESS OWNER writes (global voice) from their sent messages. */
export async function learnOwnerStyle(tenantId) {
  const rows = q.recentOwnerMessages.all(tenantId, 300).map((r) => r.body).filter(Boolean);
  if (rows.length < 100) { const e = new Error(`Need 100 sent messages to learn your style (have ${rows.length}).`); e.tooFew = rows.length; throw e; }
  const { apiKey, model, provider } = resolveProviderConfig(tenantId, null);
  if (!apiKey) { const e = new Error("No AI API key configured"); e.aiProviderError = true; throw e; }
  const sample = rows.slice(0, 200).join("\n---\n");
  const system = "You analyze how a business owner writes on WhatsApp so an AI assistant can reply in their exact voice. From these real messages, produce a concise STYLE GUIDE (max ~150 words) covering: tone (warm/formal/casual), formality, typical greeting & sign-off, emoji usage, punctuation habits, sentence length, capitalization, languages/Roman-Urdu, and any catchphrases. Write it as direct instructions to the assistant, e.g. 'Keep replies short and warm. Use one emoji max...'. Output ONLY the guide.";
  const turns = [{ role: "user", content: `Here are the owner's messages:\n${sample}` }];
  const out = provider === "openai" ? await callOpenAI(system, turns, apiKey, model) : await callAnthropic(system, turns);
  return out;
}

/**
 * Learn the GLOBAL owner voice instantly from one or more exported WhatsApp
 * chats, instead of waiting for 100 live sent messages. If ownerName is given
 * we isolate the owner's own messages across all files; otherwise we feed the
 * full transcripts and let the model infer the owner's voice.
 */
export async function learnOwnerStyleFromExports(tenantId, rawTexts = [], ownerName = "") {
  const all = [];
  for (const t of rawTexts) all.push(...cleanWhatsAppExport(t));
  let lines = all;
  if (ownerName) {
    const pref = ownerName.trim().toLowerCase() + ":";
    const mine = all.filter((l) => l.toLowerCase().startsWith(pref)).map((l) => l.slice(l.indexOf(":") + 1).trim());
    if (mine.length >= 5) lines = mine;
  }
  if (lines.length < 5) { const e = new Error("Couldn't read enough messages — upload the .txt files from WhatsApp's \"Export chat\" (unzip first)."); throw e; }
  const { apiKey, model, provider } = resolveProviderConfig(tenantId, null);
  if (!apiKey) { const e = new Error("No AI API key configured"); e.aiProviderError = true; throw e; }
  let sample = lines.join("\n");
  if (sample.length > 24000) sample = sample.slice(-24000);
  const hint = ownerName ? `These are the business owner's ("${ownerName}") own messages.` : `These are full WhatsApp transcripts — focus on how the business owner (not the customers) writes.`;
  const system = "You analyze how a business owner writes on WhatsApp so an AI assistant can reply in their exact voice. Produce a concise STYLE GUIDE (max ~150 words) covering: tone (warm/formal/casual), formality, typical greeting & sign-off, emoji usage, punctuation habits, sentence length, capitalization, languages/Roman-Urdu, and any catchphrases. Write it as direct instructions to the assistant, e.g. 'Keep replies short and warm. Use one emoji max...'. Output ONLY the guide.";
  const turns = [{ role: "user", content: `${hint}\n\n${sample}` }];
  const out = provider === "openai" ? await callOpenAI(system, turns, apiKey, model) : await callAnthropic(system, turns);
  return { style: out, imported: lines.length };
}

/**
 * Run the agent (possibly unsaved, from the create/edit form) against a test
 * conversation and return its next reply — powers the in-modal phone tester.
 */
export async function testAgentReply(tenantId, draft = {}, messages = []) {
  const useAgent = draft.openai_api_key ? { openai_api_key: draft.openai_api_key, model: draft.model } : null;
  const { apiKey, model, provider } = resolveProviderConfig(tenantId, useAgent);
  if (!apiKey) { const e = new Error("No AI API key configured — add one to this agent or in AI Settings."); e.aiProviderError = true; throw e; }
  let system = (draft.instructions || "").trim() || "You are a helpful WhatsApp business assistant.";
  if ((draft.playbook || "").trim()) system += `\n\n## Conversation Playbook:\n${draft.playbook}`;
  if ((draft.rules || "").trim()) system += `\n\n## Rules:\n${draft.rules}`;
  if ((draft.writing_style || "").trim()) system += `\n\n## Write in this agent's voice:\n${draft.writing_style}`;
  system += "\n\nThis is a TEST conversation with the owner. Reply exactly as you would to a real customer on WhatsApp — concise and natural.";
  let turns = (messages || []).slice(-20).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length) turns = [{ role: "user", content: "Hi!" }];
  const out = provider === "openai" ? await callOpenAI(system, turns, apiKey, model) : await callAnthropic(system, turns);
  return out;
}

/** Learn a single conversation: a running summary + how that customer communicates. */
export async function learnChatBehaviour(tenantId, jid) {
  const recent = q.recentMessages.all(tenantId, jid, 200).reverse().filter((m) => !m.mime_type);
  if (recent.length < 1) { const e = new Error("No messages to analyze yet."); throw e; }
  const agent = resolveAgent(tenantId, q.getChat.get(tenantId, jid));
  const { apiKey, model, provider } = resolveProviderConfig(tenantId, agent);
  if (!apiKey) { const e = new Error("No AI API key configured"); e.aiProviderError = true; throw e; }
  const convo = recent.map((m) => `${m.from_me ? "Owner" : "Customer"}: ${m.body}`).join("\n");
  const system = "Analyze this WhatsApp conversation. Return STRICT JSON with two keys: \"summary\" (3-5 sentences: who the customer is, what they want, status, any commitments) and \"style\" (how THIS customer communicates — tone, formality, language/Roman-Urdu, emoji/punctuation habits, and how the owner should mirror them naturally; ~80 words). Output ONLY the JSON object.";
  const turns = [{ role: "user", content: convo }];
  const raw = provider === "openai" ? await callOpenAI(system, turns, apiKey, model) : await callAnthropic(system, turns);
  let summary = "", style = "";
  try { const m = (raw || "").match(/\{[\s\S]*\}/); const o = m ? JSON.parse(m[0]) : {}; summary = o.summary || ""; style = o.style || ""; }
  catch { summary = raw || ""; }
  return { summary, style };
}

/**
 * Strip WhatsApp export decorations (timestamps, system lines, media markers)
 * down to "Sender: message" lines. Handles the common bracketed and dash
 * formats across locales.
 */
function cleanWhatsAppExport(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = [];
  // [12/02/24, 10:30:45 AM] Name: msg   |   12/02/2024, 10:30 - Name: msg
  const bracket = /^\[[^\]]+\]\s*([^:]{1,40}):\s?(.*)$/;
  const dash = /^\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap]\.?[Mm]\.?)?\s*[-–]\s*([^:]{1,40}):\s?(.*)$/;
  const mediaOmitted = /(<Media omitted>|image omitted|video omitted|audio omitted|sticker omitted|GIF omitted|document omitted|<attached:|This message was deleted|Messages and calls are end-to-end encrypted)/i;
  for (const line of lines) {
    const m = line.match(bracket) || line.match(dash);
    if (m) {
      const sender = m[1].trim();
      const text = m[2].trim();
      if (!text || mediaOmitted.test(text)) continue;
      out.push(`${sender}: ${text}`);
    } else if (out.length && line.trim()) {
      // continuation of the previous (multi-line) message
      out[out.length - 1] += " " + line.trim();
    }
  }
  return out;
}

/**
 * Learn a conversation's history from a pasted/exported WhatsApp transcript,
 * so the agent understands the relationship without waiting for live messages.
 * `ownerName` (optional) tells us which sender is the business owner.
 */
export async function learnChatBehaviourFromExport(tenantId, jid, rawText, ownerName = "") {
  const lines = cleanWhatsAppExport(rawText);
  if (lines.length < 5) { const e = new Error("Couldn't read this file — make sure it's the .txt from WhatsApp's \"Export chat\" (unzip first)."); throw e; }
  const agent = resolveAgent(tenantId, q.getChat.get(tenantId, jid));
  const { apiKey, model, provider } = resolveProviderConfig(tenantId, agent);
  if (!apiKey) { const e = new Error("No AI API key configured"); e.aiProviderError = true; throw e; }
  // Cap the transcript so we stay within context (keep the most recent tail).
  let convo = lines.join("\n");
  if (convo.length > 24000) convo = "…(earlier messages trimmed)…\n" + convo.slice(-24000);
  const ownerHint = ownerName ? `The business owner in this transcript is "${ownerName}"; the other participant(s) are the customer.` : "Infer which participant is the business owner versus the customer from context.";
  const system = `Analyze this exported WhatsApp conversation history. ${ownerHint} Return STRICT JSON with two keys: "summary" (4-6 sentences: who the customer is, the full relationship/history so far, what they want, current status, any commitments or important details) and "style" (how the customer communicates AND how the owner has been replying — tone, formality, language/Roman-Urdu, emoji/punctuation habits, and how the assistant should mirror them; ~100 words). Output ONLY the JSON object.`;
  const turns = [{ role: "user", content: convo }];
  const raw = provider === "openai" ? await callOpenAI(system, turns, apiKey, model) : await callAnthropic(system, turns);
  let summary = "", style = "";
  try { const m = (raw || "").match(/\{[\s\S]*\}/); const o = m ? JSON.parse(m[0]) : {}; summary = o.summary || ""; style = o.style || ""; }
  catch { summary = raw || ""; }
  return { summary, style, imported: lines.length };
}

/**
 * Pick which AI persona answers a chat:
 *   1. the agent explicitly assigned to the chat, else
 *   2. the tenant's first active agent (so once an agent exists, it's used — not the generic one), else
 *   3. null → caller falls back to the global AI Settings prompt.
 */
function resolveAgent(tenantId, chat) {
  if (chat?.agent_id) {
    const a = q.getAgent.get(chat.agent_id, tenantId);
    if (a && a.active) return a;
  }
  const active = q.listAgents.all(tenantId).find((a) => a.active);
  return active ? q.getAgent.get(active.id, tenantId) : null;
}

function buildSystemPrompt(tenantId, agent, chat = null) {
  let prompt;
  if (agent) {
    prompt = agent.instructions || "You are a helpful WhatsApp business assistant.";
    if (agent.playbook?.trim()) prompt += `\n\n## Conversation Playbook:\n${agent.playbook}`;
    if (agent.rules?.trim()) prompt += `\n\n## Rules:\n${agent.rules}`;
    const knowledge = q.getKnowledgeForAgent.all(tenantId, agent.id);
    if (knowledge.length) {
      prompt += "\n\n## Knowledge Base:\n";
      for (const k of knowledge) prompt += `\n### ${k.file_name}\n${k.content}\n`;
    }
  } else {
    prompt = getSetting(tenantId, "ai_system_prompt") || "You are a helpful assistant.";
  }
  return prompt + behaviourAddendum(tenantId, agent, chat);
}

/* Learned behaviour appended to every AI reply so it sounds natural.
   Style precedence (most specific wins):
     1. the thread's own learned style (imported history / 100-msg learn)
     2. the replying agent's own writing style
     3. the global Default AI Agent voice (owner_style) — only when no agent
   The conversation summary is always included when available. */
function behaviourAddendum(tenantId, agent, chat) {
  let extra = "";
  if (chat?.ai_summary) extra += `\n\n## What's happened in this conversation:\n${chat.ai_summary}`;
  if (chat?.ai_style) {
    extra += `\n\n## Reply in THIS conversation's established style (mirror it naturally):\n${chat.ai_style}`;
  } else if (agent?.writing_style?.trim()) {
    extra += `\n\n## Write in this agent's voice:\n${agent.writing_style}`;
  } else if (!agent) {
    const ownerStyle = getSetting(tenantId, "owner_style");
    if (ownerStyle) extra += `\n\n## Write in the business owner's voice:\n${ownerStyle}`;
  }
  return extra;
}

function buildTurns(recent) {
  const turns = [];
  for (const m of recent) {
    const role = m.from_me ? "assistant" : "user";
    if (turns.length && turns[turns.length - 1].role === role) {
      turns[turns.length - 1].content += "\n" + m.body;
    } else {
      turns.push({ role, content: m.body });
    }
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}

function resolveProviderConfig(tenantId, agent) {
  // 1) Agent's own key  →  2) application owner's global key (set in Admin)  →  3) env  →  4) Anthropic
  if (agent?.openai_api_key) {
    return { apiKey: agent.openai_api_key, model: agent.model || "gpt-4o-mini", provider: "openai" };
  }
  const globalOpenAI = q.getApp.get("global_openai_key")?.value;
  if (globalOpenAI) {
    return { apiKey: globalOpenAI, model: agent?.model || "gpt-4o-mini", provider: "openai" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || "gpt-4o-mini", provider: "openai" };
  }
  const globalAnthropic = q.getApp.get("global_anthropic_key")?.value;
  return { apiKey: globalAnthropic || process.env.ANTHROPIC_API_KEY || "", model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514", provider: "anthropic" };
}

async function callAnthropic(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 400,
      system,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || null;
}

async function callOpenAI(system, messages, apiKey, model = "gpt-4o-mini") {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey || ""}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}
