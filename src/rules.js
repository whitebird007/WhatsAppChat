import { q } from "./db.js";

/**
 * Check inbound text against a tenant's active keyword rules.
 * Returns the reply string of the first matching rule, or null.
 */
export function matchRule(tenantId, text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  const rules = q.listRules.all(tenantId).filter((r) => r.active);
  for (const r of rules) {
    const kw = r.keyword.toLowerCase().trim();
    if (!kw) continue;
    if (r.match_type === "exact" && lower === kw) return r.reply;
    if (r.match_type === "starts" && lower.startsWith(kw)) return r.reply;
    if (r.match_type === "contains" && lower.includes(kw)) return r.reply;
  }
  return null;
}
