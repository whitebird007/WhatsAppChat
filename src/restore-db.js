/* Prestart hook: restore the SQLite DB from Replit KV BEFORE the server opens it.
   Runs as its own process (npm "prestart") so the DB file is in place before
   db.js loads. No-op when REPLIT_DB_URL is absent. Never throws fatally. */
import { restoreDbFromKv, kvAvailable, KV_KEY } from "./db-sync.js";

if (!kvAvailable()) {
  console.log("[db-sync] REPLIT_DB_URL not set — KV restore skipped");
} else {
  try {
    await restoreDbFromKv();
  } catch (e) {
    console.error(`[db-sync] prestart restore error (key ${KV_KEY}):`, e.message);
  }
}
