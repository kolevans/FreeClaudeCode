#!/usr/bin/env node
/** Runs under system Node (not pkg) so better-sqlite3 native addon works. */
const fs = require("fs");
const path = require("path");

const ALLOWED_FNS = new Set([
  "createApiKey", "ensureApiKey", "listApiKeys", "getKiroStatus",
  "getKeyUsage", "logoutKiro", "getAccountLimitInfo", "clearKiroCooldowns",
  "healKiroConnections", "hasKiroCredentials", "diagnoseInstall", "repairInstall",
]);

try {
  const keys = require(path.join(__dirname, "omni-keys.js"));
  const fn = process.argv[2];
  if (!fn || !ALLOWED_FNS.has(fn) || typeof keys[fn] !== "function") {
    process.stdout.write(JSON.stringify({ error: `Unknown fn: ${fn}` }));
    process.exit(2);
  }
  let args = [];
  const raw = fs.readFileSync(0, "utf8");
  if (raw && raw.trim()) {
    try {
      args = JSON.parse(raw);
    } catch {
      // Silently defaulting to [] would call the function with wrong arguments.
      process.stdout.write(JSON.stringify({ error: "Некорректные аргументы для sqlite-bridge" }));
      process.exit(1);
    }
  }
  if (!Array.isArray(args)) args = [args];
  const result = keys[fn](...args);
  process.stdout.write(JSON.stringify(result == null ? null : result));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
  process.exit(1);
}
