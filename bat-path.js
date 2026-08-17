"use strict";

const path = require("path");
const os = require("os");

/**
 * cmd.exe often breaks on absolute paths that contain Cyrillic (or other non-ASCII)
 * characters. Expanding %APPDATA% /
 * %USERPROFILE% at runtime avoids embedding those characters in the script at all.
 * Do not add a UTF-8 BOM to the .bat — cmd.exe then fails on `@echo off`.
 */
const win32 = path.win32 || path;

function batPathRoots(env = process.env) {
  return [
    [env.APPDATA, "%APPDATA%"],
    [env.LOCALAPPDATA, "%LOCALAPPDATA%"],
    [env.USERPROFILE || os.homedir(), "%USERPROFILE%"],
    [env.ProgramW6432 || env.ProgramFiles, "%ProgramFiles%"],
    [env["ProgramFiles(x86)"], "%ProgramFiles(x86)%"],
  ].filter(([root]) => Boolean(root));
}

function hasNonAscii(value) {
  return /[^\x00-\x7F]/.test(String(value || ""));
}

/**
 * Rewrite an absolute Windows path to a cmd.exe form that prefers well-known
 * environment variables. Falls back to the absolute path when nothing matches.
 */
function toBatPath(absPath, env = process.env) {
  const raw = String(absPath || "");
  const abs = win32.isAbsolute(raw) ? raw : win32.resolve(raw);
  const absLower = abs.toLowerCase();

  for (const [root, token] of batPathRoots(env)) {
    const rootAbs = String(root);
    const rootLower = rootAbs.toLowerCase();
    if (absLower === rootLower) return token;
    const prefix = rootLower.endsWith("\\") ? rootLower : `${rootLower}\\`;
    if (absLower.startsWith(prefix)) {
      const rest = abs.slice(rootAbs.length).replace(/^[\\/]+/, "").replace(/\//g, "\\");
      return rest ? `${token}\\${rest}` : token;
    }
  }

  return abs.replace(/\//g, "\\");
}

/**
 * Prefer an env-based path whenever the absolute form would put non-ASCII into a .bat.
 * If rewriting still leaves non-ASCII (unusual custom location), return the fallback.
 */
function toBatPathSafe(absPath, fallback, env = process.env) {
  const rewritten = toBatPath(absPath, env);
  if (hasNonAscii(rewritten) && fallback) return fallback;
  return rewritten;
}

module.exports = { batPathRoots, hasNonAscii, toBatPath, toBatPathSafe };
