/**
 * The dictionary is delivered by the server as `window.FC_I18N` in a script tag that runs
 * before this file, so the very first paint is already in the chosen language instead of
 * flashing English and then correcting itself.
 */
const lang = {
  code: window.FC_I18N?.lang || "en",
  dict: window.FC_I18N?.dict || { en: {} },
  list: window.FC_I18N?.langs || ["en"],
};

function t(key, vars) {
  const table = lang.dict[lang.code] || lang.dict.en || {};
  let out = table[key];
  if (out === undefined) out = (lang.dict.en || {})[key];
  if (out === undefined) return key;
  if (!vars) return out;
  return out.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  );
}

/** Fills every `data-i18n*` slot; run once at load and again after a language switch. */
function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  document.documentElement.lang = lang.code;
}

/** A corrupt value here used to throw during init and leave the user with a blank page. */
function readStoredResults() {
  try {
    const parsed = JSON.parse(localStorage.getItem("fc-results-v2") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through to a clean slate */
  }
  try {
    localStorage.removeItem("fc-results-v2");
  } catch {
    /* storage may be unavailable entirely */
  }
  return {};
}

const state = {
  models: [],
  results: readStoredResults(),
  activeModel: "",
  query: "",
  testing: new Set(),
  omniOnline: false,
  kiroConnected: false,
  limit: {
    limited: false,
    banned: false,
    resetAt: null,
    hint: "",
  },
  limitTimer: null,
  quotaPoll: null,
  setupPoll: null,
  installStarting: false,
  logsPoll: null,
  tab: "home",
  // Kept so a language switch can repaint server-sourced text without waiting on a refetch.
  lastSetup: null,
  lastQuota: null,
  lastDoctor: null,
};

const els = {
  grid: document.getElementById("grid"),
  search: document.getElementById("search"),
  connSub: document.getElementById("connSub"),
  connSubText: document.getElementById("connSubText"),
  connDot: document.getElementById("connDot"),
  connMeta: document.getElementById("connMeta"),
  modelTag: document.getElementById("modelTag"),
  foot: document.getElementById("foot"),
  sideStatus: document.getElementById("sideStatus"),
  sideStatusText: document.getElementById("sideStatusText"),
  btnLaunch: document.getElementById("btnLaunch"),
  btnLaunchBar: document.getElementById("btnLaunchBar"),
  btnContinueTop: document.getElementById("btnContinueTop"),
  btnContinueChat: document.getElementById("btnContinueChat"),
  btnChatsRefresh: document.getElementById("btnChatsRefresh"),
  chatsList: document.getElementById("chatsList"),
  activeBar: document.getElementById("activeBar"),
  activeBarIcon: document.getElementById("activeBarIcon"),
  activeBarModel: document.getElementById("activeBarModel"),
  toast: document.getElementById("toast"),
  checkGrid: document.getElementById("checkGrid"),
  apiKey: document.getElementById("apiKey"),
  keyCurrent: document.getElementById("keyCurrent"),
  usageUsed: document.getElementById("usageUsed"),
  usageLeft: document.getElementById("usageLeft"),
  usageReq: document.getElementById("usageReq"),
  usageToday: document.getElementById("usageToday"),
  accountState: document.getElementById("accountState"),
  accountMeta: document.getElementById("accountMeta"),
  installLogWrap: document.getElementById("installLogWrap"),
  installLog: document.getElementById("installLog"),
  appLogView: document.getElementById("appLogView"),
  logsMeta: document.getElementById("logsMeta"),
  btnLogsRefresh: document.getElementById("btnLogsRefresh"),
  btnLogsDownload: document.getElementById("btnLogsDownload"),
  btnLogsClear: document.getElementById("btnLogsClear"),
  btnInstallAll: document.getElementById("btnInstallAll"),
  btnStopInstall: document.getElementById("btnStopInstall"),
  btnGenKey: document.getElementById("btnGenKey"),
  axiomBox: document.getElementById("axiomBox"),
  axiomToggle: document.getElementById("axiomToggle"),
  axiomState: document.getElementById("axiomState"),
  axiomMeta: document.getElementById("axiomMeta"),
  btnOpenKiro: document.getElementById("btnOpenKiro"),
  btnAwsSignOut: document.getElementById("btnAwsSignOut"),
  limitBanner: document.getElementById("limitBanner"),
  limitBannerTitle: document.getElementById("limitBannerTitle"),
  limitTimer: document.getElementById("limitTimer"),
  limitBannerHint: document.getElementById("limitBannerHint"),
  btnLimitSwitch: document.getElementById("btnLimitSwitch"),
  pathModal: document.getElementById("pathModal"),
  pathModalTitle: document.getElementById("pathModalTitle"),
  pathModalSub: document.getElementById("pathModalSub"),
  pathInput: document.getElementById("pathInput"),
  pathNow: document.getElementById("pathNow"),
  btnPathSave: document.getElementById("btnPathSave"),
  btnPathReset: document.getElementById("btnPathReset"),
  kiroModal: document.getElementById("kiroModal"),
  kiroUserCode: document.getElementById("kiroUserCode"),
  kiroStatus: document.getElementById("kiroStatus"),
  kiroWait: document.getElementById("kiroWait"),
  kiroWaitTitle: document.getElementById("kiroWaitTitle"),
  kiroWaitSub: document.getElementById("kiroWaitSub"),
  btnKiroOpenAws: document.getElementById("btnKiroOpenAws"),
  btnKiroRetry: document.getElementById("btnKiroRetry"),
  kiroSteps: document.getElementById("kiroSteps"),
  kiroPollSub: document.getElementById("kiroPollSub"),
  kiroElapsed: document.getElementById("kiroElapsed"),
  btnKiroCopy: document.getElementById("btnKiroCopy"),
  langPicker: document.getElementById("langPicker"),
  btnDoctor: document.getElementById("btnDoctor"),
  doctorResult: document.getElementById("doctorResult"),
};

let toastTimer = null;

function save() {
  try {
    localStorage.setItem("fc-results-v2", JSON.stringify(state.results));
  } catch {
    /* quota exceeded or storage disabled — results are only a cache */
  }
}

/**
 * The server can answer with a non-JSON error page, so parsing has to tolerate that
 * instead of throwing a bare SyntaxError at the call site.
 */
async function api(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || t("toast.httpError", { status: res.status });
    reportClientLog(
      "error",
      `${options?.method || "GET"} ${url} → ${res.status}: ${msg}${text && !data ? ` body=${text.slice(0, 400)}` : ""}`,
      "api"
    );
    throw new Error(msg);
  }
  if (data && data.ok === false) {
    const detail = data.error || data.reason?.title || data.message || "ok=false";
    reportClientLog(
      "warn",
      `${options?.method || "GET"} ${url}: ${detail}${data.reason?.raw ? ` raw=${String(data.reason.raw).slice(0, 300)}` : ""}`,
      "api"
    );
  }
  return data ?? {};
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Retitle a button without wiping the inline icon that sits before its label. */
function setBtnLabel(btn, text) {
  if (!btn) return;
  const label = btn.querySelector(".btn-label");
  if (label) label.textContent = text;
  else btn.textContent = text;
}

function toast(msg, isErr = false) {
  let text = String(msg == null ? "" : msg);
  try {
    if (/^\s*\{/.test(text)) {
      const j = JSON.parse(text);
      text = j.error || j.message || j.errorDescription || text;
    }
  } catch {
    /* keep raw */
  }
  if (/invalid password/i.test(text) && !/reset|сброс|OMNIROUTE_PASSWORD|CHANGEME/i.test(text)) {
    text = t("toast.badOmniPassword");
  }
  els.toast.textContent = text;
  els.toast.classList.toggle("err", Boolean(isErr));
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), isErr ? 6500 : 3500);
  if (isErr) reportClientLog("error", text, "toast");
}

function reportClientLog(level, message, source) {
  const text = String(message == null ? "" : message).trim();
  if (!text) return;
  fetch("/api/logs/client", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level, message: text, source: source || "ui" }),
  }).catch(() => {});
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(2)} MB`;
}

async function loadAppLogs({ quiet } = {}) {
  try {
    const data = await fetch("/api/logs").then((r) => r.json());
    if (!data.ok) throw new Error(data.error || t("logs.loadFailed"));
    const text = data.text || "";
    if (els.logsMeta) {
      els.logsMeta.textContent = t("logs.meta", {
        lines: data.lines || 0,
        size: formatBytes(data.bytes),
        path: data.path || "",
      });
    }
    if (els.appLogView) {
      const nearBottom =
        els.appLogView.scrollHeight - els.appLogView.scrollTop - els.appLogView.clientHeight < 80;
      els.appLogView.textContent = text || t("logs.empty");
      if (nearBottom || !els.appLogView.dataset.touched) {
        els.appLogView.scrollTop = els.appLogView.scrollHeight;
      }
    }
  } catch (err) {
    if (!quiet) toast(err.message || t("logs.loadFailed"), true);
    if (els.appLogView && !els.appLogView.textContent) {
      els.appLogView.textContent = err.message || t("logs.loadFailed");
    }
  }
}

function ensureLogsPoll() {
  if (state.logsPoll) return;
  state.logsPoll = setInterval(() => {
    if (state.tab !== "logs" || document.hidden) return;
    loadAppLogs({ quiet: true }).catch(() => {});
  }, 2000);
}

function stopLogsPoll() {
  if (!state.logsPoll) return;
  clearInterval(state.logsPoll);
  state.logsPoll = null;
}

async function downloadAppLogs() {
  try {
    const res = await fetch("/api/logs/download");
    if (!res.ok) throw new Error(t("logs.loadFailed"));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `freeclaude-log-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(t("logs.downloaded"));
  } catch (err) {
    toast(err.message || t("logs.loadFailed"), true);
  }
}

async function clearAppLogs() {
  if (!window.confirm(t("logs.clearConfirm"))) return;
  try {
    const data = await fetch("/api/logs/clear", { method: "POST" }).then((r) => r.json());
    if (!data.ok) throw new Error(data.error || t("logs.loadFailed"));
    toast(t("logs.cleared"));
    await loadAppLogs({ quiet: true });
  } catch (err) {
    toast(err.message || t("logs.loadFailed"), true);
  }
}

function setTab(tab) {
  const allowed = new Set(["home", "models", "chats", "setup", "logs"]);
  state.tab = allowed.has(tab) ? tab : "home";
  try {
    localStorage.setItem("fc-tab", state.tab);
  } catch {
    /* ignore */
  }
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
  const home = document.getElementById("tab-home");
  const models = document.getElementById("tab-models");
  const chats = document.getElementById("tab-chats");
  const setup = document.getElementById("tab-setup");
  const logs = document.getElementById("tab-logs");
  if (home) home.classList.toggle("hidden", state.tab !== "home");
  if (models) models.classList.toggle("hidden", state.tab !== "models");
  if (chats) chats.classList.toggle("hidden", state.tab !== "chats");
  if (setup) setup.classList.toggle("hidden", state.tab !== "setup");
  if (logs) logs.classList.toggle("hidden", state.tab !== "logs");
  if (els.foot) els.foot.classList.toggle("hidden", state.tab !== "models");
  if (state.tab === "setup") {
    loadSetup();
    loadQuota().catch(() => {});
    loadAxiom();
  }
  if (state.tab === "chats") {
    loadChats().catch(() => {});
  }
  if (state.tab === "logs") {
    ensureLogsPoll();
    loadAppLogs().catch(() => {});
  } else {
    stopLogsPoll();
  }
}

function statusOf(id) {
  if (state.testing.has(id)) return { cls: "busy", mark: "" };
  const r = state.results[id];
  if (!r) return { cls: "", mark: "?" };
  if (r.ok) return { cls: "ok", mark: "✓" };
  return { cls: "fail", mark: "!" };
}

function visible() {
  return state.models.filter((m) => {
    const q = state.query;
    if (q && !m.id.toLowerCase().includes(q) && !(m.name || "").toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Brand mark per provider: slug for the CDN logo, plus a local colour + letter fallback. */
const BRANDS = {
  claude: { slug: "claude-color", color: "#d97757", mono: "C" },
  deepseek: { slug: "deepseek-color", color: "#4d6bfe", mono: "D" },
  chatglm: { slug: "chatglm-color", color: "#4268fa", mono: "G" },
  openai: { slug: "openai", color: "#d7dbe6", mono: "O" },
  minimax: { slug: "minimax-color", color: "#f23f5d", mono: "M" },
  qwen: { slug: "qwen-color", color: "#7a5cff", mono: "Q" },
  kiro: { slug: "kiro-color", color: "#7c6cff", mono: "K" },
};

function modelBrand(id) {
  const s = String(id || "").toLowerCase().replace(/^(kiro|kr)\//, "");
  if (/claude|haiku|sonnet|opus/.test(s)) return "claude";
  if (/deepseek/.test(s)) return "deepseek";
  if (/glm|chatglm|zhipu/.test(s)) return "chatglm";
  if (/gpt|openai|luna|sol|terra/.test(s)) return "openai";
  if (/minimax/.test(s)) return "minimax";
  if (/qwen/.test(s)) return "qwen";
  return "kiro";
}

function modelIconSlug(id) {
  return BRANDS[modelBrand(id)].slug;
}

/**
 * The logo is a progressive enhancement: the monogram shows immediately and the CDN image
 * only replaces it once it actually loads, so an offline run never shows a broken icon.
 */
function modelIconImgHtml(id) {
  const src = `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${modelIconSlug(id)}.svg`;
  return (
    `<img src="${src}" alt="" loading="lazy" decoding="async"` +
    ` onload="this.parentNode.classList.add('has-img')" onerror="this.remove()" />`
  );
}

function modelIconHtml(id) {
  const brand = modelBrand(id);
  const b = BRANDS[brand];
  return (
    `<div class="icon" data-brand="${brand}" style="--brand:${b.color}" title="${esc(brand)}">` +
    `<span class="icon-mono" aria-hidden="true">${b.mono}</span>${modelIconImgHtml(id)}</div>`
  );
}

/** Paint an existing `.icon` element (the active-model bar reuses one node). */
function fillModelIcon(el, id) {
  if (!el) return;
  const brand = modelBrand(id);
  const b = BRANDS[brand];
  el.classList.remove("has-img");
  el.dataset.brand = brand;
  el.style.setProperty("--brand", b.color);
  el.title = brand;
  el.innerHTML = `<span class="icon-mono" aria-hidden="true">${b.mono}</span>${modelIconImgHtml(id)}`;
}

function formatCountdown(ms) {
  const left = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateLimitTicker() {
  const lim = state.limit;
  if (!lim.limited && !lim.banned) {
    if (els.limitBanner) els.limitBanner.classList.add("hidden");
    if (els.accountMeta && state.kiroConnected && !lim.banned) {
      /* account meta handled in renderQuota */
    }
    return;
  }

  if (els.limitBanner) els.limitBanner.classList.remove("hidden");
  if (els.limitBannerTitle) {
    els.limitBannerTitle.textContent = lim.banned ? t("limit.titleBanned") : t("limit.title");
  }
  if (els.limitBannerHint) {
    els.limitBannerHint.textContent = lim.banned
      ? t("limit.hintBanned", { reason: shortBanReason(lim.hint) })
      : t("limit.hint");
  }

  let leftMs = 0;
  if (lim.resetAt) leftMs = Math.max(0, lim.resetAt - Date.now());
  const timerText = lim.banned
    ? t("limit.needAnother")
    : leftMs > 0
      ? t("limit.clearsIn", { time: formatCountdown(leftMs) })
      : t("limit.checking");

  if (els.limitTimer) els.limitTimer.textContent = timerText;

  if (els.accountState && lim.limited && !lim.banned) {
    els.accountState.className = "al-state limited";
    els.accountState.textContent =
      leftMs > 0 ? t("account.limitedFor", { time: formatCountdown(leftMs) }) : t("account.limited");
    if (els.accountMeta) {
      els.accountMeta.textContent =
        leftMs > 0 ? t("account.waitOrSwitch", { time: formatCountdown(leftMs) }) : t("account.waitOrSwitchNow");
    }
  }

  if (!lim.banned && lim.resetAt && leftMs <= 0) {
    if (!state._quotaReloadAt || Date.now() - state._quotaReloadAt > 8000) {
      state._quotaReloadAt = Date.now();
      loadQuota().catch(() => {});
    }
  }
}

/** The 1s ticker only has work to do while a limit is counting down. */
function syncLimitTimer() {
  const needed = Boolean(state.limit.limited || state.limit.banned);
  if (needed && !state.limitTimer) {
    state.limitTimer = setInterval(updateLimitTicker, 1000);
  } else if (!needed && state.limitTimer) {
    clearInterval(state.limitTimer);
    state.limitTimer = null;
  }
}

function ensureQuotaPoll() {
  if (state.quotaPoll || document.hidden) return;
  state.quotaPoll = setInterval(() => {
    loadQuota().catch(() => {});
  }, 20000);
}

function stopQuotaPoll() {
  if (!state.quotaPoll) return;
  clearInterval(state.quotaPoll);
  state.quotaPoll = null;
}

function applyAccountLimit(account, serverNow) {
  const a = account || {};
  let resetAt = a.resetAt || null;
  if (!resetAt && a.resetInMs > 0) {
    const skew = serverNow ? Date.now() - Number(serverNow) : 0;
    resetAt = Date.now() - skew + Number(a.resetInMs);
  }
  // A short cooldown (< 60s) is not an "account limit" — otherwise the banner flickers in use.
  // Quota with no timer still counts: the user must switch accounts.
  const MIN_UI_LIMIT_MS = 60 * 1000;
  const leftNow = resetAt ? Math.max(0, resetAt - Date.now()) : Number(a.resetInMs || 0);
  const hasTimer = Boolean(resetAt) || Number(a.resetInMs || 0) > 0;
  const seriousLimit = Boolean(a.limited) && (!hasTimer || leftNow >= MIN_UI_LIMIT_MS);

  const before = `${state.limit.limited}|${state.limit.banned}`;
  state.limit = {
    limited: seriousLimit || Boolean(a.banned),
    banned: Boolean(a.banned),
    resetAt: seriousLimit ? resetAt : null,
    hint: a.banReason || a.resetInText || "",
  };
  const after = `${state.limit.limited}|${state.limit.banned}`;

  syncLimitTimer();
  ensureQuotaPoll();
  updateLimitTicker();
  updateLaunchButtons();
  // Quota polls every 20s; rebuilding the whole grid each time drops scroll and focus.
  if (before !== after) render();
}

function updateLaunchButtons() {
  const hasSession = Boolean(state.omniOnline && state.kiroConnected && !state.limit?.banned);
  const limited = Boolean(state.limit?.limited) && !state.limit?.banned;
  const ready = Boolean(state.activeModel) && hasSession && !limited;
  els.btnLaunch.disabled = !ready;
  if (els.btnLaunchBar) els.btnLaunchBar.disabled = !ready;
  if (els.btnContinueChat) els.btnContinueChat.disabled = !ready;
  if (els.btnContinueTop) els.btnContinueTop.disabled = !ready;

  // The active model is only shown with a live session (OmniRoute + Kiro).
  if (state.activeModel && hasSession) {
    els.activeBar.classList.remove("hidden");
    els.activeBarModel.textContent = state.activeModel;
    fillModelIcon(els.activeBarIcon, state.activeModel);
    els.modelTag.textContent = state.activeModel;
    els.modelTag.classList.remove("soft");
  } else {
    els.activeBar.classList.add("hidden");
    if (els.activeBarIcon) {
      els.activeBarIcon.innerHTML = "";
      els.activeBarIcon.classList.remove("has-img");
      els.activeBarIcon.removeAttribute("data-brand");
      els.activeBarIcon.removeAttribute("title");
    }
    if (!state.omniOnline) {
      els.modelTag.textContent = "OmniRoute offline";
    } else if (!state.kiroConnected) {
      els.modelTag.textContent = t("models.tagNoAccount");
    } else if (state.limit?.banned) {
      els.modelTag.textContent = t("models.tagBanned");
    } else {
      els.modelTag.textContent = t("models.tagNone");
    }
    els.modelTag.classList.add("soft");
  }
}

function updateAuthButtons(connected, opts = {}) {
  const banned = Boolean(opts.banned);
  state.kiroConnected = Boolean(connected) && !banned;
  if (els.btnOpenKiro) {
    els.btnOpenKiro.classList.toggle("hidden", state.kiroConnected && !banned);
    els.btnOpenKiro.disabled = false;
    setBtnLabel(els.btnOpenKiro, banned ? t("key.switchAccount") : t("key.openKiro"));
  }
  if (els.btnAwsSignOut) {
    // Only with a Kiro session or a ban — otherwise there is nothing to sign out of.
    els.btnAwsSignOut.classList.toggle("hidden", !state.kiroConnected && !banned);
    els.btnAwsSignOut.disabled = false;
  }
  if (els.btnGenKey) {
    els.btnGenKey.disabled = !state.kiroConnected;
    els.btnGenKey.title = state.kiroConnected
      ? t("key.genTitleReady")
      : banned
        ? t("key.genTitleBanned")
        : t("key.genTitleNeedLogin");
  }
  if (state.models.length) render();
  else updateLaunchButtons();
}

/**
 * Probe results are cached in localStorage with the wording from whichever language was
 * active at the time, so re-derive the text from `kind` and only fall back to the stored
 * sentence for results saved before kinds existed.
 */
function reasonTitle(reason) {
  if (!reason) return t("toast.error");
  return reason.kind ? t(`err.${reason.kind}.title`) : reason.title || t("toast.error");
}

function reasonHint(reason) {
  if (!reason) return "";
  return reason.kind ? t(`err.${reason.kind}.hint`) : reason.hint || "";
}

function shortBanReason(text) {
  const s = String(text || "");
  if (/suspend|banned|locked/i.test(s)) return t("account.tempBanned");
  return s.slice(0, 120) || t("account.unavailable");
}

function setStatusIcon(el, mode) {
  if (!el) return;
  const ico = el.querySelector(".status-ico") || el;
  if (!ico.classList.contains("status-ico") && ico !== el) return;
  const target = el.querySelector(".status-ico") || (el.classList.contains("status-ico") ? el : null);
  if (!target) return;
  target.classList.remove("on", "off", "pending");
  target.classList.add(mode === true || mode === "on" ? "on" : mode === false || mode === "off" ? "off" : "pending");
}

function renderConn(status) {
  const online = Boolean(status?.omni);
  state.omniOnline = online;
  els.connDot.className = `dot ${online ? "on" : "off"}`;
  const text = online ? "OmniRoute online" : "OmniRoute offline";
  if (els.connSubText) els.connSubText.textContent = text;
  else els.connSub.textContent = text;
  setStatusIcon(els.connSub, online);
  els.connMeta.textContent = online
    ? t("conn.keyPresent", { state: status.token ? status.tokenMasked || t("conn.keyYes") : t("conn.keyNo") })
    : t("conn.omniDown");
  if (els.sideStatusText) els.sideStatusText.textContent = online ? "online" : "offline";
  else els.sideStatus.textContent = online ? "online" : "offline";
  setStatusIcon(els.sideStatus, online);
  if (status?.activeModel) state.activeModel = status.activeModel;
  // /api/status already knows Kiro — keep the UI in sync without waiting for /api/quota.
  if (typeof status?.kiro === "boolean") {
    updateAuthButtons(status.kiro, { banned: Boolean(state.limit?.banned) && status.kiro });
  }
  if (state.models.length) render();
  else updateLaunchButtons();
}

const PATHABLE = new Set(["node", "npm", "omniroute", "claude"]);
const pathDialog = { key: null };

function hidePathModal() {
  if (!els.pathModal) return;
  els.pathModal.classList.add("hidden");
  els.pathModal.setAttribute("aria-hidden", "true");
  pathDialog.key = null;
}

async function openPathDialog(key) {
  if (!els.pathModal) return;
  let info;
  try {
    info = (await api("/api/paths")).paths[key];
  } catch (e) {
    toast(String(e.message || e), true);
    return;
  }
  if (!info) return;

  pathDialog.key = key;
  els.pathModalTitle.textContent = t("path.titleFor", { name: info.label });
  els.pathModalSub.textContent = t("path.subFor", { exe: info.exe });
  els.pathInput.value = info.manual || "";
  els.pathInput.placeholder = info.resolved || `C:\\…\\${info.exe}`;
  els.pathNow.textContent = info.resolved ? t("path.current", { path: info.resolved }) : t("path.notFound");
  els.btnPathReset.classList.toggle("hidden", !info.manual);
  els.pathModal.classList.remove("hidden");
  els.pathModal.setAttribute("aria-hidden", "false");
  els.pathInput.focus();
  els.pathInput.select();
}

async function savePathValue(value) {
  if (!pathDialog.key) return;
  const key = pathDialog.key;
  els.btnPathSave.disabled = true;
  els.btnPathReset.disabled = true;
  try {
    await api("/api/paths", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    toast(value ? t("path.saved") : t("path.cleared"));
    hidePathModal();
    loadSetup();
  } catch (e) {
    toast(String(e.message || e), true);
  } finally {
    els.btnPathSave.disabled = false;
    els.btnPathReset.disabled = false;
  }
}

function renderSetup(setup) {
  state.lastSetup = setup;
  const labels = {
    node: t("check.node"),
    npm: t("check.npm"),
    omniroute: t("check.omniroute"),
    claude: t("check.claude"),
    omniRunning: t("check.omniRunning"),
    token: t("check.token"),
  };
  const icons = {
    node: "i-node",
    npm: "i-box",
    omniroute: "i-route",
    claude: "i-terminal",
    omniRunning: "i-server",
    token: "i-key",
  };
  const order = ["node", "npm", "omniroute", "claude", "omniRunning", "token"];
  els.checkGrid.innerHTML = order
    .map((key) => {
      const item = setup.checks[key];
      const gear = PATHABLE.has(key)
        ? `<button class="check-gear" type="button" data-path-key="${key}" title="${esc(t("setup.pathManual"))}" aria-label="${esc(t("setup.pathManualFor", { name: labels[key] }))}"><svg class="ic" aria-hidden="true"><use href="#i-gear"/></svg></button>`
        : "";
      const manual = item.manual ? " manual" : "";
      return `<div class="check-item ${item.ok ? "ok" : "bad"}${manual}">
        <div class="check-top">
          <div class="label"><span class="check-ico" aria-hidden="true"><svg class="ic"><use href="#${icons[key]}"/></svg></span>${labels[key]}</div>
          ${gear}
        </div>
        <div class="value"><span class="mark">${item.ok ? "✓" : "!"}</span>${esc(item.ok ? t("setup.ok") : t("setup.missing"))}</div>
        <div class="detail">${esc(item.detail)}</div>
      </div>`;
    })
    .join("");

  if (setup.checks.token.masked) {
    if (els.keyCurrent) els.keyCurrent.textContent = setup.checks.token.masked;
    if (!els.apiKey.value) els.apiKey.placeholder = setup.checks.token.masked;
  } else if (els.keyCurrent) {
    els.keyCurrent.textContent = t("key.none");
  }

  const inst = setup.install || {};
  if (inst.running || (inst.log && inst.log.length)) {
    els.installLogWrap.classList.remove("hidden");
    const text = (inst.log || []).join("\n");
    if (els.installLog.textContent !== text) {
      const nearBottom =
        els.installLog.scrollHeight - els.installLog.scrollTop - els.installLog.clientHeight < 80;
      els.installLog.textContent = text;
      if (nearBottom || inst.running) els.installLog.scrollTop = els.installLog.scrollHeight;
    }
  }
  els.btnInstallAll.disabled = Boolean(inst.running);
  setBtnLabel(
    els.btnInstallAll,
    inst.running ? `${t("setup.installing")}${inst.step ? ` (${inst.step})` : ""}` : t("setup.installAll")
  );
  if (els.btnStopInstall) {
    els.btnStopInstall.classList.toggle("hidden", !inst.running);
    els.btnStopInstall.disabled = !inst.running;
  }
}

function renderQuota(data) {
  state.lastQuota = data;
  const u = data.usage || {};
  if (els.keyCurrent) els.keyCurrent.textContent = data.activeKey || u.masked || t("key.none");
  if (els.usageUsed) els.usageUsed.textContent = formatTokens(u.usedTokens);
  if (els.usageLeft) els.usageLeft.textContent = u.unlimited || u.remaining == null ? "∞" : formatTokens(u.remaining);
  if (els.usageReq) els.usageReq.textContent = String(u.requests ?? 0);
  if (els.usageToday) els.usageToday.textContent = formatTokens(u.todayTokens);

  const a = data.account || {};
  updateAuthButtons(Boolean(a.connected), { banned: Boolean(a.banned) });
  applyAccountLimit(a, data.serverNow);

  if (els.accountState && els.accountMeta) {
    if (a.banned) {
      els.accountState.className = "al-state limited";
      els.accountState.textContent = t("account.blocked");
      els.accountMeta.textContent = shortBanReason(a.banReason);
    } else if (!a.connected) {
      els.accountState.className = "al-state off";
      els.accountState.textContent = t("account.offline");
      els.accountMeta.textContent = t("account.offlineHint");
    } else if (a.limited) {
      // live text updated by updateLimitTicker
      updateLimitTicker();
    } else {
      const k = (a.kiro || []).find((x) => x.state === "ok") || (a.kiro || [])[0];
      els.accountState.className = "al-state ok";
      els.accountState.textContent = t("account.active");
      // Degraded means the state came from OmniRoute over HTTP, without the local
      // database — the account is fine, only the counters are missing.
      els.accountMeta.textContent = a.degraded
        ? t("account.degraded")
        : k?.oauthLeftText
          ? t("account.oauthLeft", { time: k.oauthLeftText })
          : t("account.ok");
    }
  }
}

function applySignedOutUi() {
  updateAuthButtons(false);
  state.limit = { limited: false, banned: false, resetAt: null, hint: "" };
  state.models = [];
  state.activeModel = null;
  state.results = {};
  syncLimitTimer();
  updateLimitTicker();
  if (els.keyCurrent) els.keyCurrent.textContent = t("key.none");
  if (els.apiKey) {
    els.apiKey.value = "";
    els.apiKey.placeholder = t("key.placeholder");
  }
  if (els.accountState) {
    els.accountState.className = "al-state off";
    els.accountState.textContent = t("account.offline");
  }
  if (els.accountMeta) els.accountMeta.textContent = t("account.offlineHint");
  if (els.foot) els.foot.textContent = t("grid.noAccount");
  updateLaunchButtons();
  render();
}

async function awsSignOut() {
  if (els.btnAwsSignOut) els.btnAwsSignOut.disabled = true;
  try {
    reportClientLog("info", "AWS sign-out clicked", "auth");
    try {
      window.open("https://view.awsapps.com/start/#/signout", "_blank");
    } catch {
      /* ignore */
    }
    const r = await fetch("/api/kiro/aws-signout", { method: "POST" }).then((x) => x.json());
    if (!r.ok) {
      toast(r.error || t("kiro.awsSignOutFailed"), true);
      return;
    }
    applySignedOutUi();
    reportClientLog(
      "info",
      `AWS sign-out ok removed=${r.purged?.removed ?? "?"} keyCleared=${r.keyCleared} keysRemoved=${r.keysRemoved ?? "?"} omniRestarted=${r.omniRestarted}`,
      "auth"
    );
    toast(t("kiro.signedOut"));
    await loadQuota().catch(() => {});
    await loadSetup().catch(() => {});
  } catch (e) {
    toast(String(e.message || e), true);
  } finally {
    if (els.btnAwsSignOut) els.btnAwsSignOut.disabled = false;
  }
}

async function openKiroAuth() {
  const kiroBtnLabel = els.btnOpenKiro?.querySelector(".btn-label")?.textContent || t("key.openKiro");
  if (els.btnOpenKiro) els.btnOpenKiro.disabled = true;
  // Starting the flow can take a while when OmniRoute has to be restarted first
  // (for example after its panel password was reset), so say something meanwhile.
  setBtnLabel(els.btnOpenKiro, t("key.connecting"));
  try {
    reportClientLog("info", "Kiro sign-in / switch account started", "auth");
    // Drop OmniRoute's old Kiro sessions before starting a new sign-in.
    const logoutRes = await fetch("/api/kiro/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((x) => x.json())
      .catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (logoutRes?.ok) applySignedOutUi();
    reportClientLog(
      logoutRes?.ok ? "info" : "warn",
      `Kiro logout before auth: ok=${Boolean(logoutRes?.ok)} removed=${logoutRes?.removed ?? "?"} keyCleared=${logoutRes?.keyCleared} omniRestarted=${logoutRes?.omniRestarted} err=${logoutRes?.error || ""}`,
      "auth"
    );

    const r = await fetch("/api/kiro/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ open: false }),
    }).then((x) => x.json());
    if (!r.ok) {
      toast(r.error || t("kiro.startFailed"), true);
      return;
    }

    kiroAuth.active = true;
    kiroAuth.fetchFails = 0;
    kiroAuth.intervalMs = Math.max(3000, (Number(r.interval) || 5) * 1000);
    kiroAuth.verificationUriComplete = r.verificationUriComplete || "";

    if (els.kiroUserCode) els.kiroUserCode.textContent = r.userCode || "—";
    setKiroStatus(t("kiro.simpleTitle"));
    setKiroStep("code");
    startKiroClock();
    setKiroWait("wait");
    setKiroRetryButton("waiting");
    if (els.kiroModal) {
      els.kiroModal.classList.remove("hidden");
      els.kiroModal.setAttribute("aria-hidden", "false");
    }

    await openAwsWindow(kiroAuth.verificationUriComplete, { signOutFirst: true });
    setKiroWait("wait");

    if (kiroAuth.timer) clearTimeout(kiroAuth.timer);
    kiroAuth.timer = setTimeout(pollKiroLoop, 2500);
  } catch (e) {
    toast(String(e.message || e), true);
  } finally {
    setBtnLabel(els.btnOpenKiro, kiroBtnLabel);
    // Re-enabling while polling is live would let a second click start an overlapping session.
    if (els.btnOpenKiro) els.btnOpenKiro.disabled = kiroAuth.active;
  }
}

function formatTokens(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

async function loadQuota() {
  const data = await fetch("/api/quota").then((r) => r.json());
  if (data.error) throw new Error(data.error);
  renderQuota(data);
  return data;
}

const kiroAuth = {
  timer: null,
  intervalMs: 5000,
  attempts: 0,
  fetchFails: 0,
  active: false,
  verificationUriComplete: "",
  awsWin: null,
  startedAt: 0,
  tick: null,
};

/*
 * The device flow has no progress to report, so the modal shows which stage it is on.
 * Order matters: everything before the current step is drawn as finished.
 */
const KIRO_STEPS = ["open", "code", "link", "models"];

/** `name` may also be "done", which completes every step. */
function setKiroStep(name, mode = "active") {
  if (!els.kiroSteps) return;
  const idx = name === "done" ? KIRO_STEPS.length : KIRO_STEPS.indexOf(name);
  if (idx < 0) return;
  for (const li of els.kiroSteps.querySelectorAll(".kiro-step")) {
    const i = KIRO_STEPS.indexOf(li.dataset.step);
    li.classList.toggle("done", i < idx);
    li.classList.toggle("active", i === idx && mode === "active");
    li.classList.toggle("error", i === idx && mode === "error");
  }
}

function startKiroClock() {
  kiroAuth.startedAt = Date.now();
  kiroAuth.attempts = 0;
  stopKiroClock(true);
  kiroAuth.tick = setInterval(renderKiroElapsed, 1000);
  renderKiroElapsed();
}

function stopKiroClock(keepText = false) {
  if (kiroAuth.tick) {
    clearInterval(kiroAuth.tick);
    kiroAuth.tick = null;
  }
  if (!keepText && els.kiroElapsed) els.kiroElapsed.textContent = "";
}

function renderKiroElapsed() {
  if (!els.kiroElapsed || !kiroAuth.startedAt) return;
  const sec = Math.floor((Date.now() - kiroAuth.startedAt) / 1000);
  els.kiroElapsed.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

async function copyKiroCode() {
  const code = (els.kiroUserCode?.textContent || "").trim();
  if (!code || /^—+$/.test(code)) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(code);
    ok = true;
  } catch {
    // Clipboard API needs a secure context; the local page is http, so fall back.
    try {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch {
      ok = false;
    }
  }
  toast(ok ? t("kiro.copied", { code }) : t("kiro.copyFailed"), !ok);
}

/**
 * Polling has stopped for good. Clearing `active` too is what keeps the modal from
 * claiming the login "continues in background" when nothing is running.
 */
function stopKiroPolling() {
  kiroAuth.active = false;
  if (kiroAuth.timer) {
    clearTimeout(kiroAuth.timer);
    kiroAuth.timer = null;
  }
  if (els.btnOpenKiro) els.btnOpenKiro.disabled = false;
}

/**
 * The click handler reads `dataset.action`, not the label: comparing against a translated
 * caption would silently stop working the moment the language changes.
 */
function setKiroRetryButton(mode) {
  const btn = els.btnKiroRetry;
  if (!btn) return;
  const modes = {
    waiting: { key: "kiro.retryWaiting", disabled: true, action: "" },
    retry: { key: "kiro.retry", disabled: false, action: "retry" },
    done: { key: "kiro.done", disabled: false, action: "" },
  };
  const m = modes[mode] || modes.waiting;
  btn.dataset.i18n = m.key;
  btn.dataset.action = m.action;
  btn.textContent = t(m.key);
  btn.disabled = m.disabled;
}

function setKiroStatus(text, isErr = false) {
  if (!els.kiroStatus) return;
  els.kiroStatus.textContent = text;
  els.kiroStatus.style.color = isErr ? "var(--bad)" : "var(--muted)";
}

function setKiroWait(state, title, sub) {
  if (!els.kiroWait) return;
  els.kiroWait.classList.remove("done", "error");
  if (state === "done") els.kiroWait.classList.add("done");
  if (state === "error") els.kiroWait.classList.add("error");
  // Simple modal: keep the short prompt while waiting; only swap text on error/done.
  if (els.kiroWaitTitle) {
    if (state === "error" && title) els.kiroWaitTitle.textContent = title;
    else if (state === "done") els.kiroWaitTitle.textContent = t("kiro.simpleDone");
    else els.kiroWaitTitle.textContent = t("kiro.simpleTitle");
  }
  if (els.kiroWaitSub) {
    if (state === "error" && (sub || title)) {
      els.kiroWaitSub.textContent = sub || title;
      els.kiroWaitSub.classList.remove("hidden");
    } else {
      els.kiroWaitSub.textContent = "";
      els.kiroWaitSub.classList.add("hidden");
    }
  }
}

const AWS_SIGNOUT_URL = "https://view.awsapps.com/start/#/signout";

/** Open AWS device auth in current browser tab, signing out first to clear old cookies. */
async function openAwsWindow(url, { signOutFirst = true } = {}) {
  if (!url) return false;
  try {
    if (signOutFirst) {
      // Step 1: Open signout to purge cookies in the active browser tab
      const w = window.open(AWS_SIGNOUT_URL, "_blank");
      if (w) {
        kiroAuth.awsWin = w;
        // Step 2: After allowing AWS to clear session tokens, redirect to device auth
        setTimeout(() => {
          try {
            w.location.href = url;
          } catch {
            window.open(url, "_blank");
          }
        }, 1200);
        return true;
      }
    } else {
      const w = window.open(url, "_blank");
      if (w) {
        kiroAuth.awsWin = w;
        return true;
      }
    }
  } catch {
    /* popup blocked, try server fallback */
  }
  try {
    const r = await fetch("/api/kiro/open-aws", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, fresh: false }),
    }).then((x) => x.json());
    return Boolean(r.ok);
  } catch {
    return false;
  }
}

function hideKiroModal() {
  if (els.kiroModal) {
    els.kiroModal.classList.add("hidden");
    els.kiroModal.setAttribute("aria-hidden", "true");
  }
  if (els.btnOpenKiro) els.btnOpenKiro.disabled = false;
}

function cancelKiroAuth() {
  kiroAuth.active = false;
  if (kiroAuth.timer) {
    clearTimeout(kiroAuth.timer);
    kiroAuth.timer = null;
  }
  stopKiroClock();
  fetch("/api/kiro/cancel", { method: "POST" }).catch(() => {});
  hideKiroModal();
}

/** The X only hides the UI; polling keeps running in the background. */
function closeKiroModal() {
  if (kiroAuth.active) {
    toast(t("kiro.background"));
    hideKiroModal();
    return;
  }
  cancelKiroAuth();
}

async function finishKiroSuccess(r) {
  setKiroStatus(t("kiro.codeConfirmed"));
  setKiroStep("link");
  setKiroWait("wait");
  toast(t("kiro.connected"));
  kiroAuth.active = false;
  // Drop sticky limit/ban from the previous Builder ID before quota refreshes.
  state.limit = { limited: false, banned: false, resetAt: null, hint: "" };
  syncLimitTimer();
  updateLimitTicker();
  // AWS approved the device code, so the account is connected even if the status/quota
  // calls below fail. Without this the key step below would repaint the UI as logged out.
  updateAuthButtons(true);
  setKiroRetryButton("done");
  try {
    if (kiroAuth.awsWin && !kiroAuth.awsWin.closed) kiroAuth.awsWin.close();
  } catch {
    /* ignore */
  }

  if (r.keyIssued?.masked) {
    if (els.keyCurrent) els.keyCurrent.textContent = r.keyIssued.masked;
    if (els.apiKey) els.apiKey.placeholder = r.keyIssued.masked;
    toast(
      r.keyIssued.reused
        ? t("kiro.keyReused", { key: r.keyIssued.masked })
        : t("kiro.keyIssued", { key: r.keyIssued.masked })
    );
  } else if (r.keyIssued?.error) {
    toast(t("kiro.keyFailed", { error: r.keyIssued.error }), true);
    try {
      await generateKey();
    } catch {
      /* ignore */
    }
  } else {
    try {
      await generateKey();
    } catch {
      /* ignore */
    }
  }

  setKiroStep("models");
  setKiroStatus(t("kiro.loadingModels"));
  setKiroWait("wait");

  setTab("models");
  // Up to 25s: OmniRoute sometimes serves the models a while after the OAuth handshake.
  let gotModels = Number(r.modelsCount || 0) > 0;
  for (let i = 0; i < 20; i++) {
    try {
      await loadQuota().catch(() => {});
      await refreshStatus().catch(() => {});
      await loadModels();
      if (state.models.length && state.kiroConnected) {
        gotModels = true;
        break;
      }
      if (state.models.length) {
        gotModels = true;
        if (state.kiroConnected) break;
      }
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 1200));
  }

  stopKiroClock(true);
  if (!gotModels) {
    setKiroStep("models", "error");
    setKiroWait("error", t("kiro.modelsLate"), t("kiro.modelsLateSub"));
    toast(t("kiro.modelsLateToast"), true);
  } else if (!state.kiroConnected) {
    // The models are here; the status call will catch up on its own.
    updateAuthButtons(true);
    await refreshStatus().catch(() => {});
  } else {
    toast(t("kiro.modelsCount", { n: state.models.length }));
  }

  if (gotModels) {
    setKiroStep("done");
    setKiroStatus(t("kiro.done"));
    setKiroWait("done");
  }

  setTimeout(hideKiroModal, gotModels ? 900 : 2500);
}

async function pollKiroLoop() {
  if (!kiroAuth.active) return;
  try {
    const r = await fetch("/api/kiro/poll", { method: "POST" }).then((x) => x.json());
    kiroAuth.fetchFails = 0;
    if (!kiroAuth.active && !r.success) return;
    if (r.success) {
      // Server already finalized the OAuth session. UI refresh must not undo a good login
      // if FreeClaude briefly blips (Failed to fetch) right after AWS approval.
      kiroAuth.active = false;
      try {
        await finishKiroSuccess(r);
      } catch (e) {
        reportClientLog("warn", `finish after auth: ${e && e.message ? e.message : e}`, "auth");
        updateAuthButtons(true);
        setKiroWait("done");
        toast(t("kiro.connected"));
        setTimeout(hideKiroModal, 900);
        loadQuota().catch(() => {});
        loadModels().catch(() => {});
        refreshStatus().catch(() => {});
      }
      return;
    }
    if (!kiroAuth.active) return;
    if (r.pending || r.error === "authorization_pending" || r.error === "slow_down") {
      kiroAuth.attempts += 1;
      setKiroStep("code");
      setKiroStatus(r.slowDown ? t("kiro.slowDown") : t("kiro.awaitingConfirm"));
      setKiroWait("wait");
      const wait = r.slowDown ? Math.max(kiroAuth.intervalMs + 5000, 10000) : kiroAuth.intervalMs;
      if (els.kiroPollSub) {
        els.kiroPollSub.textContent = t("kiro.step.code.attempt", {
          n: kiroAuth.attempts,
          sec: Math.round(wait / 1000),
        });
      }
      kiroAuth.timer = setTimeout(pollKiroLoop, wait);
      return;
    }
    const msg = r.errorDescription || r.error || t("kiro.authError");
    stopKiroPolling();
    stopKiroClock(true);
    setKiroStep("code", "error");
    setKiroStatus(msg, true);
    setKiroWait("error", t("kiro.finishFailed"), t("kiro.finishFailedSub", { error: msg }));
    setKiroRetryButton("retry");
  } catch (e) {
    if (!kiroAuth.active) return;
    const msg = String(e.message || e);
    // Brief FreeClaude/OmniRoute blips after AWS "Request approved" used to abort the whole login.
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg) && kiroAuth.fetchFails < 10) {
      kiroAuth.fetchFails += 1;
      setKiroWait("wait");
      setKiroStatus(t("kiro.connRetry"));
      kiroAuth.timer = setTimeout(pollKiroLoop, 2000);
      return;
    }
    stopKiroPolling();
    stopKiroClock(true);
    setKiroStep("code", "error");
    setKiroStatus(msg, true);
    setKiroWait("error", t("kiro.connError"), msg);
    setKiroRetryButton("retry");
  }
}

function render() {
  updateLaunchButtons();
  updateLimitTicker();

  if (state.limit.limited || state.limit.banned) {
    els.grid.classList.add("dimmed");
  } else {
    els.grid.classList.remove("dimmed");
  }

  const list = visible();

  if (!list.length) {
    if (state.limit.limited || state.limit.banned) {
      els.grid.innerHTML = `<div class="empty limit-empty">${esc(t("grid.limited"))}</div>`;
    } else if (!state.omniOnline) {
      els.grid.innerHTML = `<div class="empty">${esc(t("grid.offline"))}</div>`;
    } else if (!state.kiroConnected) {
      els.grid.innerHTML = `<div class="empty">${esc(t("grid.noAccount"))}</div>`;
    } else if (!state.models.length) {
      els.grid.innerHTML = `<div class="empty">${esc(t("grid.empty"))}</div>`;
    } else {
      els.grid.innerHTML = `<div class="empty">${esc(t("grid.noMatch"))}</div>`;
    }
    return;
  }

  els.grid.innerHTML = list
    .map((m) => {
      const testing = state.testing.has(m.id);
      const st = statusOf(m.id);
      const r = state.results[m.id];
      let meta;
      if (testing) {
        meta = `<div class="probe"><span class="probe-bars"><i></i><i></i><i></i><i></i></span> ${esc(t("grid.probing"))}</div>`;
      } else if (state.limit.limited || state.limit.banned) {
        meta = esc(state.limit.banned ? t("grid.banned") : t("grid.limitedShort"));
      } else if (r && r.ok) {
        meta = `${r.ms} ms · ${esc((r.reply || "OK").slice(0, 36))}`;
      } else if (r) {
        // Plain reason on the card, the fix and the original English behind the tooltip.
        const label = r.reason ? reasonTitle(r.reason) : (r.error || t("toast.error")).slice(0, 64);
        const tip = r.reason ? [reasonHint(r.reason), r.reason.raw].filter(Boolean).join("\n\n") : r.error || "";
        meta = `<span class="probe-err" title="${esc(tip)}">${r.status ? `${esc(r.status)} · ` : ""}${esc(label)}</span>`;
      } else {
        meta = "—";
      }
      const hasSession = Boolean(state.omniOnline && state.kiroConnected && !state.limit.banned);
      const selected = hasSession && m.id === state.activeModel;
      const locked = !hasSession || state.limit.limited;
      const actionBtn = selected
        ? `<button class="btn launch small" data-open="${esc(m.id)}" type="button" ${locked ? "disabled" : ""}>${esc(t("grid.open"))}</button>`
        : `<button class="btn okish small" data-connect="${esc(m.id)}" type="button" ${testing || locked ? "disabled" : ""}>${esc(t("grid.connect"))}</button>`;
      return `<article class="card ${selected ? "selected" : ""} ${testing ? "testing" : ""} ${locked ? "limited" : ""}">
        <div class="card-top">
          <div style="display:flex;gap:10px;align-items:flex-start">
            ${modelIconHtml(m.id)}
            <div>
              <div class="id">${esc(m.id)}${selected ? '<span class="badge-on">ON</span>' : ""}</div>
              <div class="name">${esc(m.name)}</div>
            </div>
          </div>
          <div class="status ${st.cls}">${st.mark}</div>
        </div>
        <div class="meta">${meta}</div>
        <div class="row">
          <button class="btn ghost small" data-test="${esc(m.id)}" type="button" ${testing || locked ? "disabled" : ""}>${esc(t("grid.test"))}</button>
          ${actionBtn}
        </div>
      </article>`;
    })
    .join("");
}

async function loadSetup() {
  const setup = await fetch("/api/setup").then((r) => r.json());
  renderSetup(setup);
  return setup;
}

function formatKb(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "";
  return t("common.kb", { n: Math.round(n / 1024) });
}

/** The checkbox only ever shows what the server reports, so it cannot drift out of sync. */
function renderAxiom(s) {
  state.lastAxiom = s;
  const enabled = Boolean(s?.enabled);
  const available = Boolean(s?.available);
  // Persona text is not shipped in the release — hide the dead card for everyone who
  // does not already have it, so users stop asking why the toggle does nothing.
  if (els.axiomBox) {
    els.axiomBox.classList.toggle("hidden", !available);
    els.axiomBox.classList.toggle("on", enabled);
  }
  if (!available) return;
  if (els.axiomToggle) {
    els.axiomToggle.checked = enabled;
    els.axiomToggle.disabled = false;
  }
  if (els.axiomState) els.axiomState.textContent = enabled ? t("axiom.on") : t("axiom.off");
  if (els.axiomMeta) {
    const size = formatKb(s?.bytes);
    els.axiomMeta.textContent = enabled
      ? `~/.claude/CLAUDE.md${size ? ` · ${size}` : ""}`
      : t("axiom.ready");
  }
}

async function loadAxiom() {
  try {
    renderAxiom(await api("/api/axiom"));
  } catch {
    renderAxiom({ available: false, enabled: false });
  }
}

async function onAxiomToggle() {
  const wanted = els.axiomToggle.checked;
  els.axiomToggle.disabled = true;
  if (els.axiomState) els.axiomState.textContent = t("axiom.applying");
  try {
    const s = await api("/api/axiom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: wanted }),
    });
    renderAxiom(s);
    toast(s.enabled ? t("axiom.enabled") : t("axiom.disabled"));
  } catch (e) {
    toast(String(e.message || e), true);
    await loadAxiom();
  }
}

async function refreshStatus() {
  const s = await fetch("/api/status").then((r) => r.json());
  renderConn(s);
  return s;
}

const DOCTOR_ICON = { ok: "i-check", warn: "i-alert", error: "i-alert" };

function doctorRow(severity, code, detail) {
  const icon = DOCTOR_ICON[severity] || "i-alert";
  const title = t(`doctor.${code}.title`);
  const hint = t(`doctor.${code}.hint`);
  return `<div class="doctor-item ${severity}">
      <svg class="ic" aria-hidden="true"><use href="#${icon}"/></svg>
      <div>
        <div class="doctor-item-title">${esc(title)}</div>
        <div class="doctor-item-hint">${esc(hint)}</div>
        ${detail ? `<div class="doctor-item-detail">${esc(detail)}</div>` : ""}
      </div>
    </div>`;
}

function renderDoctor(report) {
  if (!els.doctorResult) return;
  state.lastDoctor = report;
  els.doctorResult.classList.remove("hidden");

  if (report.error) {
    els.doctorResult.innerHTML = `<div class="doctor-item error">
        <svg class="ic" aria-hidden="true"><use href="#i-alert"/></svg>
        <div>
          <div class="doctor-item-title">${esc(t("doctor.failed"))}</div>
          <div class="doctor-item-detail">${esc(report.error)}</div>
        </div>
      </div>`;
    return;
  }

  const parts = (report.fixed || []).map((code) => doctorRow("ok", code, null));
  // Whatever survived the repair is on the user: a login or a decision we will not make.
  parts.push(...(report.findings || []).map((f) => doctorRow(f.severity, f.code, f.detail)));

  if (!parts.length) {
    parts.push(`<div class="doctor-item ok">
        <svg class="ic" aria-hidden="true"><use href="#i-check"/></svg>
        <div><div class="doctor-item-title">${esc(t("doctor.ok"))}</div></div>
      </div>`);
  }
  els.doctorResult.innerHTML = parts.join("");
}

async function runDoctorCheck() {
  if (!els.btnDoctor) return;
  const label = els.btnDoctor.querySelector("span");
  const before = label ? label.textContent : "";
  els.btnDoctor.disabled = true;
  if (label) label.textContent = t("doctor.checking");
  try {
    const report = await api("/api/doctor", { method: "POST" });
    renderDoctor(report);
    if (report.fixed && report.fixed.length) {
      loadSetup().catch(() => {});
      loadQuota().catch(() => {});
    }
  } catch (e) {
    renderDoctor({ error: String(e.message || e) });
  } finally {
    els.btnDoctor.disabled = false;
    if (label) label.textContent = before || t("doctor.check");
  }
}

function markActiveLanguage() {
  if (!els.langPicker) return;
  for (const btn of els.langPicker.querySelectorAll("[data-lang]")) {
    const on = btn.dataset.lang === lang.code;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

/**
 * Repaints in place instead of reloading: a reload during a Kiro sign-in would drop the
 * device code. Cached payloads are re-rendered first so nothing flashes back to a default,
 * then the same calls run again to pick up the server-side wording.
 */
async function setLanguage(next) {
  if (!lang.dict[next] || next === lang.code) return;
  const previous = lang.code;
  lang.code = next;
  try {
    await api("/api/lang", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: next }),
    });
  } catch (e) {
    lang.code = previous;
    toast(String(e.message || e), true);
    return;
  }

  applyI18n();
  markActiveLanguage();
  if (state.lastSetup) renderSetup(state.lastSetup);
  if (state.lastQuota) renderQuota(state.lastQuota);
  if (state.lastAxiom) renderAxiom(state.lastAxiom);
  if (state.lastDoctor) renderDoctor(state.lastDoctor);
  render();
  if (state.models.length) els.foot.textContent = t("models.count", { n: state.models.length });
  toast(t("lang.switched"));

  refreshStatus().catch(() => {});
  loadSetup().catch(() => {});
  loadQuota().catch(() => {});
}

async function bootstrap() {
  els.foot.textContent = "";
  updateAuthButtons(false);
  // Status first — so F5 never sits on "Checking…" while setup/quota crawl.
  try {
    await refreshStatus();
  } catch {
    renderConn({ omni: false });
  }
  await loadSetup().catch(() => {});
  try {
    const s = await fetch("/api/bootstrap", { method: "POST" }).then((r) => r.json());
    renderConn(s);
  } catch {
    /* keep last status */
  }
  await loadSetup().catch(() => {});
  await loadQuota().catch(() => {});
}

async function loadModels() {
  await refreshStatus();
  if (!state.kiroConnected) {
    state.models = [];
    state.activeModel = null;
    els.foot.textContent = t("grid.noAccount");
    render();
    return;
  }
  const res = await fetch("/api/models");
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data.reason ? `${reasonTitle(data.reason)}. ${reasonHint(data.reason)}` : data.error || t("toast.modelsLoadFailed")
    );
  }
  state.models = data.models || [];
  state.activeModel = data.activeModel || state.activeModel;
  els.foot.textContent = t("models.count", { n: state.models.length });
  render();
}

async function testModel(id) {
  if (!state.kiroConnected) {
    toast(t("toast.needKiro"), true);
    return;
  }
  if (state.testing.has(id)) return;
  state.testing.add(id);
  render();
  try {
    const r = await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: id }),
    }).then((x) => x.json());
    if (r && r.updateRequired) {
      showUpdateLock(r.telegram);
      return;
    }
    state.results[id] = r;
    save();
    const reason = r?.reason;
    if (r.ok) {
      toast(`OK · ${id}`);
    } else {
      toast(reason ? `${reasonTitle(reason)}. ${reasonHint(reason)}` : r.error || t("toast.testFailed"), true);
      // A ban also changes the account state, so refresh it instead of leaving a stale banner.
      if (reason && (reason.kind === "banned" || reason.kind === "quota")) {
        await loadQuota().catch(() => {});
      }
    }
  } catch (e) {
    state.results[id] = { ok: false, error: String(e.message || e) };
    save();
    toast(String(e.message || e), true);
  } finally {
    state.testing.delete(id);
    render();
  }
}

async function connectModel(id) {
  if (!state.kiroConnected) {
    toast(t("toast.needKiro"), true);
    return;
  }
  try {
    const r = await api("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: id }),
    });
    if (!r.ok) {
      toast(r.error || t("toast.error"), true);
      return;
    }
    state.activeModel = id;
    render();
    await refreshStatus();
    toast(t("toast.connected", { id }));
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

async function launchClaude(opts = {}) {
  const mode = opts.mode || "new";
  const sessionId = opts.sessionId || "";
  const cwd = opts.cwd || "";
  if (!state.kiroConnected) {
    toast(t("toast.needKiro"), true);
    return;
  }
  if (!state.activeModel) {
    toast(t("toast.needModel"), true);
    return;
  }
  const buttons = [els.btnLaunch, els.btnLaunchBar, els.btnContinueChat, els.btnContinueTop].filter(Boolean);
  buttons.forEach((b) => (b.disabled = true));
  try {
    const r = await api("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, sessionId, cwd }),
    });
    if (!r.ok) toast(r.error || t("toast.launchFailed"), true);
    else if (mode === "continue") toast(t("chats.continued"));
    else if (mode === "resume") toast(t("chats.opened"));
    else toast(`Claude: ${r.model}`);
  } catch (e) {
    toast(String(e.message || e), true);
  } finally {
    updateLaunchButtons();
  }
}

function shortAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return t("chats.ago", { time: `${s}s` });
  const m = Math.floor(s / 60);
  if (m < 60) return t("chats.ago", { time: `${m}m` });
  const h = Math.floor(m / 60);
  if (h < 48) return t("chats.ago", { time: `${h}h` });
  const d = Math.floor(h / 24);
  return t("chats.ago", { time: `${d}d` });
}

function shortPath(p) {
  const s = String(p || "");
  if (!s) return "";
  if (s.length <= 48) return s;
  return `…${s.slice(-46)}`;
}

function renderChats(sessions) {
  if (!els.chatsList) return;
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) {
    els.chatsList.innerHTML = `<div class="chats-empty">${esc(t("chats.empty"))}</div>`;
    return;
  }
  els.chatsList.innerHTML = list
    .map(
      (s) => `<div class="chat-row" data-session-id="${esc(s.id)}" data-cwd="${esc(s.cwd || "")}">
        <div class="chat-main">
          <div class="chat-title" title="${esc(s.title || s.id)}">${esc(s.title || s.id)}</div>
          <div class="chat-meta">${esc(shortAgo(s.mtime))}${s.cwd ? ` · ${esc(shortPath(s.cwd))}` : ""}</div>
        </div>
        <button type="button" class="btn ghost small" data-chat-resume>${esc(t("chats.resume"))}</button>
      </div>`
    )
    .join("");
}

async function loadChats() {
  if (!els.chatsList) return;
  try {
    const r = await fetch("/api/claude/sessions?limit=25").then((x) => x.json());
    if (!r.ok) throw new Error(r.error || t("chats.loadFailed"));
    renderChats(r.sessions || []);
  } catch (e) {
    els.chatsList.innerHTML = `<div class="chats-empty">${esc(e.message || t("chats.loadFailed"))}</div>`;
  }
}

async function clearKey() {
  if (!confirm(t("toast.confirmClearKey"))) return;
  try {
    const r = await api("/api/key/clear", { method: "POST" });
    if (!r.ok) throw new Error(r.error || "clear failed");
    els.apiKey.value = "";
    if (els.keyCurrent) els.keyCurrent.textContent = t("key.none");
    els.apiKey.placeholder = t("key.placeholder");
    toast(t("toast.keyRemoved"));
    await loadSetup();
    await refreshStatus();
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

async function saveKey() {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    toast(t("toast.keyPasted"), true);
    return;
  }
  const btn = document.getElementById("btnSaveKey");
  if (btn) btn.disabled = true;
  try {
    const r = await api("/api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    if (!r.ok) {
      toast(r.error || t("toast.error"), true);
      return;
    }
    els.apiKey.value = "";
    els.apiKey.placeholder = r.masked;
    if (els.keyCurrent) els.keyCurrent.textContent = r.masked;
    toast(t("toast.keySaved", { key: r.masked }));
    await loadSetup();
    await refreshStatus();
    loadQuota().catch(() => {});
  } catch (e) {
    toast(String(e.message || e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function generateKey() {
  if (!state.kiroConnected) {
    toast(t("toast.needKiro"), true);
    return;
  }
  els.btnGenKey.disabled = true;
  try {
    const r = await api("/api/key/generate", { method: "POST" });
    if (!r.ok) {
      toast(r.error || t("toast.keyCreateFailed"), true);
      return;
    }
    if (els.keyCurrent) els.keyCurrent.textContent = r.masked;
    els.apiKey.placeholder = r.masked;
    toast(t("toast.keyNew", { key: r.masked }));
    if (r.key) {
      els.apiKey.value = "";
      els.apiKey.placeholder = r.masked;
    }
    await loadSetup();
    await refreshStatus();
    await loadQuota().catch(() => {});
  } finally {
    updateAuthButtons(state.kiroConnected);
  }
}

async function installAll() {
  // One poller only — repeated clicks used to spam “Installation failed” toasts.
  if (state.setupPoll || state.installStarting) return;
  state.installStarting = true;
  els.installLogWrap.classList.remove("hidden");
  els.btnInstallAll.disabled = true;
  if (els.btnStopInstall) {
    els.btnStopInstall.classList.remove("hidden");
    els.btnStopInstall.disabled = false;
  }
  try {
    await fetch("/api/setup/install", { method: "POST" });
  } catch (e) {
    state.installStarting = false;
    els.btnInstallAll.disabled = false;
    toast(String(e.message || e), true);
    return;
  }
  state.installStarting = false;
  let finishedToast = false;
  state.setupPoll = setInterval(async () => {
    const setup = await loadSetup().catch(() => null);
    if (!setup?.install) return;
    if (setup.install.running) return;
    clearInterval(state.setupPoll);
    state.setupPoll = null;
    if (els.btnStopInstall) els.btnStopInstall.classList.add("hidden");
    if (finishedToast) return;
    finishedToast = true;
    const stopped = setup.install.step === "stopped";
    toast(
      stopped ? t("toast.installStopped") : setup.install.ok ? t("toast.installDone") : t("toast.installFailed"),
      !setup.install.ok && !stopped
    );
    if (setup.install.ok) {
      await bootstrap();
      try {
        await loadModels();
      } catch {
        /* ignore */
      }
    }
  }, 600);
}

async function stopInstall() {
  if (els.btnStopInstall) els.btnStopInstall.disabled = true;
  try {
    const r = await fetch("/api/setup/install/stop", { method: "POST" }).then((x) => x.json());
    toast(r.message || (r.stopped ? t("toast.stopping") : t("toast.stop")));
    await loadSetup();
  } catch (e) {
    toast(String(e.message || e), true);
    if (els.btnStopInstall) els.btnStopInstall.disabled = false;
  }
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const go = btn.getAttribute("data-go");
    if (go) setTab(go);
  });
});

els.grid.addEventListener("click", (e) => {
  const t = e.target.closest("[data-test]");
  const c = e.target.closest("[data-connect]");
  const o = e.target.closest("[data-open]");
  if (t) testModel(t.getAttribute("data-test"));
  if (c) connectModel(c.getAttribute("data-connect"));
  if (o) launchClaude();
});

let searchDebounce = null;
els.search.addEventListener("input", () => {
  // render() rebuilds the whole grid, so don't do it on every keystroke.
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.query = els.search.value.trim().toLowerCase();
    render();
  }, 150);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (els.pathModal && !els.pathModal.classList.contains("hidden")) {
    hidePathModal();
    return;
  }
  if (els.kiroModal && !els.kiroModal.classList.contains("hidden")) closeKiroModal();
});

// A hidden window does not need to keep polling OmniRoute every 20 seconds.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopQuotaPoll();
  } else {
    ensureQuotaPoll();
    loadQuota().catch(() => {});
  }
});

document.getElementById("btnRefresh").addEventListener("click", () => {
  loadModels().catch((e) => {
    els.foot.textContent = e.message;
    els.grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  });
});
document.getElementById("btnLaunch").addEventListener("click", () => launchClaude({ mode: "new" }));
document.getElementById("btnLaunchBar").addEventListener("click", () => launchClaude({ mode: "new" }));
if (els.btnContinueChat) {
  els.btnContinueChat.addEventListener("click", () => launchClaude({ mode: "continue" }));
}
if (els.btnContinueTop) {
  els.btnContinueTop.addEventListener("click", () => launchClaude({ mode: "continue" }));
}
if (els.btnChatsRefresh) els.btnChatsRefresh.addEventListener("click", () => loadChats());
if (els.chatsList) {
  els.chatsList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chat-resume]");
    if (!btn) return;
    const row = btn.closest("[data-session-id]");
    if (!row) return;
    launchClaude({
      mode: "resume",
      sessionId: row.dataset.sessionId,
      cwd: row.dataset.cwd || "",
    });
  });
}
document.getElementById("btnSaveKey").addEventListener("click", saveKey);
document.getElementById("btnClearKey").addEventListener("click", clearKey);
document.getElementById("btnGenKey").addEventListener("click", generateKey);
if (els.axiomToggle) els.axiomToggle.addEventListener("change", onAxiomToggle);
if (els.checkGrid) {
  els.checkGrid.addEventListener("click", (e) => {
    const gear = e.target.closest("[data-path-key]");
    if (gear) openPathDialog(gear.dataset.pathKey);
  });
}
if (els.pathModal) {
  els.pathModal.addEventListener("click", (e) => {
    // closest(), not matches(): a click can land on the <svg> inside the close button.
    if (e.target.closest?.("[data-path-close]")) hidePathModal();
  });
}
if (els.btnPathSave) els.btnPathSave.addEventListener("click", () => savePathValue(els.pathInput.value.trim()));
if (els.btnPathReset) els.btnPathReset.addEventListener("click", () => savePathValue(""));
if (els.pathInput) {
  els.pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") savePathValue(els.pathInput.value.trim());
  });
}
document.getElementById("btnOpenKiro").addEventListener("click", openKiroAuth);
if (els.btnAwsSignOut) els.btnAwsSignOut.addEventListener("click", awsSignOut);
if (els.kiroModal) {
  els.kiroModal.addEventListener("click", (e) => {
    if (!e.target) return;
    // closest(), not matches(): a click can land on the <svg> inside the close button.
    if (e.target.closest?.("[data-kiro-cancel]")) {
      cancelKiroAuth();
      return;
    }
    if (e.target.closest?.("[data-kiro-close]")) closeKiroModal();
  });
}
if (els.btnKiroCopy) els.btnKiroCopy.addEventListener("click", copyKiroCode);
if (els.btnKiroOpenAws) {
  els.btnKiroOpenAws.addEventListener("click", async () => {
    if (!kiroAuth.verificationUriComplete) return;
    const ok = await openAwsWindow(kiroAuth.verificationUriComplete, { signOutFirst: true });
    if (!ok) {
      toast(t("kiro.awsOpenFailed"), true);
      return;
    }
    if (kiroAuth.active) {
      setKiroStep("code");
      setKiroStatus(t("kiro.awaitingConfirm"));
      setKiroWait("wait");
    }
  });
}
if (els.btnKiroRetry) {
  els.btnKiroRetry.addEventListener("click", () => {
    if (els.btnKiroRetry.dataset.action === "retry") openKiroAuth();
  });
}
if (els.btnDoctor) els.btnDoctor.addEventListener("click", runDoctorCheck);
if (els.langPicker) {
  els.langPicker.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-lang]");
    if (btn) setLanguage(btn.dataset.lang);
  });
}
document.getElementById("btnInstallAll").addEventListener("click", installAll);
if (els.btnStopInstall) els.btnStopInstall.addEventListener("click", stopInstall);
if (els.btnLogsRefresh) els.btnLogsRefresh.addEventListener("click", () => loadAppLogs());
if (els.btnLogsDownload) els.btnLogsDownload.addEventListener("click", () => downloadAppLogs());
if (els.btnLogsClear) els.btnLogsClear.addEventListener("click", () => clearAppLogs());
if (els.appLogView) {
  els.appLogView.addEventListener("scroll", () => {
    els.appLogView.dataset.touched = "1";
  });
}
if (els.btnLimitSwitch) {
  els.btnLimitSwitch.addEventListener("click", () => {
    setTab("setup");
    openKiroAuth();
  });
}
document.getElementById("btnBoot").addEventListener("click", async () => {
  await bootstrap();
  try { await loadModels(); } catch (e) { els.foot.textContent = e.message; }
});

const TELEGRAM_URL = "https://t.me/loveaideep";

function showUpdateLock(telegram) {
  const lock = document.getElementById("updateLock");
  const app = document.getElementById("appRoot");
  const btn = document.getElementById("btnUpdateTg");
  const url = telegram || TELEGRAM_URL;
  if (btn) btn.href = url;
  if (app) app.classList.add("hidden");
  if (lock) {
    lock.classList.remove("hidden");
    lock.setAttribute("aria-hidden", "false");
  }
  document.title = t("update.docTitle");
}

async function ensureAccess() {
  try {
    const r = await fetch("/api/access?force=1", { signal: AbortSignal.timeout(2500) }).then((x) => x.json());
    if (r && r.allowed === false) {
      showUpdateLock(r.telegram);
      return false;
    }
    return true;
  } catch {
    // Pastebin or the network is slow — do not hold the UI hostage on F5.
    return true;
  }
}

(async () => {
  let savedTab = "home";
  try {
    const raw = localStorage.getItem("fc-tab");
    savedTab = raw === "models" || raw === "setup" || raw === "home" ? raw : "home";
  } catch {
    savedTab = "home";
  }
  applyI18n();
  markActiveLanguage();
  // Paint tab + status immediately, access check in parallel (was blocking whole UI).
  setTab(savedTab);
  syncLimitTimer();
  ensureQuotaPoll();
  const accessPromise = ensureAccess();
  try {
    await refreshStatus();
  } catch {
    renderConn({ omni: false });
  }
  const ok = await accessPromise;
  if (!ok) return;
  await bootstrap();
  try {
    await loadModels();
  } catch (e) {
    els.foot.textContent = e.message;
    els.grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
  await loadQuota().catch(() => {});
})();
