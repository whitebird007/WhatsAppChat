/* ============================================================
   db-sync.js — durable SQLite persistence for Replit deploys
   ------------------------------------------------------------
   Replit Reserved-VM deployments rebuild from the workspace on every
   publish, which wipes the on-disk SQLite file (and the WhatsApp session
   stored inside it). To survive redeploys we back the database up to
   Replit's built-in KV store (REPLIT_DB_URL) and restore it on boot.

   Key design points (lessons learned the hard way):
   • DEV vs PROD use SEPARATE KV keys, split on DATA_DIR. Production sets
     DATA_DIR; dev does not. Without this, the always-running dev server
     overwrites production's backup with its empty database every 30s.
   • Backups are WAL-checkpointed first (PRAGMA wal_checkpoint(TRUNCATE))
     so the snapshot includes the very latest writes (e.g. a fresh signup
     sitting in the -wal file). Skipping this silently loses recent data.
   • Restore only runs when there is NO local DB file (fresh deploy), so it
     can never clobber a database that already has data.
   • A no-op when REPLIT_DB_URL is absent, so non-Replit hosts are unaffected.
   ============================================================ */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KV_URL = process.env.REPLIT_DB_URL || "";

// Separate backup keys so dev and production never touch each other's data.
export const KV_KEY = process.env.DATA_DIR ? "zaply_prod_sqlite_db_v1" : "zaply_dev_sqlite_db_v1";

export function kvAvailable() { return !!KV_URL; }

/** Same path logic db.js uses — kept here so the prestart restore agrees with it. */
export function resolveDataDir() {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..");
}
export function resolveDbPath() {
  return process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(resolveDataDir(), "data.sqlite");
}

/* ---------- Replit KV REST helpers ---------- */
async function kvGet(key) {
  const res = await fetch(`${KV_URL}/${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV GET ${res.status}`);
  const text = await res.text();
  return text.length ? text : null;
}
async function kvSet(key, value) {
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
  });
  if (!res.ok) throw new Error(`KV SET ${res.status}`);
}

/* ---------- Restore (run BEFORE the DB is opened) ---------- */
export async function restoreDbFromKv() {
  if (!KV_URL) return false;
  const dbPath = resolveDbPath();
  try {
    // Never overwrite an existing database — only restore onto a fresh deploy.
    if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      console.log(`[db-sync] local DB present (${fs.statSync(dbPath).size} bytes) — skip restore`);
      return false;
    }
    const b64 = await kvGet(KV_KEY);
    if (!b64) { console.log(`[db-sync] no backup at "${KV_KEY}" — starting fresh`); return false; }
    const buf = zlib.gunzipSync(Buffer.from(b64, "base64"));
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, buf);
    // Drop any stale WAL/SHM so SQLite doesn't replay an old journal over the restore.
    for (const ext of ["-wal", "-shm"]) { try { fs.rmSync(dbPath + ext, { force: true }); } catch {} }
    console.log(`[db-sync] restored ${buf.length} bytes from "${KV_KEY}"`);
    return true;
  } catch (e) {
    console.error("[db-sync] restore failed:", e.message);
    return false;
  }
}

/* ---------- Backup ---------- */
// Registered by the server so we can flush WAL → main file before snapshotting.
let checkpointHook = null;
export function setCheckpointHook(fn) { checkpointHook = fn; }

let backingUp = false;
export async function backupDbToKv(reason = "") {
  if (!KV_URL || backingUp) return false;
  backingUp = true;
  const dbPath = resolveDbPath();
  try {
    if (!fs.existsSync(dbPath)) return false;
    try { checkpointHook?.(); } catch (e) { console.error("[db-sync] checkpoint failed:", e.message); }
    const buf = fs.readFileSync(dbPath);
    const b64 = zlib.gzipSync(buf).toString("base64");
    if (b64.length > 4_500_000) {
      console.warn(`[db-sync] backup is ${(b64.length / 1e6).toFixed(1)}MB — approaching Replit KV value limit; consider external storage.`);
    }
    await kvSet(KV_KEY, b64);
    console.log(`[db-sync] backed up ${buf.length} bytes (${b64.length} b64) → "${KV_KEY}"${reason ? ` [${reason}]` : ""}`);
    return true;
  } catch (e) {
    console.error("[db-sync] backup failed:", e.message);
    return false;
  } finally {
    backingUp = false;
  }
}

/** Fire-and-forget backup on important events (signup, login, WhatsApp creds change). */
export function triggerBackup(reason) { if (KV_URL) backupDbToKv(reason); }

let timer = null;
export function startBackupLoop({ intervalMs = 30_000, initialDelayMs = 10_000 } = {}) {
  if (!KV_URL || timer) return;
  console.log(`[db-sync] KV persistence ON — key "${KV_KEY}", every ${intervalMs / 1000}s`);
  setTimeout(() => backupDbToKv("initial"), initialDelayMs);
  timer = setInterval(() => backupDbToKv("interval"), intervalMs);
}
