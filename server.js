const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync, execFile, execFileSync } = require("child_process");
const { URL } = require("url");
const { promisify } = require("util");
const omniKeys = process.pkg ? require("./omni-keys-proxy") : require("./omni-keys");
const { createAxiom } = require("./axiom");
const { describeUpstreamError } = require("./errors");
const { kiroStateFromProviders } = require("./kiro-state");
const { createAppLog } = require("./app-log");
const { listClaudeSessions, isSessionId } = require("./claude-sessions");
const i18n = require("./i18n");

const execFileAsync = promisify(execFile);

const PORT = 3847;
const OMNI = "http://127.0.0.1:20128";
const OMNI_HOSTS = ["127.0.0.1", "localhost"];
const OMNI_PORT = 20128;
const SETTINGS = path.join(process.env.USERPROFILE || os.homedir(), ".claude", "settings.json");
const PROFILE_DIR = path.join(process.env.USERPROFILE || os.homedir(), ".claude", "profiles", "active-freeclaude");
const IS_PKG = Boolean(process.pkg);
const EXE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = (() => {
  const dir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "FreeClaude");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
})();
const appLog = createAppLog(DATA_DIR);
appLog.mirrorConsole();
const CONFIG = path.join(DATA_DIR, "config.json");
// Claude Code loads ~/.claude/CLAUDE.md into every session, so the toggle is just this
// file being present or not. The text itself lives in DATA_DIR and survives switching off.
const CLAUDE_MD = path.join(path.dirname(SETTINGS), "CLAUDE.md");
const CLAUDE_MD_BACKUP = path.join(path.dirname(SETTINGS), "CLAUDE.md.freeclaude-bak");
const AXIOM_STORE = path.join(DATA_DIR, "axiom.md");
// Prefer the copy next to the exe (easy to replace), then the one baked into the pkg snapshot.
const AXIOM_BUNDLED = [
  path.join(EXE_DIR, "axiom-default.md"),
  path.join(__dirname, "axiom-default.md"),
].find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}) || path.join(EXE_DIR, "axiom-default.md");
const axiom = createAxiom({
  claudeMd: CLAUDE_MD,
  backup: CLAUDE_MD_BACKUP,
  store: AXIOM_STORE,
  bundled: AXIOM_BUNDLED,
});
const FREECLAUDE = path.join(DATA_DIR, "freeclaude.bat");
const PUBLIC = path.join(__dirname, "public");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const NODE_PORTABLE_DIR = path.join(LOCALAPPDATA, "Programs", "node");
const MIN_NODE_MAJOR = 22;
const ACCESS_URL = "https://pastebin.com/raw/8tzPV0Bu";
const TELEGRAM_URL = "https://t.me/loveaideep";
const AWS_SIGNOUT_URL = "https://view.awsapps.com/start/#/signout";
const AWS_PORTAL_URL = "https://view.awsapps.com/start";

/**
 * Both values end up inside .bat files, where `&`, `|`, `>` and newlines start new commands.
 * Allowlisting the characters we actually need is what keeps that from being executable.
 */
const MODEL_RE = /^[A-Za-z0-9._/:-]{1,120}$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{1,200}$/;
// Local drive path or UNC share, without the characters cmd.exe treats as syntax.
const PATH_RE = /^(?:[A-Za-z]:\\|\\\\)[^"|&<>^%\r\n]{0,400}$/;
// POSIX path for macOS/Linux: starts with /, no dangerous shell chars
const POSIX_PATH_RE = /^\/[^"'&|;<>\x60$\r\n]{0,400}$/;

const {
  NODE_DIR_DEFAULT,
  NPM_BIN,
  configuredPaths,
  enrichedPath,
  existingFile,
  invalidateToolCache,
  manualPath,
  nodeDir,
  nodeMajorVersion,
  resolveNode,
  resolveNpm,
  whereOnPath,
} = require("./node-resolve");
const { toBatPath, toBatPathSafe } = require("./bat-path");

/**
 * OmniRoute and Claude Code are npm globals, so they normally sit in %APPDATA%\npm.
 * A custom npm prefix puts them elsewhere, which used to leave the UI insisting they were
 * not installed with no way to correct it — hence the manual override per component.
 */
function npmBinDir() {
  const isWin = process.platform === "win32";
  const exe = isWin ? "npm.cmd" : "npm";
  const omniExe = isWin ? "omniroute.cmd" : "omniroute";
  const claudeExe = isWin ? "claude.cmd" : "claude";

  const override = manualPath("omniroute", omniExe) || manualPath("claude", claudeExe) || manualPath("npm", exe);
  if (override) return path.dirname(override);
  const resolved = resolveNpm();
  if (resolved) return path.dirname(resolved);
  return NPM_BIN;
}

function omniCmdPath() {
  if (process.platform !== "win32") {
    // macOS / Linux: check homebrew and system paths
    for (const p of ["/opt/homebrew/bin/omniroute", "/usr/local/bin/omniroute"]) {
      if (fs.existsSync(p)) return p;
    }
    const wh = require("child_process").spawnSync("which", ["omniroute"], { encoding: "utf8" });
    if (wh.stdout && wh.stdout.trim()) return wh.stdout.trim();
  }
  return manualPath("omniroute", "omniroute.cmd") || path.join(npmBinDir(), "omniroute.cmd");
}

function claudeCmdPath() {
  if (process.platform !== "win32") {
    for (const p of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
      if (fs.existsSync(p)) return p;
    }
    const wh = require("child_process").spawnSync("which", ["claude"], { encoding: "utf8" });
    if (wh.stdout && wh.stdout.trim()) return wh.stdout.trim();
  }
  return manualPath("claude", "claude.cmd") || path.join(npmBinDir(), "claude.cmd");
}

const IS_WIN = process.platform === "win32";
const PATH_KEYS = {
  node: { exe: IS_WIN ? "node.exe" : "node", label: "Node.js" },
  npm: { exe: IS_WIN ? "npm.cmd" : "npm", label: "npm" },
  omniroute: { exe: IS_WIN ? "omniroute.cmd" : "omniroute", label: "OmniRoute" },
  claude: { exe: IS_WIN ? "claude.cmd" : "claude", label: "Claude Code" },
};

// Packaged EXE: do not auto-spawn a browser from inside pkg (causes 0xC0000005).
// Use FreeClaude.cmd launcher, or open http://127.0.0.1:3847 manually.
const openApp = process.argv.includes("--app");

const accessCache = {
  checkedAt: 0,
  allowed: true,
  raw: "1",
  error: null,
};

const installState = {
  running: false,
  step: "",
  log: [],
  ok: null,
  finishedAt: null,
  cancelRequested: false,
  child: null,
};

/** In-memory AWS Builder ID device-code session (OmniRoute dashboard login skipped). */
const kiroOAuth = {
  cookie: null,
  deviceCode: null,
  codeVerifier: null,
  extraData: null,
  expiresAt: 0,
  interval: 5,
  userCode: null,
  verificationUri: null,
  verificationUriComplete: null,
};

function parseEnvFile(envPath) {
  const out = {};
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[k] = v;
    }
  } catch {
    /* no .env */
  }
  return out;
}

/** Directory of the installed omniroute npm package, or null. */
function omniPackageDir() {
  const candidates = [
    path.join(npmBinDir(), "node_modules", "omniroute"),
    path.join(path.dirname(omniCmdPath()), "node_modules", "omniroute"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  }
  return null;
}

/**
 * The password can live in the user's data dir or in the package's own `.env` — the
 * latter is where `INITIAL_PASSWORD` actually ships, so skipping it lost the real value.
 */
function omniDataDirs() {
  const dirs = [];
  const configured = String(process.env.DATA_DIR || "").trim();
  if (configured) dirs.push(path.resolve(configured));
  dirs.push(path.join(os.homedir(), ".omniroute"));
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  if (appData) dirs.push(path.join(appData, "omniroute"));
  const seen = new Set();
  return dirs.filter((d) => {
    const key = d.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readOmniEnvFile() {
  const pkg = omniPackageDir();
  let merged = pkg ? parseEnvFile(path.join(pkg, ".env")) : {};
  // Fresh OmniRoute installs keep data under %APPDATA%\omniroute, not ~/.omniroute.
  for (const dir of omniDataDirs()) {
    merged = { ...merged, ...parseEnvFile(path.join(dir, ".env")) };
  }
  return merged;
}

function candidateOmniPasswords() {
  const cfg = readConfig();
  const envFile = readOmniEnvFile();
  const list = [
    process.env.INITIAL_PASSWORD,
    process.env.OMNIROUTE_PASSWORD,
    cfg.omniPassword,
    envFile.INITIAL_PASSWORD,
    envFile.OMNIROUTE_PASSWORD,
    envFile.DASHBOARD_PASSWORD,
    envFile.PASSWORD,
    "CHANGEME",
    "changeme",
    "admin",
    "password",
    "omniroute",
  ];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (p == null || p === "") continue;
    const s = String(p);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function cookieFromSetCookie(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const raw of list) {
    const m = String(raw || "").match(/auth_token=([^;]+)/);
    if (m) return `auth_token=${m[1]}`;
  }
  return null;
}

async function tryOmniLogin(password) {
  const res = await fetch(`${OMNI}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(15000),
  });
  const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cookie = cookieFromSetCookie(setCookie) || cookieFromSetCookie(res.headers.get("set-cookie"));
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { ok: res.ok && Boolean(cookie), status: res.status, cookie, text, json };
}

/** A wrong password answers 401/403 with "invalid password"; a dead server does not. */
function looksLikeBadOmniPassword(status, message) {
  if (status === 401 || status === 403) return true;
  return /invalid password|incorrect password|unauthorized|wrong password/i.test(String(message || ""));
}

function omniResetPasswordScript() {
  const pkg = omniPackageDir();
  if (!pkg) return null;
  const mjs = path.join(pkg, "bin", "reset-password.mjs");
  return fs.existsSync(mjs) ? mjs : null;
}

/** The reset CLI demands 8+ chars; hex keeps it safe for stdin and .bat interpolation. */
function generateOmniPassword() {
  return `fc-${crypto.randomBytes(9).toString("hex")}`;
}

/**
 * Runs OmniRoute's own `reset-password` CLI. Using the official tool means the bcrypt
 * format and the `requireLogin`/`setupComplete` flags stay whatever OmniRoute expects,
 * instead of us hand-writing a hash into its database.
 */
function runOmniPasswordReset(password) {
  const script = omniResetPasswordScript();
  const node = resolveNode();
  const env = { ...process.env, PATH: `${nodeDir()};${npmBinDir()};${enrichedPath()}` };
  const opts = {
    input: password,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
    env,
  };

  let r;
  if (script && node) {
    r = spawnSync(node, [script, "--password-stdin"], opts);
  } else {
    const shim = path.join(npmBinDir(), "omniroute-reset-password.cmd");
    if (!fs.existsSync(shim)) throw new Error(st("srv.resetCliMissing"));
    assertSafePath(shim, "omniroute-reset-password");
    r = spawnSync(`"${shim}" --password-stdin`, { ...opts, shell: true });
  }

  if (r.error) throw new Error(st("srv.resetCliFailed", { error: r.error.message }));
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  if (r.status !== 0) throw new Error(out.slice(0, 300) || `reset-password exit ${r.status}`);
  return out;
}

let restartOmniLock = null;

async function restartOmniRoute() {
  // Serialize kill+ensure so two restarts cannot murder each other's spawn.
  if (restartOmniLock) {
    appLog.info("OmniRoute restart: waiting for in-flight restart");
    return restartOmniLock;
  }
  restartOmniLock = (async () => {
    appLog.info("OmniRoute restart: killing listeners on :20128");
    killOmniRouteListeners();
    const free = await waitForOmniPortFree(20000);
    if (!free) {
      appLog.warn("OmniRoute restart: port still busy after wait — killing again");
      killOmniRouteListeners();
      await waitForOmniPortFree(10000);
    }
    let up = await ensureOmni(90000, { forceStart: true });
    if (!up) {
      appLog.warn("OmniRoute restart: first ensure failed — retry");
      killOmniRouteListeners();
      await waitForOmniPortFree(15000);
      up = await ensureOmni(90000, { forceStart: true });
    }
    appLog.info(`OmniRoute restart: ${up ? "online" : "FAILED"}`);
    return up;
  })().finally(() => {
    restartOmniLock = null;
  });
  return restartOmniLock;
}

/** True when something already accepts TCP on OmniRoute's port (even if /health is dead). */
function isOmniPortBusy() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: OMNI_PORT });
    const done = (busy) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(busy);
    };
    socket.setTimeout(800);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Probe by binding: if we can listen, the port is free. */
function canBindOmniPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen(OMNI_PORT, "127.0.0.1");
    } catch {
      resolve(false);
    }
  });
}

async function waitForOmniPortFree(timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canBindOmniPort()) return true;
    await sleep(400);
  }
  return canBindOmniPort();
}

// One attempt per run: if the reset itself cannot fix the login, retrying on every click
// would just restart OmniRoute in a loop.
let omniPasswordRecovered = false;

/**
 * Last resort when no known password works: set a fresh one through OmniRoute's CLI and
 * remember it, so a first-time user never has to learn what CHANGEME is.
 */
async function recoverOmniPassword() {
  if (omniPasswordRecovered) return null;

  const password = generateOmniPassword();
  try {
    runOmniPasswordReset(password);
  } catch (err) {
    // Leave the flag unset so the next Kiro click can try again after OmniRoute finishes installing.
    throw err;
  }
  omniPasswordRecovered = true;
  try {
    writeConfig({ omniPassword: password });
  } catch {
    /* the login below still works, it just will not survive a restart */
  }
  console.log(st("con.passwordReset"));

  let r = await tryOmniLogin(password).catch(() => null);
  if (r?.ok && r.cookie) return r.cookie;

  // A running OmniRoute keeps the old hash in memory, so the reset only counts after a restart.
  pushLog(st("log.omniRestartAfterReset"));
  if (await restartOmniRoute()) {
    r = await tryOmniLogin(password).catch(() => null);
    if (r?.ok && r.cookie) return r.cookie;
  }
  // Recovery wrote a password we cannot use yet — allow another attempt next time.
  omniPasswordRecovered = false;
  return null;
}

async function loginOmniDashboard() {
  let lastMsg = "";
  let lastStatus = 0;
  for (const password of candidateOmniPasswords()) {
    try {
      const r = await tryOmniLogin(password);
      if (r.ok && r.cookie) {
        try {
          writeConfig({ omniPassword: password });
        } catch {
          /* ignore */
        }
        return r.cookie;
      }
      lastStatus = r.status;
      lastMsg =
        (r.json && (r.json.error || r.json.message)) ||
        r.text ||
        `login failed (${r.status})`;
    } catch (err) {
      lastMsg = String(err.message || err);
    }
  }

  if (looksLikeBadOmniPassword(lastStatus, lastMsg)) {
    try {
      const cookie = await recoverOmniPassword();
      if (cookie) return cookie;
    } catch (err) {
      lastMsg = st("srv.autoResetFailed", { detail: lastMsg, error: String(err.message || err) });
    }
    throw new Error(
      st("srv.passwordDead", { url: OMNI, detail: String(lastMsg).slice(0, 200) })
    );
  }
  throw new Error(String(lastMsg || "OmniRoute login failed"));
}

// Dashboard cookies stay valid for a while; re-logging in on every poll would hammer
// the password path (and its recovery) for no reason.
const omniSession = { cookie: null, at: 0 };
const OMNI_SESSION_TTL = 10 * 60 * 1000;

async function omniDashboardCookie() {
  if (omniSession.cookie && Date.now() - omniSession.at < OMNI_SESSION_TTL) return omniSession.cookie;
  const cookie = await loginOmniDashboard();
  omniSession.cookie = cookie;
  omniSession.at = Date.now();
  return cookie;
}

function dropOmniSession() {
  omniSession.cookie = null;
  omniSession.at = 0;
}

/**
 * Second opinion on the Kiro account that does not touch SQLite.
 *
 * Everything about "is Kiro connected" used to come from reading OmniRoute's database
 * directly, which runs through a child Node process. On machines where that bridge fails
 * (no Node on PATH, unusable better-sqlite3 binary, locked file) the UI declared the user
 * logged out right after a successful AWS login. OmniRoute's own API knows the answer.
 */
async function fetchKiroStateOverHttp() {
  const cookie = await omniDashboardCookie();
  let res = await fetch(`${OMNI}/api/providers`, {
    headers: { Cookie: cookie, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) {
    dropOmniSession();
    res = await fetch(`${OMNI}/api/providers`, {
      headers: { Cookie: await omniDashboardCookie(), Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  }
  if (!res.ok) throw new Error(`providers ${res.status}`);
  return kiroStateFromProviders(await res.json());
}

const kiroHttpCache = { at: 0, value: null };

/** Cached so a disconnected account does not refetch the provider list on every poll. */
async function kiroStateOverHttp(maxAgeMs = 15000) {
  if (kiroHttpCache.value && Date.now() - kiroHttpCache.at < maxAgeMs) return kiroHttpCache.value;
  try {
    const value = await fetchKiroStateOverHttp();
    kiroHttpCache.at = Date.now();
    kiroHttpCache.value = value;
    return value;
  } catch {
    return null;
  }
}

function invalidateKiroHttpCache() {
  kiroHttpCache.at = 0;
  kiroHttpCache.value = null;
}

/**
 * Kiro is connected if either source says so. The database is authoritative when it
 * answers; HTTP covers the case where it cannot.
 */
async function resolveKiroConnected({ maxAgeMs = 15000 } = {}) {
  let dbConnected = null;
  let dbError = null;
  try {
    try {
      omniKeys.healKiroConnections();
    } catch {
      /* healing is best-effort */
    }
    const lim = omniKeys.getAccountLimitInfo();
    dbConnected = Boolean(lim && lim.connected);
    if (!dbConnected) dbConnected = Boolean(omniKeys.hasKiroCredentials());
  } catch (err) {
    dbError = String(err.message || err);
  }

  if (dbConnected) return { connected: true, source: "db", dbError: null };

  const http = await kiroStateOverHttp(maxAgeMs);
  if (http?.connected) return { connected: true, source: "http", dbError };
  return {
    connected: false,
    source: dbError ? (http ? "http" : "none") : "db",
    dbError,
  };
}

async function startKiroBuilderIdFlow() {
  if (!(await ensureOmni(60000))) {
    throw new Error(st("srv.omniDown"));
  }
  // A fresh cookie for the whole device flow; share it so the status fallback reuses it.
  const cookie = await loginOmniDashboard();
  omniSession.cookie = cookie;
  omniSession.at = Date.now();
  const dcRes = await fetch(`${OMNI}/api/oauth/kiro/device-code`, {
    headers: { Cookie: cookie, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  const data = await dcRes.json().catch(() => ({}));
  if (!dcRes.ok || !data.device_code) {
    throw new Error(data.error || data.message || `device-code failed (${dcRes.status})`);
  }

  kiroOAuth.cookie = cookie;
  kiroOAuth.deviceCode = data.device_code;
  kiroOAuth.codeVerifier = data.codeVerifier || null;
  kiroOAuth.extraData = {
    _clientId: data._clientId,
    _clientSecret: data._clientSecret,
    _region: data._region || "us-east-1",
    _authMethod: data._authMethod || "builder-id",
  };
  kiroOAuth.interval = Math.max(3, Number(data.interval) || 5);
  kiroOAuth.expiresAt = Date.now() + Math.max(60, Number(data.expires_in) || 600) * 1000;
  kiroOAuth.userCode = data.user_code || null;
  kiroOAuth.verificationUri = data.verification_uri || "https://view.awsapps.com/start/#/device";
  kiroOAuth.verificationUriComplete =
    data.verification_uri_complete ||
    (kiroOAuth.userCode
      ? `https://view.awsapps.com/start/#/device?user_code=${encodeURIComponent(kiroOAuth.userCode)}`
      : kiroOAuth.verificationUri);

  return {
    userCode: kiroOAuth.userCode,
    verificationUri: kiroOAuth.verificationUri,
    verificationUriComplete: kiroOAuth.verificationUriComplete,
    expiresIn: Math.max(0, Math.floor((kiroOAuth.expiresAt - Date.now()) / 1000)),
    interval: kiroOAuth.interval,
  };
}

async function pollKiroBuilderIdOnce() {
  if (!kiroOAuth.cookie || !kiroOAuth.deviceCode || !kiroOAuth.extraData) {
    return { success: false, pending: false, error: "no_session", errorDescription: st("srv.noKiroSession") };
  }
  if (Date.now() > kiroOAuth.expiresAt) {
    return { success: false, pending: false, error: "expired", errorDescription: st("srv.codeExpired") };
  }

  const body = {
    deviceCode: kiroOAuth.deviceCode,
    codeVerifier: kiroOAuth.codeVerifier,
    extraData: kiroOAuth.extraData,
  };
  const res = await fetch(`${OMNI}/api/oauth/kiro/poll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: kiroOAuth.cookie,
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (data.success) {
    kiroOAuth.cookie = null;
    kiroOAuth.deviceCode = null;
    kiroOAuth.extraData = null;
  }
  return {
    success: Boolean(data.success),
    pending: Boolean(data.pending) || data.error === "authorization_pending" || data.error === "slow_down",
    error: data.error || null,
    errorDescription: data.errorDescription || data.error_description || null,
    slowDown: data.error === "slow_down",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function countKiroModels() {
  try {
    const r = await omniFetch("/v1/models");
    if (!r.ok) return 0;
    const all = r.json?.data || [];
    return all.filter((m) => /^(kiro|kr)\//i.test(m.id || "")).length;
  } catch {
    return 0;
  }
}

/**
 * После AWS «Request approved» OmniRoute ещё секунды пишет токены / каталог моделей.
 * Ждём готовность, иначе UI показывает «не авторизован» и пустой список.
 */
async function finalizeKiroAuth() {
  const started = Date.now();
  const timeoutMs = 25000;
  let keyIssued = null;
  let healed = 0;
  let modelsCount = 0;
  let connected = false;

  // Ключ сразу — /v1/models часто требует Bearer
  try {
    let created;
    if (!readToken()) {
      created = omniKeys.createApiKey(
        `freeclaude-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`
      );
    } else {
      created = omniKeys.ensureApiKey(
        `freeclaude-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`
      );
    }
    const model = readActiveModel() || "kiro/claude-sonnet-4.5";
    writeSettings(model, created.key);
    keyIssued = { masked: created.masked, reused: Boolean(created.reused), fresh: !created.reused };
  } catch (err) {
    keyIssued = { error: String(err.message || err) };
  }

  // Before waiting on the catalog: a hidden model or a restricted key would keep
  // /v1/models empty for the whole timeout and look like a failed login.
  const repaired = (await autoRepairInstall())?.fixed || [];

  while (Date.now() - started < timeoutMs) {
    try {
      const h = omniKeys.healKiroConnections();
      healed = Math.max(healed, Number(h?.healed || 0));
    } catch {
      /* ignore */
    }
    try {
      // Drop the previous account's cooldown so a fresh Builder ID is not sticky-limited.
      omniKeys.clearKiroCooldowns();
    } catch {
      /* ignore */
    }

    // OmniRoute is writing the connection right now, so the cached HTTP answer is stale
    // by definition — ask it fresh on every lap.
    invalidateKiroHttpCache();
    const state = await resolveKiroConnected({ maxAgeMs: 0 });
    connected = state.connected;

    modelsCount = await countKiroModels();
    if (connected && modelsCount > 0) break;
    await sleep(900);
  }

  try {
    omniKeys.clearKiroCooldowns();
  } catch {
    /* ignore */
  }
  // Quota cache was wiped by the logout restart; do not kill OmniRoute again here —
  // a second restart raced the fresh OAuth write and left :20128 occupied/dead.
  await nudgeOmniCaches().catch(() => false);
  invalidateKiroHttpCache();
  const finalState = await resolveKiroConnected({ maxAgeMs: 0 });
  connected = finalState.connected;
  modelsCount = await countKiroModels();

  return {
    keyIssued,
    ready: Boolean(connected && modelsCount > 0),
    kiroConnected: Boolean(connected),
    modelsCount,
    healed,
    repaired,
    waitedMs: Date.now() - started,
  };
}

function clearKiroOAuthSession() {
  kiroOAuth.cookie = null;
  kiroOAuth.deviceCode = null;
  kiroOAuth.codeVerifier = null;
  kiroOAuth.extraData = null;
  kiroOAuth.expiresAt = 0;
  kiroOAuth.userCode = null;
  kiroOAuth.verificationUri = null;
  kiroOAuth.verificationUriComplete = null;
}

function openUrlApp(url) {
  const browser = findBrowser();
  if (browser) {
    try {
      const child = spawn(browser, [`--app=${url}`, "--new-window", "--window-size=980,820"], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } else {
      const child = spawn(
        process.env.ComSpec || "cmd.exe",
        ["/c", "start", "", url],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      child.on("error", () => {});
      child.unref();
    }
  } catch (err) {
    console.error("openUrlApp failed:", err && err.message ? err.message : err);
  }
  return true;
}

/** AWS session: opens in active browser. */
function openAwsAuthWindow(deviceUrl, { fresh = false } = {}) {
  const target = deviceUrl || AWS_PORTAL_URL;
  if (!fresh || process.platform === "darwin") {
    openUrlApp(target);
    return { ok: true, mode: "browser", url: target };
  }

  const browser = findBrowser();
  if (!browser) {
    openUrlApp(target);
    return { ok: true, mode: "shell", url: target };
  }

  const profileDir = path.join(os.tmpdir(), `freeclaude-aws-${Date.now()}`);
  fs.mkdirSync(profileDir, { recursive: true });
  spawn(
    browser,
    [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      `--app=${target}`,
      "--window-size=980,820",
    ],
    { detached: true, stdio: "ignore" }
  ).unref();

  // Best-effort cleanup of old ephemeral profiles (older than 2 days)
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith("freeclaude-aws-")) continue;
      const full = path.join(tmp, name);
      try {
        const st = fs.statSync(full);
        if (Date.now() - st.mtimeMs > 2 * 24 * 60 * 60 * 1000) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  return { ok: true, mode: "fresh-profile", url: target, profileDir };
}

function openAwsSignOut() {
  return openAwsAuthWindow(AWS_SIGNOUT_URL, { fresh: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkAccess(force = false) {
  const now = Date.now();
  if (!force && accessCache.checkedAt && now - accessCache.checkedAt < 60_000) {
    return {
      allowed: accessCache.allowed,
      raw: accessCache.raw,
      telegram: TELEGRAM_URL,
      cached: true,
      error: accessCache.error,
    };
  }
  try {
    const res = await fetch(ACCESS_URL, {
      headers: {
        "User-Agent": "FreeClaude/1.0",
        Accept: "text/plain",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = (await res.text()).trim();
    const token = text.split(/\s+/)[0] || "";
    const allowed = token === "1";
    accessCache.checkedAt = now;
    accessCache.allowed = allowed;
    accessCache.raw = token;
    accessCache.error = res.ok ? null : `HTTP ${res.status}`;
    return {
      allowed,
      raw: token,
      telegram: TELEGRAM_URL,
      cached: false,
      error: accessCache.error,
    };
  } catch (err) {
    // Сеть недоступна — не блокируем локальную работу, но отдаём ошибку для UI при желании
    accessCache.checkedAt = now;
    accessCache.allowed = true;
    accessCache.raw = accessCache.raw || "1";
    accessCache.error = String(err.message || err);
    return {
      allowed: true,
      raw: accessCache.raw,
      telegram: TELEGRAM_URL,
      cached: false,
      offline: true,
      error: accessCache.error,
    };
  }
}

function accessDeniedPayload() {
  return {
    ok: false,
    allowed: false,
    updateRequired: true,
    error: st("srv.updateRequired"),
    telegram: TELEGRAM_URL,
  };
}

function whichExists(file) {
  return Boolean(file && fs.existsSync(file));
}

function omniModuleEntry() {
  // macOS global install location (homebrew)
  if (process.platform !== "win32") {
    for (const p of [
      "/opt/homebrew/lib/node_modules/omniroute/bin/omniroute.mjs",
      "/usr/local/lib/node_modules/omniroute/bin/omniroute.mjs",
    ]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return path.join(npmBinDir(), "node_modules", "omniroute", "bin", "omniroute.mjs");
}

function isOmniRouteInstalled() {
  return whichExists(omniCmdPath()) || whichExists(omniModuleEntry());
}

function claudeNativeBin() {
  if (process.platform !== "win32") {
    // macOS: claude is an ELF/Mach-O binary, not a PE
    return claudeCmdPath();
  }
  return path.join(npmBinDir(), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
}

/** Real Claude Code binary — not the 500-byte postinstall stub. */
function isClaudeCodeReady() {
  const cmd = claudeCmdPath();
  if (!whichExists(cmd)) return false;

  // On macOS/Linux: if the binary exists and is executable, it's ready
  if (process.platform !== "win32") {
    try {
      const st = fs.statSync(cmd);
      return st.isFile() && st.size > 1000;
    } catch {
      return false;
    }
  }

  // On Windows: check for the real PE binary (not the tiny stub)
  const bin = claudeNativeBin();
  if (!whichExists(bin)) return false;
  try {
    const st = fs.statSync(bin);
    if (st.size < 100_000) return false;
    const fd = fs.openSync(bin, "r");
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x4d && buf[1] === 0x5a; // MZ
  } catch {
    return false;
  }
}


function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  // Explicit null/undefined removes a key (needed for apiKey clear).
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null) delete next[k];
  }
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2));
  return next;
}

/** Drop the saved OmniRoute key from FreeClaude + Claude Code settings. */
function clearLocalApiKey() {
  writeConfig({ apiKey: null });
  for (const file of [SETTINGS, path.join(PROFILE_DIR, "settings.json")]) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, "utf8"));
      if (settings?.env) {
        delete settings.env.ANTHROPIC_AUTH_TOKEN;
        delete settings.env.ANTHROPIC_MODEL;
        delete settings.env.ANTHROPIC_BASE_URL;
        fs.writeFileSync(file, JSON.stringify(settings, null, 2));
      }
    } catch {
      /* ignore */
    }
  }
}

/** English until the user picks otherwise in Settings. */
function currentLang() {
  return i18n.normalizeLang(readConfig().lang);
}

/** Server-side translate: every user-facing string the API or the install log emits. */
function st(key, vars) {
  return i18n.t(currentLang(), key, vars);
}

/** Short colored CMD lines (Windows Terminal / modern conhost). */
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};
function enableAnsiConsole() {
  try {
    if (process.platform === "win32" && process.stdout.isTTY) {
      // Node 22+ often has VT already; this is a no-op fallback hint for older hosts.
      process.stdout.write("");
    }
  } catch {
    /* ignore */
  }
}
function conSay(kind, text) {
  const color =
    kind === "ok"
      ? ANSI.green
      : kind === "warn"
        ? ANSI.yellow
        : kind === "err"
          ? ANSI.red
          : kind === "dim"
            ? ANSI.dim
            : ANSI.cyan;
  const line = `${color}${text}${ANSI.reset}`;
  if (kind === "err") console.error(line);
  else console.log(line);
}
function isNoisyOmniLine(line) {
  const s = String(line || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
  if (!s) return true;
  if (/^[_/\\| ]{8,}$/.test(s)) return true;
  if (/Loaded env from/i.test(s)) return true;
  if (/Starting server/i.test(s)) return true;
  if (/OmniRoute is running/i.test(s)) return true;
  if (/Dashboard:|API Base:|Point your CLI|Press Ctrl/i.test(s)) return true;
  if (/^v\d+\.\d+/.test(s)) return true;
  if (/____|\/ __ \\|\\| __ \||\\|__\||\\\\____\//.test(s)) return true;
  return false;
}

function readToken() {
  const cfg = readConfig();
  const fromConfig = String(cfg.apiKey || "").trim();
  if (fromConfig) return TOKEN_RE.test(fromConfig) ? fromConfig : "";
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    const fromSettings = String(s?.env?.ANTHROPIC_AUTH_TOKEN || "").trim();
    return TOKEN_RE.test(fromSettings) ? fromSettings : "";
  } catch {
    return "";
  }
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 10) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function readActiveModel() {
  let raw = "";
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    raw = s?.model || s?.env?.ANTHROPIC_MODEL || "";
  } catch {
    raw = readConfig().model || "";
  }
  const value = String(raw).trim();
  return MODEL_RE.test(value) ? value : "";
}

async function isOmniUp() {
  // System HTTP_PROXY can make undici fetch to 127.0.0.1 hang (ETIMEDOUT) while
  // OmniRoute is fine — Byba's machine showed that. Prefer raw http (ignores proxy).
  ensureLocalhostNoProxy();

  for (const host of OMNI_HOSTS) {
    for (const pathname of ["/api/health", "/api/monitoring/health", "/"]) {
      if (await httpProbeOmni(host, pathname)) return true;
    }
    if (await canTcpOmni(host, 700)) return true;
  }
  return false;
}

function httpProbeOmni(host, pathname) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host,
        port: OMNI_PORT,
        path: pathname,
        timeout: 2000,
        headers: { Connection: "close" },
      },
      (res) => {
        res.resume();
        resolve(Number(res.statusCode) > 0);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      resolve(false);
    });
  });
}

function canTcpOmni(host = "127.0.0.1", timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: OMNI_PORT });
    const done = (ok) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Strip corporate proxy vars so OmniRoute and our health probes can reach loopback. */
function ensureLocalhostNoProxy() {
  const extra = "127.0.0.1,localhost,::1";
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const cur = String(process.env[key] || "");
    if (!/127\.0\.0\.1/i.test(cur)) {
      process.env[key] = cur ? `${cur},${extra}` : extra;
    }
  }
}

function omniChildEnv() {
  ensureLocalhostNoProxy();
  const env = {
    ...process.env,
    PATH: `${nodeDir()};${npmBinDir()};${enrichedPath()}`,
    NO_PROXY: process.env.NO_PROXY || "127.0.0.1,localhost,::1",
    no_proxy: process.env.no_proxy || process.env.NO_PROXY || "127.0.0.1,localhost,::1",
    // Prefer an explicit loopback bind — some Windows setups + proxy break "localhost".
    HOST: "127.0.0.1",
    PORT: String(OMNI_PORT),
  };
  // Do not let a machine-wide proxy swallow OmniRoute's self-checks on :20128.
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete env[key];
  }
  return env;
}

/** Prefer Node 22/23 for OmniRoute when the default is 24+ (seen hanging on :20128 bind). */
function resolveNodeForOmni() {
  const primary = resolveNode();
  const primaryMajor = nodeMajorVersion(primary);
  if (primaryMajor !== null && primaryMajor >= MIN_NODE_MAJOR && primaryMajor < 24) {
    return primary;
  }
  const candidates = [
    path.join(NODE_DIR_DEFAULT, "node.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "node", "node.exe"),
    path.join("C:\\Program Files", "nodejs", "node.exe"),
    path.join("D:\\Program Files", "nodejs", "node.exe"),
    whereOnPath("node.exe"),
  ];
  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const major = nodeMajorVersion(candidate);
      if (major !== null && major >= MIN_NODE_MAJOR && major < 24) {
        if (candidate !== primary) {
          appLog.info(`OmniRoute: using Node ${major} (${candidate}) instead of ${primaryMajor || "?"}`);
        }
        return candidate;
      }
    } catch {
      /* ignore */
    }
  }
  return primary;
}

let omniChild = null;
let omniStopping = false;
let omniOwned = false; // true if FreeClaude should kill :20128 on exit
/** Single-flight lock so parallel ensureOmni calls cannot kill each other's spawn. */
let ensureOmniLock = null;

function killOmniRouteListeners() {
  // Drop our handle first so startOmniRoute will not think the child is still alive.
  const previous = omniChild;
  omniChild = null;
  if (previous && previous.pid) {
    try {
      spawnSync("taskkill", ["/PID", String(previous.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 8000,
      });
    } catch {
      try {
        previous.kill();
      } catch {
        /* ignore */
      }
    }
  }

  // Всегда добиваем слушателей :20128 и node/omniroute serve — иначе сироты жрут CPU/лагает мышь
  try {
    // Matching a bare 'serve' here used to hit our own `node server.js` (and any
    // unrelated `npm run serve`), so only 'omniroute' and the port itself qualify.
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$self = ${process.pid}`,
      "$pids = @()",
      `Get-NetTCPConnection -LocalPort ${OMNI_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $pids += $_.OwningProcess }`,
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
      "  ($_.Name -match '^(node|omniroute)') -and ($_.CommandLine -match 'omniroute')",
      "} | ForEach-Object { $pids += $_.ProcessId }",
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
      "  $_.ExecutablePath -and ($_.ExecutablePath -match 'omniroute')",
      "} | ForEach-Object { $pids += $_.ProcessId }",
      "$pids = $pids | Where-Object { $_ -and $_ -gt 0 -and $_ -ne $self } | Select-Object -Unique",
      "foreach ($procId in $pids) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }",
    ].join("; ");
    spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15000,
    });
  } catch {
    /* ignore */
  }

  // Fallback без PowerShell NetTCP
  try {
    spawnSync(
      process.env.ComSpec || "cmd.exe",
      [
        "/d",
        "/c",
        `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${OMNI_PORT} ^| findstr LISTENING') do taskkill /F /PID %a >nul 2>&1`,
      ],
      { windowsHide: true, stdio: "ignore", timeout: 8000 }
    );
  } catch {
    /* ignore */
  }

  // No taskkill fallback by image name here: COMMANDLINE is not a real taskkill
  // filter, so it would degrade into killing every node.exe on the machine.
  try {
    spawnSync("taskkill", ["/F", "/IM", "omniroute.exe"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 8000,
    });
  } catch {
    /* ignore */
  }
}

function stopOmniRoute() {
  if (omniStopping) return;
  omniStopping = true;
  try {
    killOmniRouteListeners();
  } finally {
    omniOwned = false;
    omniStopping = false;
  }
}

function killOrphanOmniRoute() {
  // Перед стартом убиваем любой сиротский OmniRoute от прошлого запуска
  killOmniRouteListeners();
}

function spawnOmniRouteWatcher() {
  if (process.env.FREECLAUDE_NO_WATCHDOG === "1") return;
  if (process.platform !== "win32") return; // powershell watcher is Windows-only
  const parentPid = process.pid;
  const scriptPath = path.join(os.tmpdir(), `freeclaude-omni-watcher-${parentPid}.ps1`);
  const script = `
$parentPid = ${parentPid}
while ($true) {
  try {
    $null = Get-Process -Id $parentPid -ErrorAction Stop
    Start-Sleep -Seconds 2
  } catch {
    break
  }
}
$ErrorActionPreference = 'SilentlyContinue'
Get-NetTCPConnection -LocalPort 20128 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.Name -match '^(node|omniroute)') -and ($_.CommandLine -match 'omniroute') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -match 'omniroute') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
try { Remove-Item -Path '${scriptPath.replace(/\\/g, "\\\\")}' -Force } catch {}
`;
  try {
    fs.writeFileSync(scriptPath, script, "utf8");
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    appLog.info(`OmniRoute watcher spawned (PID ${child.pid})`);
  } catch (err) {
    appLog.error(`OmniRoute watcher spawn failed: ${err && err.message ? err.message : err}`);
  }

  // Cleanup old watcher scripts (older than 2 days)
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith("freeclaude-omni-watcher-")) continue;
      const full = path.join(tmp, name);
      try {
        const st = fs.statSync(full);
        if (Date.now() - st.mtimeMs > 2 * 24 * 60 * 60 * 1000) {
          fs.rmSync(full, { force: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function installOmniShutdownHooks() {
  if (installOmniShutdownHooks.done) return;
  installOmniShutdownHooks.done = true;
  const bye = () => {
    try {
      if (omniOwned || omniChild) stopOmniRoute();
    } catch {
      /* ignore */
    }
  };
  process.on("exit", bye);
  // Windows console close / pkg exit
  try {
    process.on("beforeExit", bye);
  } catch {
    /* ignore */
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(sig, () => {
        bye();
        process.exit(0);
      });
    } catch {
      /* unsupported on platform */
    }
  }
  // Last-chance: poll if parent gone (when launched oddly)
  try {
    setInterval(() => {
      /* keep event loop aware; actual kill is on signals/exit */
    }, 60_000).unref?.();
  } catch {
    /* ignore */
  }
}

function startOmniRoute(opts = {}) {
  const mjs = omniModuleEntry();
  const omniCmd = omniCmdPath();
  if (!whichExists(mjs) && !whichExists(omniCmd)) return false;

  const env = omniChildEnv();

  // OmniRoute — дочерний процесс FreeClaude (не detached-сирота).
  // При закрытии FreeClaude убиваем OmniRoute.
  try {
    if (!opts.force && omniChild && omniChild.exitCode == null) {
      return false;
    }
    // After a forced restart the previous handle must not block a new spawn.
    if (opts.force) omniChild = null;

    installOmniShutdownHooks();
    const proxyWasSet = Boolean(
      process.env.HTTP_PROXY ||
        process.env.HTTPS_PROXY ||
        process.env.ALL_PROXY ||
        process.env.http_proxy ||
        process.env.https_proxy
    );
    appLog.info(`OmniRoute start ${OMNI}${proxyWasSet ? " (proxy cleared for child)" : ""}`);

    let child;
    const nodeBin = resolveNodeForOmni();
    // Pipe stdout/stderr so exit code 1 is explainable in the Logs tab.
    const spawnOpts = {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    };
    if (nodeBin && whichExists(mjs)) {
      child = spawn(nodeBin, [mjs, "serve", "--no-open"], {
        ...spawnOpts,
        cwd: process.platform === "win32" ? path.join(npmBinDir(), "node_modules", "omniroute") : path.dirname(path.dirname(mjs)),
      });
    } else if (process.platform === "win32") {
      child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", omniCmd, "serve", "--no-open"], spawnOpts);
    } else {
      child = spawn(omniCmd, ["serve", "--no-open"], spawnOpts);
    }
    omniChild = child;
    omniOwned = true;

    let errBuf = "";
    let outBuf = "";
    const flushSide = (kind, chunk) => {
      const text = String(chunk || "");
      if (kind === "err") errBuf = (errBuf + text).slice(-8000);
      else outBuf = (outBuf + text).slice(-4000);
      const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim());
      for (const line of lines.slice(0, 40)) {
        if (isNoisyOmniLine(line)) continue;
        // Real problems only — ASCII banner / "running!" spam stays out of the log.
        if (kind === "err") appLog.warn(`OmniRoute: ${line.slice(0, 500)}`);
        else appLog.debug(`OmniRoute: ${line.slice(0, 500)}`);
      }
    };
    if (child.stderr) child.stderr.on("data", (d) => flushSide("err", d));
    if (child.stdout) child.stdout.on("data", (d) => flushSide("out", d));

    child.on("error", (err) => {
      conSay("err", st("con.line.omniOff"));
      appLog.error(`OmniRoute spawn error: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (omniChild === child) omniChild = null;
      const tail = (errBuf || outBuf)
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split(/\r\n|\n|\r/)
        .filter((l) => l.trim() && !isNoisyOmniLine(l))
        .join("\n")
        .trim()
        .slice(-800);
      const msg = `OmniRoute stopped (code ${code}${signal ? ` signal=${signal}` : ""})${tail ? ` :: ${tail}` : ""}`;
      // Restarts intentionally kill the child — keep that out of the CMD window.
      if (code && code !== 0) appLog.error(msg);
      else appLog.info(msg);
    });
    return true;
  } catch (err) {
    conSay("err", st("con.line.omniOff"));
    appLog.error(`OmniRoute start failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

async function ensureOmni(timeoutMs = 90000, opts = {}) {
  // Serialize: install + main bootstrap + logout restart used to race and kill each other.
  if (ensureOmniLock) {
    appLog.info("OmniRoute ensure: waiting for in-flight ensure");
    return ensureOmniLock;
  }
  ensureOmniLock = ensureOmniInner(timeoutMs, opts).finally(() => {
    ensureOmniLock = null;
  });
  return ensureOmniLock;
}

async function ensureOmniInner(timeoutMs = 90000, opts = {}) {
  try {
    installOmniShutdownHooks();
    if (await isOmniUp()) {
      // Даже чужой/старый OmniRoute считаем «нашим» для cleanup при выходе
      omniOwned = true;
      if (opts.liveLog) pushLog(st("log.omniAlreadyOnline"));
      else appLog.info("OmniRoute already online");
      return true;
    }
    if (!isOmniRouteInstalled()) {
      appLog.warn("OmniRoute ensure: not installed");
      return false;
    }

    // Port occupied by someone else (orphan). If our child is still booting, wait — do not kill it.
    if (await isOmniPortBusy()) {
      const oursAlive = Boolean(omniChild && omniChild.exitCode == null);
      if (oursAlive) {
        appLog.info("OmniRoute ensure: port busy but our child is starting — waiting");
      } else {
        if (opts.liveLog) pushLog(st("log.omniPortBusy"));
        else appLog.warn("OmniRoute ensure: port 20128 busy — freeing orphan");
        killOmniRouteListeners();
        await waitForOmniPortFree(15000);
      }
    }

    if (opts.liveLog) pushLog(st("log.omniStarting"));
    else appLog.info("OmniRoute ensure: starting");
    if (!(omniChild && omniChild.exitCode == null)) {
      startOmniRoute({ force: Boolean(opts.forceStart) });
    }
    omniOwned = true;
    const start = Date.now();
    let lastBeat = 0;
    let retriedSpawn = false;
    while (Date.now() - start < timeoutMs) {
      if (opts.checkCancel && installState.cancelRequested) {
        if (opts.liveLog) pushLog(st("log.omniWaitCancelled"));
        appLog.warn("OmniRoute ensure: wait cancelled");
        return false;
      }
      await sleep(500);
      if (await isOmniUp()) {
        const sec = Math.round((Date.now() - start) / 1000);
        if (opts.liveLog) pushLog(st("log.omniOnlineIn", { sec }));
        else appLog.info(`OmniRoute ensure: online in ${sec}s`);
        return true;
      }
      // Respawn only if the child actually died — OmniRoute often needs >15s on first boot.
      const childDead = !omniChild || omniChild.exitCode != null;
      if (!retriedSpawn && childDead && Date.now() - start > 5000 && !(await isOmniUp())) {
        retriedSpawn = true;
        if (opts.liveLog) pushLog(st("log.omniRetryStart"));
        else appLog.warn("OmniRoute ensure: child exited — respawn");
        killOmniRouteListeners();
        await waitForOmniPortFree(10000);
        startOmniRoute({ force: true });
      }
      if (opts.liveLog) {
        const sec = Math.round((Date.now() - start) / 1000);
        if (sec >= 3 && sec - lastBeat >= 5) {
          lastBeat = sec;
          pushLog(st("log.omniWaiting", { sec }));
        }
      }
    }
    if (opts.liveLog) pushLog(st("log.omniTimeout"));
    const portBusy = await isOmniPortBusy();
    const childCode = omniChild && omniChild.exitCode != null ? omniChild.exitCode : null;
    const childAlive = Boolean(omniChild && omniChild.exitCode == null);
    appLog.error(
      `OmniRoute ensure: timeout after ${timeoutMs}ms portBusy=${portBusy} childAlive=${childAlive} childExit=${childCode}`
    );
    if (opts.liveLog) {
      if (portBusy) pushLog(st("log.omniTimeoutPortBusy"));
      else if (childAlive) {
        const proxyHint =
          process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy
            ? st("log.omniTimeoutProxy")
            : st("log.omniTimeoutChildAlive");
        pushLog(proxyHint);
      } else if (childCode != null) pushLog(st("log.omniTimeoutChildExit", { code: childCode }));
      else pushLog(st("log.omniTimeoutHint"));
    }
    return false;
  } catch (err) {
    console.error("ensureOmni failed:", err && err.message ? err.message : err);
    if (opts.liveLog) pushLog(`OmniRoute: ${err && err.message ? err.message : err}`);
    appLog.error(`ensureOmni failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}


function assertSafeModel(model) {
  const value = String(model || "").trim();
  if (!MODEL_RE.test(value)) throw new Error(st("srv.badModel"));
  return value;
}

function assertSafeToken(token) {
  const value = String(token || "").trim();
  if (!TOKEN_RE.test(value)) throw new Error(st("srv.badToken"));
  return value;
}

/**
 * Manual component paths are interpolated into the generated .bat, so the same rule as for
 * the model and the token applies: anything that could start a second command is rejected.
 */
function assertSafePath(value, label) {
  const p = String(value || "").trim();
  const re = process.platform === "win32" ? PATH_RE : POSIX_PATH_RE;
  if (!re.test(p)) throw new Error(st("srv.badPath", { label: label ? ` (${label})` : "", path: p }));
  return p;
}

/**
 * cmd.exe treats a UTF-8 BOM as garbage on the first line (mojibake before @echo), so batch
 * files must be plain ASCII. Non-ASCII absolute paths are rewritten to %APPDATA%
 * / %USERPROFILE% / %ProgramFiles% in writeBat() via bat-path.js — never embed them.
 */
function writeCmdFile(file, body) {
  const text = String(body || "").replace(/^\uFEFF/, "");
  if (/[^\x00-\x7F]/.test(text)) {
    throw new Error(
      st("srv.badPath", {
        label: " (batch)",
        path: "non-ASCII in .cmd — use %APPDATA% paths",
      })
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  if (process.platform !== "win32") {
    try { fs.chmodSync(file, 0o755); } catch { /* ignore */ }
  }
}

/**
 * Launch Claude Code directly. Going through `omniroute launch` used to fail with
 * "path not found" on machines where the nested .bat path or claude.cmd lookup broke
 * (Cyrillic usernames, missing PATH after the omniroute shim, etc.).
 *
 * Absolute paths with Cyrillic usernames break cmd.exe — bake
 * %APPDATA% / %USERPROFILE% / %ProgramFiles% instead (see bat-path.js) and write
 * the .bat as plain UTF-8 without a BOM (a BOM makes cmd treat @echo as garbage).
 *
 * Claude itself is checked at launch time, not here: writeSettings also runs when the
 * user only has a key and has not installed Claude Code yet.
 */
function writeBat(model, token) {
  assertSafeModel(model);
  assertSafeToken(token);
  const nodeAbs = assertSafePath(nodeDir(), "Node.js");
  const npmAbs = assertSafePath(npmBinDir(), "npm");
  const profileAbs = assertSafePath(PROFILE_DIR, "Claude profile");

  const node = toBatPathSafe(nodeAbs, "%ProgramFiles%\\nodejs");
  const npm = toBatPathSafe(npmAbs, "%APPDATA%\\npm");
  const profile = toBatPathSafe(profileAbs, "%USERPROFILE%\\.claude\\profiles\\active-freeclaude");

  let claudeAbs = String(claudeCmdPath() || "").trim();
  if (!PATH_RE.test(claudeAbs)) claudeAbs = "";
  const claude = claudeAbs
    ? toBatPathSafe(claudeAbs, "%APPDATA%\\npm\\claude.cmd")
    : "%APPDATA%\\npm\\claude.cmd";

  const bat = `@echo off
setlocal EnableExtensions
set "PATH=${node};${npm};%PATH%"

set "ANTHROPIC_BASE_URL=${OMNI}"
set "ANTHROPIC_AUTH_TOKEN=${token}"
set "ANTHROPIC_MODEL=${model}"
set "OMNIROUTE_API_KEY=${token}"
set "CLAUDE_CONFIG_DIR=${profile}"

echo Checking OmniRoute...
curl.exe -s -o NUL "${OMNI}/api/monitoring/health"
if errorlevel 1 (
  echo.
  echo [ERROR] OmniRoute offline.
  echo Start FreeClaude.exe first - it brings OmniRoute up.
  echo.
  pause
  exit /b 1
)

where claude.cmd >nul 2>&1
if errorlevel 1 (
  if not exist "${claude}" (
    echo [ERROR] Claude Code not found.
    echo Install it from FreeClaude Settings, or set the path with the gear icon.
    echo.
    pause
    exit /b 1
  )
)

echo Starting Claude Code with ${model}...
if exist "${claude}" (
  call "${claude}" %*
) else (
  call claude.cmd %*
)
set "EC=%ERRORLEVEL%"
if not "%EC%"=="0" (
  echo.
  echo [ERROR] Claude exit code: %EC%
  pause
)
exit /b %EC%
`;

  if (process.platform !== "win32") {
    // macOS / Linux — write a proper bash script instead of .bat
    const claudeBin = String(claudeCmdPath() || "").trim() || "claude";
    const bashScript = `#!/usr/bin/env bash
set -e

export ANTHROPIC_BASE_URL="${OMNI}"
export ANTHROPIC_AUTH_TOKEN="${token}"
export ANTHROPIC_MODEL="${model}"
export OMNIROUTE_API_KEY="${token}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "Model: ${model}"
echo "Starting Claude Code..."

if ! curl -s -o /dev/null "${OMNI}/api/monitoring/health" 2>/dev/null; then
  echo "[ERROR] OmniRoute offline. Open the FreeClaude panel first."
  exit 1
fi

CLAUDE_BIN=""
for c in "${claudeBin}" claude /opt/homebrew/bin/claude /usr/local/bin/claude; do
  if [ -n "$c" ] && command -v "$c" &>/dev/null 2>&1; then
    CLAUDE_BIN="$c"
    break
  fi
done
if [ -z "$CLAUDE_BIN" ]; then
  echo "[ERROR] Claude Code not found. Install it from FreeClaude Settings."
  exit 1
fi

exec "$CLAUDE_BIN" "$@"
`;
    writeCmdFile(FREECLAUDE, bashScript);
  } else {
    writeCmdFile(FREECLAUDE, bat);
  }
}

function writeSettings(model, token) {
  assertSafeModel(model);
  assertSafeToken(token);
  const haiku = /haiku/i.test(model) ? model : "kiro/claude-haiku-4.5";
  const settings = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    model,
    env: {
      // Without this Claude Code talks to api.anthropic.com and rejects the OmniRoute key.
      ANTHROPIC_BASE_URL: OMNI,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: haiku,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "190000",
    },
  };
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROFILE_DIR, "settings.json"), JSON.stringify(settings, null, 2));
  writeConfig({ apiKey: token, model });
  writeBat(model, token);
}

/**
 * An OmniRoute that was already installed before FreeClaude can be configured in
 * ways that quietly hide Kiro models or reject our key. omni-doctor finds those
 * and repairs what it owns; the leftovers need a key, which only this side can write.
 *
 * The synced model catalog is deliberately never refreshed here: OmniRoute prefers
 * a synced catalog over its built-in registry, so a sync we triggered could hide
 * more models than it restores. Stale entries are dropped instead.
 */
/**
 * OmniRoute caches settings, connections and the model catalog in memory, so a repair
 * written straight to SQLite stays invisible for up to a minute. An empty settings PATCH
 * is its own cache-bust: it writes nothing but bumps the catalog version.
 * The per-key permission cache has no such hook and expires on its own within a minute.
 */
async function nudgeOmniCaches() {
  try {
    const res = await fetch(`${OMNI}/api/settings`, {
      method: "PATCH",
      headers: { Cookie: await omniDashboardCookie(), "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function runDoctor({ repair = false, codes = null } = {}) {
  let report;
  try {
    report = repair
      ? omniKeys.repairInstall(readToken(), codes)
      : { fixed: [], failed: [], pending: [] };
  } catch (err) {
    return { ok: false, error: String(err.message || err), findings: [], fixed: [] };
  }

  const fixed = [...report.fixed];

  // key-none / key-unknown / key-dead all mean Claude Code holds a key OmniRoute
  // will not accept. Reuse our existing key if there is one, otherwise mint one.
  if (repair && report.pending.some((c) => c.startsWith("key-"))) {
    try {
      const created = omniKeys.ensureApiKey("freeclaude");
      writeSettings(readActiveModel() || "kiro/claude-sonnet-4.5", created.key);
      fixed.push("key-reissued");
      // The reused key may carry restrictions of its own.
      const second = omniKeys.repairInstall(created.key, null);
      fixed.push(...second.fixed);
    } catch (err) {
      report.failed.push({ code: "key-reissue", error: String(err.message || err) });
    }
  }

  if (fixed.length) await nudgeOmniCaches();

  let after;
  try {
    after = omniKeys.diagnoseInstall(readToken());
  } catch (err) {
    return { ok: false, error: String(err.message || err), findings: [], fixed };
  }

  return {
    ok: after.ok,
    findings: after.findings,
    autoFixable: after.autoFixable,
    fixed,
    failed: report.failed,
    dbPath: omniKeys.DB_PATH,
  };
}

/** Best-effort pass on startup and after a Kiro login; never blocks either. */
async function autoRepairInstall() {
  try {
    const report = await runDoctor({ repair: true });
    if (report.fixed.length) console.log(st("con.doctorFixed", { list: report.fixed.join(", ") }));
    return report;
  } catch {
    return null;
  }
}

async function runCmd(command, args, opts = {}) {
  if (opts.track && installState.cancelRequested) throw new Error(st("srv.installStopped"));

  const nodeBin = resolveNode();
  const npmBin = resolveNpm();
  const env = {
    ...process.env,
    PATH: `${nodeDir()};${npmBinDir()};${enrichedPath()}`,
    ...(opts.env || {}),
  };

  let file = command;
  let finalArgs = args;
  const npmCli = path.join(nodeDir(), "node_modules", "npm", "bin", "npm-cli.js");
  if (
    process.platform === "win32" &&
    nodeBin &&
    ((npmBin && command === npmBin) || /[\\/]npm\.cmd$/i.test(String(command))) &&
    whichExists(npmCli)
  ) {
    file = nodeBin;
    finalArgs = [npmCli, ...args];
  } else if (process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command))) {
    file = process.env.ComSpec || "cmd.exe";
    finalArgs = ["/d", "/c", command, ...args];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(file, finalArgs, {
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd || undefined,
    });
    if (opts.track) installState.child = child;

    let stdout = "";
    let stderr = "";
    let carry = "";
    let settled = false;
    let lastLogged = "";

    const flushLogLine = (raw) => {
      if (!opts.liveLog) return;
      const t = String(raw || "")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/[^\S\r\n]+/g, " ")
        .trim();
      if (!t) return;
      if (t === lastLogged) return;
      lastLogged = t;
      pushLog(t);
    };

    const timeout = setTimeout(() => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          child.kill();
        }
      } catch {
        /* ignore */
      }
      if (!settled) {
        settled = true;
        if (opts.track) installState.child = null;
        reject(new Error(st("srv.cmdTimeout", { sec: Math.round((opts.timeout || 1000 * 60 * 8) / 1000) })));
      }
    }, opts.timeout || 1000 * 60 * 8);

    const onChunk = (buf, isErr) => {
      const text = buf.toString("utf8");
      if (isErr) stderr += text;
      else stdout += text;
      if (!opts.liveLog) return;
      const mixed = carry + text;
      const parts = mixed.split(/\r\n|\n|\r/);
      carry = parts.pop() || "";
      for (const line of parts) flushLogLine(line);
    };

    child.stdout.on("data", (d) => onChunk(d, false));
    child.stderr.on("data", (d) => onChunk(d, true));

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (opts.track) installState.child = null;
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (opts.track) installState.child = null;
      if (carry) flushLogLine(carry);
      if (installState.cancelRequested) {
        reject(new Error(st("srv.installStopped")));
        return;
      }
      const out = `${stdout || ""}${stderr || ""}`.trim();
      if (code && code !== 0) {
        const err = new Error(
          out.slice(0, 400) || st("srv.cmdFailed", { code, signal: signal ? ` (${signal})` : "" })
        );
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(out);
    });
  });
}

function requestStopInstall() {
  installState.cancelRequested = true;
  const child = installState.child;
  if (child && child.pid) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
    pushLog(st("log.stopInstall"));
    return { ok: true, stopped: true, message: st("srv.stoppingNow") };
  }
  // Шаг без child (например ожидание OmniRoute) — флаг cancel уже выставлен
  pushLog(st("log.stopStep"));
  return { ok: true, stopped: true, message: st("srv.stoppingWait") };
}

function pushLog(line) {
  const text = String(line == null ? "" : line);
  installState.log.push(`[${new Date().toLocaleTimeString()}] ${text}`);
  if (installState.log.length > 800) installState.log.shift();
  // Persistent file keeps every line for the Logs tab / download — no ring trim.
  try {
    appLog.info(text);
  } catch {
    /* ignore */
  }
}

function assertNotCancelled() {
  if (installState.cancelRequested) throw new Error(st("srv.installStopped"));
}

/**
 * Accepts the exe itself or the folder containing it, because people copy either one out
 * of Explorer. Returns "" to clear the override.
 */
function validateManualPath(key, raw) {
  const spec = PATH_KEYS[key];
  if (!spec) throw new Error(st("srv.unknownComponent"));
  const input = String(raw || "")
    .trim()
    .replace(/^"+|"+$/g, "");
  if (!input) return "";

  assertSafePath(input, spec.label);
  const file = existingFile(input) || existingFile(path.join(input, spec.exe));
  if (!file) throw new Error(st("srv.pathNotFound", { exe: spec.exe }));
  if (path.basename(file).toLowerCase() !== spec.exe.toLowerCase()) {
    throw new Error(st("srv.pathWrongExe", { exe: spec.exe, actual: path.basename(file) }));
  }

  if (key === "node") {
    const major = nodeMajorVersion(file);
    if (major === null) throw new Error(st("srv.nodeNotWorking"));
    if (major < MIN_NODE_MAJOR) throw new Error(st("srv.nodeTooOld", { min: MIN_NODE_MAJOR, actual: major }));
  }
  return file;
}

function manualPathsView() {
  const saved = configuredPaths();
  const resolved = {
    node: resolveNode(),
    npm: resolveNpm(),
    omniroute: whichExists(omniCmdPath()) ? omniCmdPath() : null,
    claude: whichExists(claudeCmdPath()) ? claudeCmdPath() : null,
  };
  const out = {};
  for (const key of Object.keys(PATH_KEYS)) {
    out[key] = {
      label: PATH_KEYS[key].label,
      exe: PATH_KEYS[key].exe,
      manual: String(saved[key] || ""),
      resolved: resolved[key] || "",
    };
  }
  return out;
}

async function getSetupStatus() {
  invalidateToolCache();
  const nodeBin = resolveNode();
  const npmBin = resolveNpm();
  let nodeVersion = null;
  if (nodeBin) {
    try {
      nodeVersion = (await runCmd(nodeBin, ["-v"])).trim();
    } catch {
      nodeVersion = null;
    }
  }

  const omniPath = omniCmdPath();
  const claudePath = claudeCmdPath();
  const token = readToken();
  const omniRunning = await isOmniUp();
  const claudeOk = isClaudeCodeReady();

  const checks = {
    node: {
      ok: Boolean(nodeVersion),
      detail: nodeVersion ? `${nodeVersion}${nodeBin ? ` · ${nodeBin}` : ""}` : st("check.notFound"),
    },
    npm: { ok: Boolean(npmBin), detail: npmBin || st("check.notFound") },
    omniroute: {
      ok: whichExists(omniPath),
      detail: whichExists(omniPath) ? st("check.installed") : st("check.notInstalled"),
    },
    claude: {
      ok: claudeOk,
      detail: claudeOk
        ? st("check.installed")
        : whichExists(claudePath)
          ? st("check.brokenStub")
          : st("check.notInstalled"),
    },
    omniRunning: { ok: omniRunning, detail: omniRunning ? "online" : "offline" },
    token: { ok: Boolean(token), detail: token ? maskToken(token) : st("check.noKey"), masked: maskToken(token) },
  };

  // Lets the UI mark which components are pinned to a hand-picked path.
  const saved = configuredPaths();
  for (const key of Object.keys(PATH_KEYS)) {
    if (checks[key]) checks[key].manual = Boolean(saved[key]);
  }

  const ready = checks.node.ok && checks.npm.ok && checks.omniroute.ok && checks.claude.ok && checks.token.ok;
  return { checks, ready, activeModel: readActiveModel(), install: { ...installState, child: undefined, log: installState.log.slice() } };
}

/**
 * The WindowsApps alias is missing on LTSC/Server images and on machines where App
 * Installer was never provisioned, which is what made the installer dead-end.
 */
function resolveWinget() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "winget.exe"),
    whereOnPath("winget.exe"),
  ];
  try {
    const store = path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
    for (const name of fs.readdirSync(store)) {
      if (name.startsWith("Microsoft.DesktopAppInstaller_")) candidates.push(path.join(store, name, "winget.exe"));
    }
  } catch {
    // The store folder is ACL-locked for non-admins; the alias above covers the normal case.
  }
  for (const c of candidates) {
    if (existingFile(c)) return c;
  }
  return null;
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

async function runPowerShell(script, opts = {}) {
  return runCmd("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], opts);
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok) throw new Error(st("srv.httpStatus", { url, status: res.status }));
  const total = Number(res.headers.get("content-length") || 0);
  const file = fs.createWriteStream(dest);
  let done = 0;
  let lastPct = -10;
  try {
    for await (const chunk of res.body) {
      assertNotCancelled();
      done += chunk.length;
      if (!file.write(chunk)) await new Promise((r) => file.once("drain", r));
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (total && pct >= lastPct + 10) {
        lastPct = pct;
        pushLog(st("log.downloadProgress", { pct, mb: Math.round(done / 1048576) }));
      }
    }
  } finally {
    await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));
  }
}

function pickNodeLts(list) {
  for (const entry of list) {
    if (!entry || !entry.lts) continue;
    const major = Number(String(entry.version).replace(/^v/, "").split(".")[0]);
    if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return entry.version;
  }
  return null;
}

/**
 * Portable install into %LOCALAPPDATA% — no winget, no admin rights, and node-resolve
 * already looks in that folder.
 */
async function installNodeFromZip() {
  const index = await fetch("https://nodejs.org/dist/index.json", { signal: AbortSignal.timeout(60000) });
  if (!index.ok) throw new Error(st("srv.nodeSiteDown", { status: index.status }));
  const version = pickNodeLts(await index.json());
  if (!version) throw new Error(st("srv.noLtsBuild", { min: MIN_NODE_MAJOR }));

  const base = `node-${version}-win-x64`;
  const parent = path.dirname(NODE_PORTABLE_DIR);
  const zip = path.join(os.tmpdir(), `${base}.zip`);

  pushLog(st("log.nodeDownloading", { version }));
  await downloadFile(`https://nodejs.org/dist/${version}/${base}.zip`, zip);
  assertNotCancelled();

  pushLog(st("log.unpacking"));
  fs.mkdirSync(parent, { recursive: true });
  fs.rmSync(path.join(parent, base), { recursive: true, force: true });
  fs.rmSync(NODE_PORTABLE_DIR, { recursive: true, force: true });
  await runPowerShell(
    `Expand-Archive -LiteralPath '${psQuote(zip)}' -DestinationPath '${psQuote(parent)}' -Force`,
    { timeout: 1000 * 60 * 10, liveLog: true, track: true }
  );
  fs.renameSync(path.join(parent, base), NODE_PORTABLE_DIR);
  fs.rmSync(zip, { force: true });
  pushLog(st("log.nodeUnpacked", { dir: NODE_PORTABLE_DIR }));
}

/**
 * A zip install is invisible to the user's own terminal, so `claude` and `omniroute`
 * would only work from inside FreeClaude until PATH knows about them.
 */
async function addToUserPath(dirs) {
  const wanted = dirs.filter(Boolean).map(psQuote);
  if (!wanted.length) return;
  const script = [
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString",
    "try { $kind = $key.GetValueKind('Path') } catch {}",
    // DoNotExpandEnvironmentNames keeps entries like %USERPROFILE% from being baked in.
    "$cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "$parts = @($cur -split ';' | Where-Object { $_ -ne '' })",
    `$add = @('${wanted.join("','")}')`,
    "foreach ($d in $add) { if ($parts -notcontains $d) { $parts += $d } }",
    "$new = ($parts -join ';')",
    "if ($new -ne $cur) { $key.SetValue('Path', $new, $kind) }",
    "$key.Close()",
  ].join("; ");
  try {
    await runPowerShell(script, { timeout: 60000 });
    pushLog(st("log.pathUpdated"));
  } catch (err) {
    pushLog(st("log.pathUpdateFailed", { error: err.message }));
  }
}

async function installNodeRuntime() {
  const winget = resolveWinget();
  if (winget) {
    pushLog(st("log.nodeViaWinget"));
    try {
      await runCmd(
        winget,
        ["install", "-e", "--id", "OpenJS.NodeJS.LTS", "--accept-package-agreements", "--accept-source-agreements"],
        { timeout: 1000 * 60 * 15, liveLog: true, track: true }
      );
      invalidateToolCache();
      if (resolveNode()) return;
      pushLog(st("log.wingetNoNode"));
    } catch (err) {
      assertNotCancelled();
      pushLog(st("log.wingetFailed", { error: err.message }));
    }
  } else {
    pushLog(st("log.noWinget"));
  }

  await installNodeFromZip();
  invalidateToolCache();
  await addToUserPath([NODE_PORTABLE_DIR, NPM_BIN]);
}

async function installAll() {
  if (installState.running) return;
  installState.running = true;
  installState.ok = null;
  installState.log = [];
  installState.finishedAt = null;
  installState.cancelRequested = false;
  installState.child = null;

  try {
    invalidateToolCache();
    installState.step = "node";
    assertNotCancelled();
    let nodeBin = resolveNode();
    let npmBin = resolveNpm();
    if (!nodeBin) {
      await installNodeRuntime();
      invalidateToolCache();
      nodeBin = resolveNode();
      npmBin = resolveNpm();
      if (!nodeBin) {
        throw new Error(st("srv.nodeNotFoundAfterInstall"));
      }
      pushLog(st("log.nodeInstalled", { path: nodeBin }));
    } else {
      pushLog(st("log.nodeAlready", { version: (await runCmd(nodeBin, ["-v"])).trim(), path: nodeBin }));
    }

    assertNotCancelled();
    if (!npmBin) {
      invalidateToolCache();
      npmBin = resolveNpm();
    }
    if (!npmBin) throw new Error(st("srv.npmMissing"));

    const omniPath = omniCmdPath();
    const claudePath = claudeCmdPath();

    installState.step = "omniroute";
    if (!whichExists(omniPath)) {
      pushLog(st("log.omniInstalling"));
      await runCmd(
        npmBin,
        ["install", "-g", "omniroute", "--no-fund", "--no-audit", "--loglevel", "verbose"],
        {
          timeout: 1000 * 60 * 12,
          liveLog: true,
          track: true,
          env: {
            npm_config_progress: "true",
            npm_config_loglevel: "verbose",
            npm_config_fetch_retries: "3",
          },
        }
      );
      assertNotCancelled();
      pushLog(st("log.omniInstalled"));
    } else {
      pushLog(st("log.omniAlready"));
    }

    installState.step = "claude";
    if (!isClaudeCodeReady()) {
      if (whichExists(claudePath)) {
        pushLog(st("log.claudeStub"));
      } else {
        pushLog(st("log.claudeInstalling"));
      }
      await runCmd(
        npmBin,
        [
          "install",
          "-g",
          "@anthropic-ai/claude-code",
          "--include=optional",
          "--no-fund",
          "--no-audit",
          "--loglevel",
          "verbose",
        ],
        {
          timeout: 1000 * 60 * 12,
          liveLog: true,
          track: true,
          env: {
            npm_config_progress: "true",
            npm_config_loglevel: "verbose",
            npm_config_omit: "",
            npm_config_optional: "true",
          },
        }
      );
      assertNotCancelled();
      if (!isClaudeCodeReady()) {
        const installJs = path.join(npmBinDir(), "node_modules", "@anthropic-ai", "claude-code", "install.cjs");
        if (whichExists(installJs)) {
          pushLog(st("log.claudePostinstall"));
          await runCmd(nodeBin || resolveNode(), [installJs], {
            timeout: 1000 * 60 * 5,
            liveLog: true,
            track: true,
            cwd: path.dirname(installJs),
          });
        }
      }
      if (!isClaudeCodeReady()) {
        throw new Error(
          st("srv.claudeNoBinary")
        );
      }
      pushLog(st("log.claudeInstalled"));
    } else {
      pushLog(st("log.claudeAlready"));
    }

    installState.step = "omni-start";
    pushLog(st("log.omniLaunching"));
    const up = await ensureOmni(180000, { liveLog: true, checkCancel: true });
    assertNotCancelled();
    pushLog(up ? st("log.omniOnline") : st("log.omniOffline"));

    if (!up) {
      installState.step = "error";
      installState.ok = false;
      pushLog(st("log.omniInstallIncomplete"));
    } else {
      installState.step = "done";
      installState.ok = true;
      pushLog(st("log.allDone"));
    }
  } catch (err) {
    installState.ok = false;
    installState.step = installState.cancelRequested ? "stopped" : "error";
    pushLog(`${installState.cancelRequested ? st("log.stopped") : st("log.failed")}: ${err.message || err}`);
  } finally {
    installState.running = false;
    installState.child = null;
    installState.finishedAt = Date.now();
  }
}

async function omniFetch(pathname, options = {}) {
  const token = readToken();
  const res = await fetch(`${OMNI}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, text, json };
}

const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

/**
 * The UI is reachable at 127.0.0.1, so any page in the user's browser can reach it too.
 * Without these checks a random site could POST here and drive the app (CSRF), and a
 * hostname rebound to 127.0.0.1 could read responses (DNS rebinding).
 */
function isTrustedRequest(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return false;

  const origin = req.headers.origin;
  if (origin) return ALLOWED_ORIGINS.has(String(origin).toLowerCase());

  // Browsers omit Origin on same-origin GET/HEAD but always send it on state-changing methods.
  return req.method === "GET" || req.method === "HEAD";
}

function summarizeLogPayload(data) {
  if (data == null) return "";
  if (typeof data === "string") return data.slice(0, 600);
  if (typeof data !== "object") return String(data);
  const bits = [];
  if (data.ok === false) bits.push("ok=false");
  if (data.error) bits.push(`error=${String(data.error).slice(0, 500)}`);
  if (data.message) bits.push(`message=${String(data.message).slice(0, 300)}`);
  if (data.reason && typeof data.reason === "object") {
    if (data.reason.kind) bits.push(`kind=${data.reason.kind}`);
    if (data.reason.title) bits.push(`title=${data.reason.title}`);
    if (data.reason.raw) bits.push(`raw=${String(data.reason.raw).slice(0, 300)}`);
  }
  if (data.status != null) bits.push(`upstream=${data.status}`);
  if (data.removed != null) bits.push(`removed=${data.removed}`);
  if (data.snapshotsCleared != null) bits.push(`snapshots=${data.snapshotsCleared}`);
  if (data.omniRestarted != null) bits.push(`omniRestarted=${data.omniRestarted}`);
  if (data.banned) bits.push("banned=true");
  if (data.limited) bits.push("limited=true");
  if (data.modelsCount != null) bits.push(`models=${data.modelsCount}`);
  if (data.kiroConnected != null) bits.push(`kiro=${data.kiroConnected}`);
  if (!bits.length) {
    try {
      return JSON.stringify(data).slice(0, 500);
    } catch {
      return "";
    }
  }
  return bits.join(" ");
}

function send(res, status, data, type = "application/json") {
  try {
    const where = res.__fcRoute || "HTTP";
    const quiet = /\/api\/logs(?:\/|$)/.test(where);
    if (!quiet && String(type).includes("json")) {
      if (status >= 400) {
        appLog.error(`${where} → ${status} ${summarizeLogPayload(data)}`);
      } else if (data && typeof data === "object" && data.ok === false) {
        appLog.warn(`${where} → ${status} ${summarizeLogPayload(data)}`);
      }
    }
  } catch {
    /* never break responses because of logging */
  }
  let body;
  if (Buffer.isBuffer(data)) body = data;
  else if (typeof data === "string") body = data;
  else body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function mime(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function findBrowser() {
  if (process.platform === "darwin") {
    const macCandidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
    return macCandidates.find((p) => fs.existsSync(p)) || null;
  }
  if (process.platform === "linux") {
    const linuxCandidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/brave-browser",
      "/usr/bin/microsoft-edge",
    ];
    return linuxCandidates.find((p) => fs.existsSync(p)) || null;
  }
  const candidates = [
    path.join(process.env.ProgramFiles || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function shouldOpenBrowser() {
  if (process.env.FREECLAUDE_NO_BROWSER === "1") return false;
  return true;
}

function openWindow() {
  if (!shouldOpenBrowser()) return;
  const url = `http://127.0.0.1:${PORT}`;
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const sys = process.env.SystemRoot || "C:\\Windows";
  const logPath = path.join(DATA_DIR, "open-ui.log");
  const log = (msg) => {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* ignore */
    }
  };

  const attempts = [
    {
      name: "rundll32",
      run: () =>
        execFileSync(path.join(sys, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 8000,
        }),
    },
    {
      name: "powershell",
      run: () =>
        execFileSync(
          path.join(sys, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Start-Process '${url}'`],
          { stdio: "ignore", windowsHide: true, timeout: 15000 }
        ),
    },
    {
      name: "explorer",
      run: () =>
        execFileSync(path.join(sys, "explorer.exe"), [url], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 8000,
        }),
    },
  ];

  for (const step of attempts) {
    try {
      step.run();
      log(`ok ${step.name} pkg=${IS_PKG}`);
      return;
    } catch (err) {
      log(`fail ${step.name}: ${err && err.message ? err.message : err}`);
    }
  }
  log("all open methods failed");
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

let lastQuotaLogSig = "";

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    res.__fcRoute = `${req.method} ${u.pathname}`;

    if (!isTrustedRequest(req)) {
      return send(res, 403, { ok: false, error: st("srv.untrustedOrigin") });
    }

    // The whole dictionary is handed to the page as a script so the very first paint is
    // already in the right language — no flash of English before a fetch comes back.
    if (req.method === "GET" && u.pathname === "/i18n.js") {
      const payload = JSON.stringify({
        lang: currentLang(),
        langs: i18n.LANGS,
        dict: i18n.DICT,
      });
      const body = `window.FC_I18N=${payload};`;
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(body);
    }

    if (req.method === "GET" && u.pathname === "/api/lang") {
      return send(res, 200, { ok: true, lang: currentLang(), langs: i18n.LANGS });
    }

    if (req.method === "POST" && u.pathname === "/api/lang") {
      try {
        const body = await readBody(req);
        const lang = i18n.normalizeLang(body.lang);
        writeConfig({ lang });
        return send(res, 200, { ok: true, lang });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "GET" && u.pathname === "/api/logs") {
      const info = appLog.stats();
      const text = appLog.readAll();
      return send(res, 200, {
        ok: true,
        text,
        path: info.path,
        bytes: info.bytes,
        mtime: info.mtime,
        lines: text ? text.split(/\r\n|\n|\r/).filter((l) => l.length).length : 0,
      });
    }

    if (req.method === "GET" && u.pathname === "/api/logs/download") {
      const info = appLog.stats();
      const text = appLog.readAll() || "(empty log)\n";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `freeclaude-log-${stamp}.txt`;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
        "X-Log-Path": info.path,
        "X-Log-Bytes": String(info.bytes || 0),
      });
      return res.end(text);
    }

    if (req.method === "POST" && u.pathname === "/api/logs/client") {
      try {
        const body = await readBody(req);
        const level = String(body.level || "error").toLowerCase();
        const message = String(body.message || "").slice(0, 100_000);
        if (!message.trim()) return send(res, 400, { ok: false, error: "empty" });
        const prefix = body.source ? `[ui:${body.source}] ` : "[ui] ";
        if (level === "warn") appLog.warn(prefix + message);
        else if (level === "info") appLog.info(prefix + message);
        else appLog.error(prefix + message);
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/logs/clear") {
      try {
        appLog.clear();
        return send(res, 200, { ok: true, ...appLog.stats() });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "GET" && u.pathname === "/api/access") {
      const force = u.searchParams.get("force") === "1";
      return send(res, 200, await checkAccess(force));
    }

    // Gate mutating/app APIs when remote flag is 0 (static files + /api/access stay available)
    const gated =
      u.pathname.startsWith("/api/") &&
      u.pathname !== "/api/access" &&
      u.pathname !== "/api/status";
    if (gated) {
      const access = await checkAccess(false);
      if (!access.allowed) {
        return send(res, 403, accessDeniedPayload());
      }
    }

    if (req.method === "GET" && u.pathname === "/api/setup") {
      return send(res, 200, await getSetupStatus());
    }

    if (u.pathname === "/api/doctor" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await readBody(req) : {};
      const codes = Array.isArray(body.codes) && body.codes.length ? body.codes : null;
      return send(res, 200, await runDoctor({ repair: req.method === "POST", codes }));
    }

    if (req.method === "POST" && u.pathname === "/api/setup/install") {
      if (!installState.running) installAll();
      return send(res, 200, { ok: true, started: true, install: { ...installState, child: undefined } });
    }

    if (req.method === "POST" && u.pathname === "/api/setup/install/stop") {
      const result = requestStopInstall();
      return send(res, 200, result);
    }

    if (req.method === "POST" && u.pathname === "/api/key") {
      const { apiKey } = await readBody(req);
      const key = String(apiKey || "").trim();
      if (!key) return send(res, 400, { ok: false, error: st("srv.emptyKey") });
      if (!TOKEN_RE.test(key)) return send(res, 400, { ok: false, error: st("srv.badToken") });
      const model = readActiveModel() || "kiro/claude-sonnet-4.5";
      writeSettings(model, key);
      return send(res, 200, { ok: true, masked: maskToken(key), activeModel: model });
    }

    if (req.method === "POST" && u.pathname === "/api/key/generate") {
      try {
        const account = omniKeys.getAccountLimitInfo();
        if (!account.connected) {
          return send(res, 400, {
            ok: false,
            error: st("srv.needKiroForKey"),
          });
        }
        // Всегда новый ключ (кнопка «Получить ключ» / смена аккаунта Kiro)
        const created = omniKeys.createApiKey(
          `freeclaude-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`
        );
        const model = readActiveModel() || "kiro/claude-sonnet-4.5";
        writeSettings(model, created.key);
        return send(res, 200, {
          ok: true,
          key: created.key,
          masked: created.masked,
          id: created.id,
          createdAt: created.createdAt,
          reused: false,
          note: st("srv.keyNote"),
        });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/key/clear") {
      try {
        const prev = readToken();
        clearLocalApiKey();
        let keysRemoved = 0;
        try {
          keysRemoved = Number(omniKeys.clearFreeClaudeKeys(prev || null)?.removed || 0);
        } catch (err) {
          appLog.warn(`clearFreeClaudeKeys: ${err.message || err}`);
        }
        return send(res, 200, { ok: true, cleared: true, keysRemoved });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "GET" && u.pathname === "/api/keys") {
      try {
        const keys = omniKeys.listApiKeys().map(({ key, ...rest }) => rest);
        return send(res, 200, { keys, activeMasked: maskToken(readToken()) });
      } catch (err) {
        return send(res, 500, { error: String(err.message || err) });
      }
    }

    if (req.method === "GET" && u.pathname === "/api/quota") {
      try {
        const token = readToken();
        const emptyUsage = {
          found: false,
          masked: "",
          usedTokens: 0,
          remaining: null,
          unlimited: true,
          requests: 0,
          todayTokens: 0,
        };
        // Usage is a nicety; losing it must not blank out the account state below.
        let usage = emptyUsage;
        if (token) {
          try {
            usage = omniKeys.getKeyUsage(token);
          } catch {
            usage = emptyUsage;
          }
        }
        let soonest = 0;
        try {
          const h = await fetch(`${OMNI}/api/monitoring/health`, { signal: AbortSignal.timeout(2500) });
          if (h.ok) {
            const health = await h.json();
            soonest = health?.connectionHealth?.kiro?.soonestRetryAfterMs || 0;
          }
        } catch {
          /* ignore */
        }
        let account;
        try {
          account = omniKeys.getAccountLimitInfo();
        } catch (err) {
          // No database access: report what OmniRoute's own API knows rather than
          // failing the whole call, which used to paint the account as logged out.
          const http = await kiroStateOverHttp();
          account = {
            kiro: [],
            connected: Boolean(http?.connected),
            banned: Boolean(http?.banned),
            banReason: null,
            limited: false,
            resetAt: null,
            resetInMs: 0,
            resetInText: null,
            recent429: 0,
            last429At: null,
            degraded: true,
            error: String(err.message || err),
          };
        }
        // soonestRetryAfterMs mixes every historical Kiro row in OmniRoute RAM.
        // Never let it invent a limit when SQLite says the live account is fine.
        if (soonest > 0 && account.limited && !account.banned) {
          const soonestAt = Date.now() + soonest;
          if (!account.resetAt || soonestAt > account.resetAt) {
            account.resetAt = soonestAt;
            account.resetInMs = soonest;
            account.resetInText = omniKeys.formatDuration(soonest);
          }
        } else if (account.resetInMs > 0 && !account.resetAt) {
          account.resetAt = Date.now() + account.resetInMs;
        } else if (!account.limited) {
          account.resetAt = null;
          account.resetInMs = 0;
          account.resetInText = null;
        }
        const quotaSig = `${Boolean(account.banned)}|${Boolean(account.limited)}|${Boolean(account.connected)}|${account.banReason || ""}|${account.resetInMs || 0}`;
        if ((account.banned || account.limited) && quotaSig !== lastQuotaLogSig) {
          lastQuotaLogSig = quotaSig;
          appLog.warn(
            `Quota: connected=${Boolean(account.connected)} banned=${Boolean(account.banned)} limited=${Boolean(account.limited)} resetInMs=${account.resetInMs || 0} reason=${String(account.banReason || account.resetInText || "").slice(0, 200)}`
          );
        } else if (!account.banned && !account.limited) {
          lastQuotaLogSig = quotaSig;
        }
        return send(res, 200, {
          activeKey: usage.masked || maskToken(token),
          usage,
          account,
          serverNow: Date.now(),
        });
      } catch (err) {
        return send(res, 500, { error: String(err.message || err) });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/kiro/open") {
      // Legacy: start flow, client should open AWS itself; keep URL in response.
      try {
        const flow = await startKiroBuilderIdFlow();
        return send(res, 200, { ok: true, ...flow, opened: false });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/kiro/start") {
      try {
        appLog.info("Kiro OAuth: start device-code flow");
        const body = await readBody(req);
        const flow = await startKiroBuilderIdFlow();
        // Only spawn a separate Chrome --app if client explicitly asks (legacy).
        const openAuth = body.open === true;
        if (openAuth) openUrlApp(flow.verificationUriComplete);
        appLog.info(`Kiro OAuth: code ${flow.userCode || "?"} issued`);
        return send(res, 200, { ok: true, ...flow, opened: openAuth });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/kiro/poll") {
      try {
        const result = await pollKiroBuilderIdOnce();
        let extras = {
          keyIssued: null,
          ready: false,
          kiroConnected: false,
          modelsCount: 0,
        };
        if (result.success) {
          appLog.info("Kiro OAuth: device code approved — finalizing");
          try {
            extras = await finalizeKiroAuth();
            appLog.info(
              `Kiro OAuth: finalize ready=${extras.ready} connected=${extras.kiroConnected} models=${extras.modelsCount}`
            );
          } catch (err) {
            extras.keyIssued = { error: String(err.message || err) };
            appLog.error(`Kiro OAuth: finalize failed: ${err.message || err}`);
          }
        } else if (result.error && !result.pending) {
          appLog.warn(`Kiro OAuth: poll failed: ${result.error}`);
        }
        return send(res, 200, { ok: true, ...result, ...extras });
      } catch (err) {
        return send(res, 500, { ok: false, success: false, pending: false, error: String(err.message || err) });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/kiro/cancel") {
      clearKiroOAuthSession();
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && u.pathname === "/api/kiro/open-aws") {
      const body = await readBody(req).catch(() => ({}));
      if (!kiroOAuth.verificationUriComplete && !body.url) {
        return send(res, 400, { ok: false, error: st("srv.noActiveCode") });
      }
      const url = body.url || kiroOAuth.verificationUriComplete;
      const fresh = body.fresh !== false;
      const opened = openAwsAuthWindow(url, { fresh });
      return send(res, 200, {
        ok: true,
        userCode: kiroOAuth.userCode,
        verificationUriComplete: url,
        ...opened,
      });
    }

    if (req.method === "POST" && u.pathname === "/api/kiro/aws-signout") {
      // Purge + clear key + open AWS window immediately; restart OmniRoute in the background
      // so the UI is not stuck ~7s waiting for a full respawn.
      appLog.info("Kiro: AWS sign-out requested");
      const prevToken = readToken();
      let purged = null;
      try {
        purged = omniKeys.logoutKiro(null);
        appLog.info(
          `Kiro: purged connections removed=${purged?.removed ?? "?"} snapshots=${purged?.snapshotsCleared ?? "?"}`
        );
      } catch (err) {
        purged = null;
        appLog.error(`Kiro: purge on AWS sign-out failed: ${err.message || err}`);
      }
      let keysCleared = 0;
      try {
        clearLocalApiKey();
        keysCleared = Number(omniKeys.clearFreeClaudeKeys(prevToken || null)?.removed || 0);
        appLog.info(`Kiro: API key cleared keysRemoved=${keysCleared}`);
      } catch (err) {
        appLog.error(`Kiro: clear key on AWS sign-out failed: ${err.message || err}`);
      }
      invalidateKiroHttpCache();
      const opened = openAwsSignOut();
      void restartOmniRoute()
        .then((ok) => {
          appLog.info(`Kiro: OmniRoute restart after sign-out ok=${Boolean(ok)}`);
        })
        .catch((err) => {
          appLog.error(`Kiro: OmniRoute restart after sign-out failed: ${err.message || err}`);
        });
      appLog.info(`Kiro: AWS sign-out window opened=${Boolean(opened?.opened)} omniRestart=background`);
      return send(res, 200, {
        ok: true,
        message: st("srv.awsSignOutOpened"),
        telegram: TELEGRAM_URL,
        purged,
        keyCleared: true,
        keysRemoved: keysCleared,
        omniRestarted: "background",
        ...opened,
      });
    }

    if (req.method === "POST" && u.pathname === "/api/kiro/logout") {
      try {
        const body = await readBody(req);
        appLog.info(`Kiro: logout id=${body.id || "all"}`);
        const prevToken = readToken();
        const result = omniKeys.logoutKiro(body.id || null);
        appLog.info(
          `Kiro: logout done removed=${result?.removed ?? "?"} snapshots=${result?.snapshotsCleared ?? "?"}`
        );
        let keysRemoved = 0;
        try {
          clearLocalApiKey();
          keysRemoved = Number(omniKeys.clearFreeClaudeKeys(prevToken || null)?.removed || 0);
          appLog.info(`Kiro: API key cleared keysRemoved=${keysRemoved}`);
        } catch (err) {
          appLog.warn(`Kiro: clear key on logout failed: ${err.message || err}`);
        }
        invalidateKiroHttpCache();
        // Drop OmniRoute's in-memory "all accounts exhausted" cache so the next
        // Builder ID is not sticky-limited for ~5 minutes.
        const omniRestarted = await restartOmniRoute().catch((err) => {
          appLog.error(`Kiro: OmniRoute restart after logout failed: ${err.message || err}`);
          return false;
        });
        return send(res, 200, {
          ok: true,
          ...result,
          keyCleared: true,
          keysRemoved,
          omniRestarted: Boolean(omniRestarted),
        });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "GET" && u.pathname === "/api/paths") {
      return send(res, 200, { ok: true, paths: manualPathsView() });
    }

    if (req.method === "POST" && u.pathname === "/api/paths") {
      try {
        const { key, value } = await readBody(req);
        const file = validateManualPath(key, value);
        const paths = { ...configuredPaths() };
        if (file) paths[key] = file;
        else delete paths[key];
        writeConfig({ paths });
        invalidateToolCache();
        return send(res, 200, { ok: true, key, value: file, paths: manualPathsView() });
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "GET" && u.pathname === "/api/axiom") {
      try {
        return send(res, 200, { ok: true, ...axiom.state() });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/axiom") {
      try {
        const { enabled } = await readBody(req);
        return send(res, 200, { ok: true, ...axiom.setEnabled(Boolean(enabled)) });
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "GET" && u.pathname === "/api/status") {
      const omni = await isOmniUp();
      let kiro = false;
      let kiroSource = "none";
      let kiroDbError = null;
      if (omni) {
        const state = await resolveKiroConnected();
        kiro = state.connected;
        kiroSource = state.source;
        kiroDbError = state.dbError;
      }
      return send(res, 200, {
        omni,
        token: Boolean(readToken()),
        tokenMasked: maskToken(readToken()),
        activeModel: readActiveModel(),
        kiro,
        kiroSource,
        kiroDbError,
      });
    }

    if (req.method === "POST" && u.pathname === "/api/bootstrap") {
      const status = await getSetupStatus();
      if (!status.checks.omniroute.ok) {
        return send(res, 200, { ok: false, omni: false, needSetup: true, activeModel: readActiveModel(), token: status.checks.token.ok });
      }
      const ok = await ensureOmni();
      return send(res, 200, { ok, omni: ok, activeModel: readActiveModel(), token: Boolean(readToken()) });
    }

    if (req.method === "GET" && u.pathname === "/api/models") {
      if (!(await isOmniUp())) {
        const up = await ensureOmni(60000);
        if (!up) {
          return send(res, 503, {
            error: st("srv.omniDown"),
            reason: describeUpstreamError(null, "ECONNREFUSED OmniRoute", currentLang()),
          });
        }
      }
      const r = await omniFetch("/v1/models");
      if (!r.ok) {
        const raw = r.text || "OmniRoute unavailable";
        return send(res, r.status, { error: raw, reason: describeUpstreamError(r.status, raw, currentLang()) });
      }
      const all = r.json?.data || [];
      const models = all
        .filter(
          (m) =>
            /^(kiro|kr)\//i.test(m.id) &&
            !/-low$|-medium$|-high$|-xhigh$/i.test(m.id) &&
            !m.id.includes("no-think")
        )
        .map((m) => ({
          id: m.id,
          name: (m.name || m.id).replace(/^kiro\//i, "").replace(/^kr\//i, ""),
          owned_by: m.owned_by || "kiro",
          context_length: m.context_length || null,
        }));

      const byBase = new Map();
      for (const m of models) {
        const base = m.id.replace(/^(kiro|kr)\//, "");
        const prev = byBase.get(base);
        if (!prev || m.id.startsWith("kiro/")) byBase.set(base, m);
      }
      const deduped = [...byBase.values()].sort((a, b) => a.id.localeCompare(b.id));
      return send(res, 200, { models: deduped, activeModel: readActiveModel() });
    }

    if (req.method === "POST" && u.pathname === "/api/test") {
      const { model } = await readBody(req);
      if (!model) return send(res, 400, { ok: false, error: "model required" });
      if (!(await isOmniUp())) {
        const up = await ensureOmni(60000);
        if (!up) {
          return send(res, 200, {
            ok: false,
            status: null,
            error: st("srv.omniDown"),
            reason: describeUpstreamError(null, "ECONNREFUSED OmniRoute", currentLang()),
            ms: 0,
          });
        }
      }
      const started = Date.now();
      try {
        const r = await omniFetch("/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model,
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with OK" }],
          }),
        });
        const ms = Date.now() - started;
        if (!r.ok) {
          const err =
            r.json?.error?.message ||
            r.json?.message ||
            (typeof r.json?.error === "string" ? r.json.error : null) ||
            r.text.slice(0, 220);
          appLog.warn(
            `API test model=${model} status=${r.status} err=${String(err).slice(0, 400)} body=${String(r.text || "").slice(0, 500)}`
          );
          return send(res, 200, { ok: false, status: r.status, error: String(err), reason: describeUpstreamError(r.status, err, currentLang()), ms });
        }
        return send(res, 200, { ok: true, status: r.status, reply: r.json?.content?.[0]?.text || "", ms });
      } catch (err) {
        // A dead OmniRoute throws instead of answering, and that is worth explaining too.
        const message = String(err.message || err);
        appLog.error(`API test model=${model} threw: ${message}`);
        return send(res, 200, {
          ok: false,
          status: null,
          error: message,
          reason: describeUpstreamError(null, message, currentLang()),
          ms: Date.now() - started,
        });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/connect") {
      const { model } = await readBody(req);
      if (!model) return send(res, 400, { ok: false, error: "model required" });
      if (!MODEL_RE.test(String(model).trim())) {
        return send(res, 400, { ok: false, error: st("srv.badModel") });
      }
      const token = readToken();
      if (!token) return send(res, 400, { ok: false, error: st("srv.saveKeyFirst") });
      writeSettings(String(model).trim(), token);
      return send(res, 200, { ok: true, model, activeModel: model });
    }

    if (req.method === "GET" && u.pathname === "/api/claude/sessions") {
      try {
        const limit = Number(u.searchParams.get("limit") || 25);
        const sessions = listClaudeSessions({
          profileDir: path.join(PROFILE_DIR, "projects"),
          limit,
        });
        return send(res, 200, { ok: true, sessions });
      } catch (err) {
        return send(res, 500, { ok: false, error: String(err.message || err) });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/launch") {
      const body = await readBody(req).catch(() => ({}));
      const mode = String(body.mode || "new").toLowerCase();
      const sessionId = String(body.sessionId || "").trim();
      const cwdRaw = String(body.cwd || "").trim();

      if (mode === "resume") {
        if (!isSessionId(sessionId)) {
          return send(res, 400, { ok: false, error: st("srv.badSessionId") });
        }
      } else if (mode !== "new" && mode !== "continue") {
        return send(res, 400, { ok: false, error: st("srv.badLaunchMode") });
      }

      const token = readToken();
      const model = readActiveModel() || "kiro/claude-sonnet-4.5";
      if (!token) return send(res, 400, { ok: false, error: st("srv.noKey") });
      if (!MODEL_RE.test(model)) return send(res, 400, { ok: false, error: st("srv.badModel") });
      if (!(await isOmniUp())) {
        const up = await ensureOmni(60000);
        if (!up) return send(res, 503, { ok: false, error: st("srv.omniStartFailed") });
      }
      writeSettings(model, token);
      assertSafePath(nodeDir(), "Node.js");
      assertSafePath(npmBinDir(), "npm");
      if (!isClaudeCodeReady() && !whichExists(claudeCmdPath())) {
        return send(res, 400, {
          ok: false,
          error: st("srv.claudeNotFound", { path: claudeCmdPath() || "claude.cmd" }),
        });
      }

      let launchCwd = DATA_DIR;
      if (cwdRaw && path.isAbsolute(cwdRaw) && fs.existsSync(cwdRaw) && !/["|&<>^%\r\n]/.test(cwdRaw)) {
        launchCwd = cwdRaw;
      }

      let claudeArgs = "";
      let title = `Claude Code - ${model}`;
      if (mode === "continue") {
        claudeArgs = "--continue";
        title = "Claude Code - continue";
      } else if (mode === "resume") {
        claudeArgs = `--resume ${sessionId}`;
        title = `Claude Code - resume`;
      }

      if (process.platform !== "win32") {
        const launcher = path.join(DATA_DIR, "launch-claude.sh");
        writeCmdFile(
          launcher,
          `#!/usr/bin/env bash
cd "${launchCwd}"
export PATH="${nodeDir()}:${npmBinDir()}:$PATH"
echo ""
echo "  ${title}"
echo "  Model: ${model}"
echo "  Mode: ${mode}${mode === "resume" ? ` (${sessionId ? sessionId.slice(0, 8) : ""})` : ""}"
echo "  Starting Claude Code..."
echo ""
if [ ! -f "${FREECLAUDE}" ]; then
  echo "[ERROR] freeclaude.sh not found in ${DATA_DIR}"
  echo "Open FreeClaude, connect a model, then try again."
  exit 1
fi
exec "${FREECLAUDE}" ${claudeArgs} "$@"
`
        );
        try { fs.chmodSync(launcher, 0o755); } catch { /* ignore */ }

        if (process.platform === "darwin") {
          spawn("open", ["-a", "Terminal", launcher], {
            detached: true,
            stdio: "ignore",
            cwd: launchCwd,
            env: { ...process.env, PATH: `${nodeDir()}:${npmBinDir()}:${enrichedPath()}` },
          }).unref();
        } else {
          spawn("x-terminal-emulator", ["-e", launcher], {
            detached: true,
            stdio: "ignore",
            cwd: launchCwd,
            env: { ...process.env, PATH: `${nodeDir()}:${npmBinDir()}:${enrichedPath()}` },
          }).unref();
        }
      } else {
        const launcher = path.join(DATA_DIR, "launch-claude.cmd");
        const nodeBat = toBatPathSafe(nodeDir(), "%ProgramFiles%\nodejs");
        const npmBat = toBatPathSafe(npmBinDir(), "%APPDATA%\npm");
        writeCmdFile(
          launcher,
          `@echo off
setlocal EnableExtensions
set "PATH=${nodeBat};${npmBat};%PATH%"
title ${title}
echo.
echo  Model: ${model}
echo  Mode: ${mode}${mode === "resume" ? ` (${sessionId.slice(0, 8)})` : ""}
echo  Starting Claude Code...
echo.
if not exist "%APPDATA%\FreeClaude\freeclaude.bat" (
  echo [ERROR] freeclaude.bat not found in %%APPDATA%%\FreeClaude
  echo Open FreeClaude, connect a model, then try again.
  pause
  exit /b 1
)
call "%APPDATA%\FreeClaude\freeclaude.bat" ${claudeArgs}
if errorlevel 1 pause
`
        );

        spawn("cmd.exe", ["/c", "start", title, "cmd.exe", "/k", launcher], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          cwd: launchCwd,
          env: { ...process.env, PATH: `${nodeDir()};${npmBinDir()};${enrichedPath()}` },
        }).unref();
      }
      appLog.info(`Claude launch mode=${mode} model=${model} cwd=${launchCwd}`);
      return send(res, 200, { ok: true, model, mode, sessionId: sessionId || null, cwd: launchCwd });
    }

    const safeName = u.pathname === "/" ? "index.html" : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    // Packaged: ONLY serve on-disk ./public next to exe (never embedded snapshot CSS/HTML/JS).
    // Snapshot fallback caused F5 to flip between old/new styles when roots mixed.
    const diskPublicRoot = path.join(EXE_DIR, "public");
    const snapPublicRoot = PUBLIC;
    const root =
      IS_PKG && fs.existsSync(path.join(diskPublicRoot, "index.html"))
        ? diskPublicRoot
        : snapPublicRoot;
    const filePath = path.join(root, safeName);
    const rel = path.relative(root, filePath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return send(res, 403, "Forbidden", "text/plain");
    if (!fs.existsSync(filePath)) return send(res, 404, "Not found", "text/plain");
    let body = fs.readFileSync(filePath);
    const type = mime(filePath);
    // Inline CSS into HTML so a refresh can never paint without styles (no 2nd-request race).
    if (safeName === "index.html" || safeName.replace(/\\/g, "/") === "index.html") {
      try {
        let html = body.toString("utf8");
        const cssPath = path.join(root, "styles.css");
        if (fs.existsSync(cssPath)) {
          const css = fs.readFileSync(cssPath, "utf8");
          if (/id=["']fc-css["']/.test(html)) {
            html = html.replace(
              /<style id=["']fc-css["']>[\s\S]*?<\/style>/i,
              `<style id="fc-css">\n${css}\n</style>`
            );
          } else {
            html = html.replace(
              /<link[^>]*href=["']\/styles\.css[^"']*["'][^>]*>/i,
              `<style id="fc-css">\n${css}\n</style>`
            );
          }
        }
        // Bust JS cache every serve (mtime) — avoids stale app.js after updates
        try {
          const jsPath = path.join(root, "app.js");
          const ver = fs.existsSync(jsPath) ? String(fs.statSync(jsPath).mtimeMs | 0) : String(Date.now());
          html = html.replace(/\/app\.js\?v=[^"']+/i, `/app.js?v=${ver}`);
          if (!/\/app\.js\?v=/.test(html)) {
            html = html.replace(/\/app\.js(["'])/i, `/app.js?v=${ver}$1`);
          }
        } catch {
          /* ignore */
        }
        html = html
          .replace(/<link[^>]+fonts\.googleapis\.com[^>]*>\s*/gi, "")
          .replace(/<link[^>]+fonts\.gstatic\.com[^>]*>\s*/gi, "");
        body = Buffer.from(html, "utf8");
      } catch {
        /* serve raw html */
      }
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store, max-age=0, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "X-FC-Public": root === diskPublicRoot ? "disk" : "snap",
    });
    return res.end(body);
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) });
  }
});

async function main() {
  ensureLocalhostNoProxy();

  // Seed config from existing settings for current test key (do not wipe)
  if (!readConfig().apiKey) {
    const existing = readToken();
    if (existing) writeConfig({ apiKey: existing, model: readActiveModel() || "kiro/claude-sonnet-4.5" });
  }

  // Сначала убиваем сиротский OmniRoute от прошлого запуска — иначе он жрёт порт и CPU
  killOrphanOmniRoute();

  // Запускаем вотчдог, который прибьёт OmniRoute, если главное окно FreeClaude закрыто крестиком
  spawnOmniRouteWatcher();

  // Already running → just open browser (no bat/cmd chain).
  try {
    const probe = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(800) });
    if (probe.ok) {
      conSay("ok", st("con.line.gui", { url: `http://127.0.0.1:${PORT}` }));
      openWindow();
      if (IS_PKG) process.exit(0);
      return;
    }
  } catch {
    /* start fresh */
  }

  server.listen(PORT, "127.0.0.1", async () => {
    installOmniShutdownHooks();
    enableAnsiConsole();
    const diskPublicRoot = path.join(EXE_DIR, "public");
    const uiRoot =
      IS_PKG && fs.existsSync(path.join(diskPublicRoot, "index.html")) ? diskPublicRoot : PUBLIC;
    const ver = (() => {
      try {
        return require("./package.json").version;
      } catch {
        return "?";
      }
    })();
    appLog.info(`FreeClaude ${ver} starting (pkg=${IS_PKG})`);
    appLog.info(`GUI http://127.0.0.1:${PORT}`);
    appLog.info(`Data ${DATA_DIR}`);
    appLog.info(`UI assets ${uiRoot}`);

    conSay("info", st("con.line.gui", { url: `http://127.0.0.1:${PORT}` }));
    conSay("dim", st("con.oneConsole"));

    openWindow();

    try {
      if (isOmniRouteInstalled()) {
        conSay("info", st("con.line.omniStart"));
        const ok = await ensureOmni();
        if (ok) {
          conSay("ok", st("con.line.omniOn"));
          appLog.info("OmniRoute online");
          conSay("dim", st("con.closeNote"));
          conSay("ok", st("con.line.ready"));
          await autoRepairInstall();
        } else {
          conSay("warn", st("con.line.omniOff"));
          appLog.warn(st("con.omniOffline"));
        }
      } else {
        conSay("warn", st("con.line.omniOff"));
        appLog.warn("OmniRoute not installed — open Setup in GUI");
      }
    } catch (err) {
      conSay("err", st("con.line.omniOff"));
      appLog.error(`OmniRoute bootstrap error: ${err && err.message ? err.message : err}`);
    }
  });
}

// A module left out of the pkg snapshot only fails at runtime, and every file can still
// be present on disk. The release build boots the exe with this flag: reaching here means
// all requires resolved and the dictionary is readable, then we exit without taking a port.
if (process.env.FREECLAUDE_SELFTEST === "1") {
  console.log(`selftest ok: ${st("con.oneConsole")}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
