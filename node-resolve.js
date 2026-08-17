/**
 * Shared Node.js discovery.
 *
 * A packaged FreeClaude.exe still needs a real system Node to run sqlite-bridge.js,
 * because pkg cannot load native addons. Users install Node in a lot of places
 * (other drives, nvm, Scoop, homebrew), so both server.js and omni-keys-proxy.js resolve it
 * through this module rather than assuming C:\Program Files\nodejs.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const NODE_DIR_DEFAULT = IS_WIN ? "C:\\Program Files\\nodejs" : "/opt/homebrew/bin";
const NPM_BIN = IS_WIN
  ? path.join(process.env.APPDATA || "", "npm")
  : "/opt/homebrew/bin";
const APPDATA = IS_WIN
  ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
  : path.join(os.homedir(), ".config");
// Read straight from the config file rather than taking the paths as arguments: the
// packaged exe and the sqlite bridge are separate processes and both must see the override.
const CONFIG_FILE = IS_WIN
  ? path.join(APPDATA, "FreeClaude", "config.json")
  : path.join(os.homedir(), ".config", "FreeClaude", "config.json");

let _nodePathCache;
let _npmPathCache;
let _winPathCache = null;
let _winPathCachedAt = 0;

function readWindowsUserMachinePath() {
  if (!IS_WIN) return "";
  if (_winPathCache && Date.now() - _winPathCachedAt < 60_000) return _winPathCache;
  try {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 }
    );
    _winPathCache = String(r.stdout || "").trim();
  } catch {
    _winPathCache = "";
  }
  _winPathCachedAt = Date.now();
  return _winPathCache;
}

function enrichedPath() {
  if (!IS_WIN) {
    return [
      "/opt/homebrew/bin",
      "/opt/homebrew/opt/node@22/bin",
      "/opt/homebrew/opt/node/bin",
      "/usr/local/bin",
      "/usr/bin",
      process.env.PATH || "",
    ]
      .filter(Boolean)
      .join(":");
  }
  return [
    NODE_DIR_DEFAULT,
    process.env.NVM_SYMLINK || "",
    process.env.NVM_HOME || "",
    NPM_BIN,
    process.env.PATH || "",
    readWindowsUserMachinePath(),
  ]
    .filter(Boolean)
    .join(";");
}

function whereOnPath(name) {
  if (!IS_WIN) {
    // On macOS/Linux use 'which'
    try {
      const r = spawnSync("which", [name], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, PATH: enrichedPath() },
      });
      const result = String(r.stdout || "").trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* ignore */ }
    return null;
  }
  try {
    const r = spawnSync("where.exe", [name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      env: { ...process.env, PATH: enrichedPath() },
    });
    const lines = String(r.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (fs.existsSync(line)) return line;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function existingFile(p) {
  try {
    return p && fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function configuredPaths() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).paths || {};
  } catch {
    return {};
  }
}

/** People paste either the exe itself or the folder holding it, so accept both. */
function manualPath(key, exeName) {
  const raw = String(configuredPaths()[key] || "").trim();
  if (!raw) return null;
  return existingFile(raw) || existingFile(path.join(raw, exeName));
}

function firstExisting(candidates) {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function resolveNode() {
  if (_nodePathCache !== undefined) {
    if (_nodePathCache && fs.existsSync(_nodePathCache)) return _nodePathCache;
    _nodePathCache = undefined;
  }

  if (!IS_WIN) {
    _nodePathCache =
      firstExisting([
        manualPath("node", "node"),
        "/opt/homebrew/opt/node@22/bin/node",
        "/opt/homebrew/opt/node/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        whereOnPath("node"),
        process.execPath && process.execPath.includes("node") ? process.execPath : null,
      ]) || null;
    return _nodePathCache;
  }

  const driveCandidates = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    for (const base of [`${letter}:\\Program Files`, `${letter}:\\Program Files (x86)`]) {
      for (const name of ["nodejs", "Nodejs", "Node.js", "node"]) {
        driveCandidates.push(path.join(base, name, "node.exe"));
      }
    }
  }

  _nodePathCache =
    firstExisting([
      manualPath("node", "node.exe"),
      path.join(NODE_DIR_DEFAULT, "node.exe"),
      process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, "node.exe") : null,
      path.join(process.env.LOCALAPPDATA || "", "Programs", "node", "node.exe"),
      path.join(os.homedir(), "scoop", "apps", "nodejs", "current", "node.exe"),
      path.join(os.homedir(), "scoop", "apps", "nodejs-lts", "current", "node.exe"),
      ...driveCandidates,
      whereOnPath("node.exe"),
      whereOnPath("node"),
    ]) || null;

  return _nodePathCache;
}

function resolveNpm() {
  if (_npmPathCache !== undefined) {
    if (_npmPathCache && fs.existsSync(_npmPathCache)) return _npmPathCache;
    _npmPathCache = undefined;
  }
  const node = resolveNode();

  if (!IS_WIN) {
    _npmPathCache =
      firstExisting([
        manualPath("npm", "npm"),
        node ? path.join(path.dirname(node), "npm") : null,
        "/opt/homebrew/opt/node@22/bin/npm",
        "/opt/homebrew/opt/node/bin/npm",
        "/opt/homebrew/bin/npm",
        "/usr/local/bin/npm",
        "/usr/bin/npm",
        whereOnPath("npm"),
      ]) || null;
    return _npmPathCache;
  }

  // npm.cmd next to node.exe wins over %APPDATA%\npm shims
  _npmPathCache =
    firstExisting([
      manualPath("npm", "npm.cmd"),
      node ? path.join(path.dirname(node), "npm.cmd") : null,
      path.join(NODE_DIR_DEFAULT, "npm.cmd"),
      process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, "npm.cmd") : null,
      path.join(os.homedir(), "scoop", "apps", "nodejs", "current", "npm.cmd"),
      path.join(os.homedir(), "scoop", "apps", "nodejs-lts", "current", "npm.cmd"),
      whereOnPath("npm.cmd"),
      whereOnPath("npm"),
    ]) || null;

  return _npmPathCache;
}

function nodeDir() {
  const n = resolveNode();
  return n ? path.dirname(n) : NODE_DIR_DEFAULT;
}

/** Call after installing Node/npm: a fresh install also changes the machine PATH. */
function invalidateToolCache() {
  _nodePathCache = undefined;
  _npmPathCache = undefined;
  _winPathCache = null;
  _winPathCachedAt = 0;
}

/** Major version of the given node binary, or null when it cannot be determined. */
function nodeMajorVersion(nodeExe) {
  try {
    const r = spawnSync(nodeExe, ["-p", "process.versions.node"], {
      encoding: "utf8",
      windowsHide: IS_WIN,
      timeout: 8000,
    });
    const m = /^(\d+)\./.exec(String(r.stdout || "").trim());
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

module.exports = {
  CONFIG_FILE,
  NODE_DIR_DEFAULT,
  NPM_BIN,
  configuredPaths,
  enrichedPath,
  existingFile,
  manualPath,
  invalidateToolCache,
  nodeDir,
  nodeMajorVersion,
  readWindowsUserMachinePath,
  resolveNode,
  resolveNpm,
  whereOnPath,
};
