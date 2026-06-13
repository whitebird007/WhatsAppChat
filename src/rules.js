import { q } from "./db.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Check the LATEST inbound message against a tenant's active keyword rules.
 * `text` is only ever the current message (never the chat history), so a rule
 * fires on what the customer just said, not on something said earlier.
 *
 * Match types:
 *   exact    — the whole message equals the keyword ("yes")
 *   starts   — the message starts with the keyword
 *   contains — the keyword appears as a WHOLE WORD/phrase in the message
 *              (so "yes" matches "yes please" but NOT "yesterday")
 *
 * Returns the reply string of the first matching rule, or null.
 */
export function matchRule(tenantId, text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  if (!lower) return null;
  const rules = q.listRules.all(tenantId).filter((r) => r.active);
  for (const r of rules) {
    const kw = r.keyword.toLowerCase().trim();
    if (!kw) continue;
    if (r.match_type === "exact" && lower === kw) return r.reply;
    if (r.match_type === "starts" && lower.startsWith(kw)) return r.reply;
    if (r.match_type === "contains") {
      // Whole-word match: the keyword must be bounded by non-letter/digit
      // characters (or string edges), not embedded inside another word.
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(kw)}([^\\p{L}\\p{N}]|$)`, "u");
      if (re.test(lower)) return r.reply;
    }
  }
  return null;
}
