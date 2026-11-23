/**
 * screenshot-bridge — Host half.
 *
 * Owns the system-wide capture hotkey. A detached PowerShell helper registers
 * the combination with Win32 `RegisterHotKey`, grabs the screen into a PNG the
 * moment it fires, and reports the path as one NDJSON line. This half keeps the
 * newest captures, holds the browser half's long poll open until one arrives,
 * serves the bytes, and exposes the live settings the settings card edits.
 *
 * The settings card reads `Config` defaults and writes its own
 * `settings.json` through the route below. That file is independent of the
 * profile patch, so an installed bundle is editable even when the profile has
 * no direct config row; `loader/volatile-update` still re-arms the helper when
 * a profile-level default changes before the first card save.
 *
 * Routes (all under one path, authenticated by the composed `/api` fence):
 *   GET  ?op=state              { settings, running, error, latestSeq }
 *   GET  ?op=wait&since=<seq>   long poll (25s): { latestSeq, captures: [...] }
 *   GET  ?op=image&id=<id>      the PNG bytes of one capture
 *   GET  ?op=extract&id=<id>    question text pulled out of one capture
 *   GET  ?op=diag&data=<text>   append one diagnostics line
 *   POST ?op=save               merge one validated settings patch
 *
 * @module screenshot-bridge
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { existsSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { createLanServer } from "./lan.mjs";
import { qrSvg } from "./qr.mjs";

/** Plugin name; also the profile row id and the settings form namespace. */
export const name = "screenshot-bridge";

/** Host services: the route fence is the only one this half needs. */
export const inject = ["connection"];

/**
 * Live settings, edited from the card. Volatile fields are what the settings
 * service projects into a form; `default` is what a fresh profile starts with.
 */
const DEFAULT_PROMPT = "我下面附了一段从截图里识别出来的题目文字。请只回答其中**题干和选项都完整**的题：按题号顺序直接给答案，只给答案、不要解析；不要逐题核对，也不要先去验证题目是否完整。文字残缺、选项缺失或数字明显乱掉的题，直接标「文字残缺」跳过，不修补、不纠缠；需要的话我自己再看截图。不要开子代理，也不要联网搜题；拿不准的题标「待核」。如果没有附文字，就直接看图作答。";

export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description("Capture bridge on/off"),
  hotkey: z.string().default("Alt+Z").volatile().description("System-wide capture hotkey"),
  sessionId: z.string().default("").volatile().description("Target conversation id; required for delivery"),
  allScreens: z.boolean().default(false).volatile().description("Capture every display instead of the display under the pointer"),
  prompt: z.string().default(DEFAULT_PROMPT).volatile().description("Text sent with each screenshot; {time} becomes the local clock"),
  mode: z.union([z.const("image"), z.const("extract")]).default("extract").volatile()
    .description("image: send the screenshot itself; extract: send locally extracted question text plus its figures"),
  captureBackend: z.union([z.const("auto"), z.const("gdi"), z.const("dxgi")]).default("auto").volatile()
    .description("auto: composited desktop first, GDI as fallback; gdi: classic BitBlt; dxgi: DXGI desktop duplication"),
  clearProtection: z.boolean().default(true).volatile()
    .description("Clear SetWindowDisplayAffinity protection on windows that block capture"),
  prebuffer: z.boolean().default(true).volatile()
    .description("Keep a short frame ring so a press yields the frame from before the client noticed the focus change"),
  imageFollowUp: z.union([z.const("auto"), z.const("always"), z.const("never")]).default("auto").volatile()
    .description("auto: send the image message only for figures/tables or gaps; always; never (text only)"),
  splitText: z.boolean().default(true).volatile()
    .description("Send the OCR text as its own message first, then the image only for incomplete questions"),
  fastAnswer: z.boolean().default(true).volatile()
    .description("Append a no-subagent / no-web-search rule so a single screenshot is answered directly"),
  ocrModel: z.union([z.const("small"), z.const("medium")]).default("small").volatile()
    .description("OCR tier for the optional text extraction (medium is slower and better on small print)"),
  captureTarget: z.union([z.const("auto"), z.const("window"), z.const("screen")]).default("auto").volatile()
    .description("auto: window when the foreground window is capture-protected, screen otherwise"),
  imageFormat: z.union([z.const("png"), z.const("jpg")]).default("png").volatile()
    .description("png: lossless, slower; jpg: much faster encode, q95"),
  lanEnabled: z.boolean().default(true).volatile()
    .description("Serve a LAN page that shows the newest capture, its text and the answer"),
  lanPort: z.number().default(8787).volatile()
    .description("Port for the LAN page"),
  lanToken: z.string().default("").volatile()
    .description("Access token for the LAN page; generated on first use"),
});

/** Route the browser half fetches; `/api` is the authenticated prefix. */
const ROUTE = "/api/screenshot-bridge";
/** Settings written by the card, independent of the profile's patch document. */
const SETTINGS_FILE = "settings.json";
/** Session id shape accepted by the card; an empty value simply disables delivery. */
const SESSION_ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** How long one `op=wait` request may stay open. */
const WAIT_MS = 25_000;
/** Newest PNGs kept on disk; older ones are deleted after a capture. */
const KEEP_SHOTS = 40;
/** Newest capture descriptors kept in memory. */
const KEEP_ENTRIES = KEEP_SHOTS;

export function apply(ctx, config) {
  const dir = homePath("screenshot-bridge");
  const settingsPath = path.join(dir, SETTINGS_FILE);
  const defaults = readSettings(config);
  const persisted = readPersistedSettings(settingsPath);
  const state = {
    settings: persisted === null ? defaults : mergeSettings(defaults, persisted),
    hasPersisted: persisted !== null,
    settingsPath,
    writeChain: Promise.resolve(),
    dir,
    home: path.dirname(dir),
    // The daemon is sandboxed to the workspace, so ${DSH_HOME}\... is refused and
    // the old location silently fell back to bin/.shots (lost on reinstall).
    // A directory beside the plugin survives rebuilds and stays writable.
    shots: process.env.DSH_SHOT_DIR && process.env.DSH_SHOT_DIR.trim() !== ""
      ? process.env.DSH_SHOT_DIR
      : fileURLToPath(new URL("./.shots", import.meta.url)),
    logPath: path.join(dir, "bridge.log"),
    running: false,
    error: null,
    child: null,
    stopping: false,
    disposed: false,
    seq: 0,
    captures: [],
    waiters: new Set(),
    restartTimer: null,
    helperRestarts: 0,
    extracts: new Map(),
    python: null,
    ctx,
    answers: new Map(),
    answerClaims: new Map(),
    pendingAnswers: new Map(),
    answerPoller: null,
    lanError: null,
    logWrites: 0,
    ocr: { child: null, seq: 0, pending: new Map() },
    resend: [],
    lan: { server: null, port: 0, token: "", error: null },
    lanBusy: false,
  };

  if (process.platform !== "win32") {
    state.error = "screenshot-bridge requires Windows";
    return;
  }

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: ROUTE,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: (request) => serve(request, state, config),
    }),
    "screenshot-bridge: route"
  );

  // Editing settings.json by hand should take effect without a restart; the
  // card writes through the route, so this only fires for external edits.
  ctx.effect(() => {
    const listener = () => {
      if (state.disposed) return;
      const next = readPersistedSettings(settingsPath);
      if (next === null) return;
      const merged = mergeSettings(defaults, next);
      const before = JSON.stringify(publicSettings(state.settings));
      if (JSON.stringify(publicSettings(merged)) === before) return;
      state.hasPersisted = true;
      applySettings(state, merged);
    };
    watchFile(settingsPath, { interval: 1500 }, listener);
    return () => unwatchFile(settingsPath, listener);
  }, "screenshot-bridge: settings file watch");

  ctx.effect(() => {
    void ensureLan(state);
    return () => stopLan(state);
  }, "screenshot-bridge: lan answer page");

  ctx.effect(() => {
    void log(state, "config-live", {
      enabled: state.settings.enabled,
      hotkey: state.settings.hotkey,
    }).catch(() => {});
    void boot(state).catch((error) => {
      state.running = false;
      state.error = error instanceof Error ? error.message : String(error);
      void log(state, "boot-failed", { message: state.error }).catch(() => {});
    });
    // Volatile refs are the source of truth. The update event is the fast path;
    // this slow poll covers a dropped event so a saved hotkey still re-arms.
    const poll = setInterval(() => {
      if (!state.disposed) reconcile(state, config);
    }, 1500);
    return () => {
      clearInterval(poll);
      state.disposed = true;
      if (state.restartTimer !== null) clearTimeout(state.restartTimer);
      stopHelper(state);
      stopLan(state);
      if (state.answerPoller !== null) clearInterval(state.answerPoller);
      stopOcr(state);
      state.answerPoller = null;
    };
  }, "screenshot-bridge: hotkey helper");

  // The settings card writes through the settings service; re-arm on every
  // accepted change instead of asking the browser half to poll the profile.
  ctx.effect(
    () => ctx.on("loader/volatile-update", () => reconcile(state, config)),
    "screenshot-bridge: live settings"
  );

  // The browser half reads the route from the served page so the two can never drift.
  ctx.on("webserver/index-inject", (table) => {
    table.push({
      kind: "global",
      name: "__DSH_SCREENSHOT_BRIDGE__",
      value: { routePath: ROUTE },
    });
  });
}

/* ---------------------------------------------------------------- settings */

function clampPort(value) {
  const port = Math.trunc(Number(value));
  return Number.isFinite(port) && port >= 1024 && port <= 65535 ? port : 8787;
}

/** `.get()` from a volatile field, the plain value otherwise. */
function live(field, fallback) {
  if (field === null || field === undefined) return fallback;
  if (typeof field === "object" && typeof field.get === "function") {
    const value = field.get();
    return value === undefined || value === null ? fallback : value;
  }
  return field;
}

/** Project the live config into the flat shape the browser half consumes. */
function readSettings(config) {
  return {
    enabled: live(config.enabled, true) !== false,
    hotkey: String(live(config.hotkey, "Alt+Z")),
    sessionId: String(live(config.sessionId, "")).trim(),
    allScreens: live(config.allScreens, false) === true,
    prompt: String(live(config.prompt, DEFAULT_PROMPT)),
    mode: live(config.mode, "extract") === "image" ? "image" : "extract",
    captureBackend: ["auto", "gdi", "dxgi"].includes(live(config.captureBackend, "auto"))
      ? live(config.captureBackend, "auto")
      : "auto",
    clearProtection: live(config.clearProtection, true) !== false,
    prebuffer: live(config.prebuffer, true) !== false,
    fastAnswer: live(config.fastAnswer, true) !== false,
    splitText: live(config.splitText, true) !== false,
    imageFollowUp: ["auto", "always", "never"].includes(live(config.imageFollowUp, "auto"))
      ? live(config.imageFollowUp, "auto")
      : "auto",
    ocrModel: live(config.ocrModel, "small") === "medium" ? "medium" : "small",
    captureTarget: ["auto", "window", "screen"].includes(live(config.captureTarget, "auto"))
      ? live(config.captureTarget, "auto")
      : "auto",
    imageFormat: live(config.imageFormat, "png") === "jpg" ? "jpg" : "png",
    lanEnabled: live(config.lanEnabled, true) !== false,
    lanPort: clampPort(live(config.lanPort, 8787)),
    lanToken: String(live(config.lanToken, "")).trim(),
  };
}

/** Merge one validated settings patch over a complete settings object. */
function mergeSettings(base, patch) {
  return { ...base, ...patch };
}

/**
 * Validate the fields the browser half may write. Unknown keys are ignored;
 * a known key with the wrong type rejects the whole patch.
 */
function settingsPatch(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const patch = {};
  let count = 0;
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") return null;
    patch.enabled = value.enabled;
    count += 1;
  }
  if ("hotkey" in value) {
    if (typeof value.hotkey !== "string") return null;
    const hotkey = value.hotkey.trim();
    if (hotkey === "" || hotkey.length > 80) return null;
    patch.hotkey = hotkey;
    count += 1;
  }
  if ("sessionId" in value) {
    if (typeof value.sessionId !== "string") return null;
    const sessionId = value.sessionId.trim();
    if (sessionId !== "" && !SESSION_ID.test(sessionId)) return null;
    patch.sessionId = sessionId;
    count += 1;
  }
  if ("allScreens" in value) {
    if (typeof value.allScreens !== "boolean") return null;
    patch.allScreens = value.allScreens;
    count += 1;
  }
  if ("prompt" in value) {
    if (typeof value.prompt !== "string") return null;
    if (value.prompt.length > 20_000) return null;
    patch.prompt = value.prompt;
    count += 1;
  }
  if ("mode" in value) {
    if (value.mode !== "image" && value.mode !== "extract") return null;
    patch.mode = value.mode;
    count += 1;
  }
  // Legacy alias: the old boolean still works, it just picks the same two modes.
  if ("extract" in value) {
    if (typeof value.extract !== "boolean") return null;
    patch.mode = value.extract ? "extract" : "image";
    count += 1;
  }
  if ("captureBackend" in value) {
    if (!["auto", "gdi", "dxgi"].includes(value.captureBackend)) return null;
    patch.captureBackend = value.captureBackend;
    count += 1;
  }
  if ("clearProtection" in value) {
    if (typeof value.clearProtection !== "boolean") return null;
    patch.clearProtection = value.clearProtection;
    count += 1;
  }
  if ("prebuffer" in value) {
    if (typeof value.prebuffer !== "boolean") return null;
    patch.prebuffer = value.prebuffer;
    count += 1;
  }
  if ("fastAnswer" in value) {
    if (typeof value.fastAnswer !== "boolean") return null;
    patch.fastAnswer = value.fastAnswer;
    count += 1;
  }
  if ("imageFollowUp" in value) {
    if (!["auto", "always", "never"].includes(value.imageFollowUp)) return null;
    patch.imageFollowUp = value.imageFollowUp;
    count += 1;
  }
  if ("splitText" in value) {
    if (typeof value.splitText !== "boolean") return null;
    patch.splitText = value.splitText;
    count += 1;
  }
  if ("ocrModel" in value) {
    if (value.ocrModel !== "small" && value.ocrModel !== "medium") return null;
    patch.ocrModel = value.ocrModel;
    count += 1;
  }
  if ("captureTarget" in value) {
    if (!["auto", "window", "screen"].includes(value.captureTarget)) return null;
    patch.captureTarget = value.captureTarget;
    count += 1;
  }
  if ("imageFormat" in value) {
    if (value.imageFormat !== "png" && value.imageFormat !== "jpg") return null;
    patch.imageFormat = value.imageFormat;
    count += 1;
  }
  if ("lanEnabled" in value) {
    if (typeof value.lanEnabled !== "boolean") return null;
    patch.lanEnabled = value.lanEnabled;
    count += 1;
  }
  if ("lanPort" in value) {
    if (typeof value.lanPort !== "number" || !Number.isFinite(value.lanPort)) return null;
    patch.lanPort = clampPort(value.lanPort);
    count += 1;
  }
  if ("lanToken" in value) {
    if (typeof value.lanToken !== "string" || value.lanToken.length > 128) return null;
    patch.lanToken = value.lanToken.trim();
    count += 1;
  }
  return count === 0 ? null : patch;
}

/** Read the card-owned settings file; an absent or malformed file means "use Config defaults". */
function readPersistedSettings(filename) {
  try {
    const value = JSON.parse(readFileSync(filename, "utf8"));
    return settingsPatch(value);
  } catch {
    return null;
  }
}

/** Serialize the card writes; the last queued snapshot wins without interleaving temp files. */
function persistSettings(state, settings) {
  const text = `${JSON.stringify(publicSettings(settings), null, 2)}\n`;
  const run = state.writeChain.then(async () => {
    await mkdir(state.dir, { recursive: true });
    const temporary = `${state.settingsPath}.tmp`;
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, state.settingsPath);
  });
  state.writeChain = run.catch(() => {});
  return run;
}

/** Bring the helper in line with the settings just accepted by the Host. */
function applySettings(state, next) {
  const before = state.settings;
  if (
    before.enabled === next.enabled
    && before.hotkey === next.hotkey
    && before.sessionId === next.sessionId
    && before.allScreens === next.allScreens
    && before.prompt === next.prompt
    && before.mode === next.mode
    && before.captureBackend === next.captureBackend
    && before.clearProtection === next.clearProtection
    && before.prebuffer === next.prebuffer
    && before.fastAnswer === next.fastAnswer
    && before.splitText === next.splitText
    && before.imageFollowUp === next.imageFollowUp
    && before.ocrModel === next.ocrModel
    && before.captureTarget === next.captureTarget
    && before.imageFormat === next.imageFormat
    && before.lanEnabled === next.lanEnabled
    && before.lanPort === next.lanPort
    && before.lanToken === next.lanToken
  ) {
    return;
  }
  state.settings = next;
  void log(state, "settings-applied", {
    enabled: next.enabled,
    hotkey: next.hotkey,
    allScreens: next.allScreens,
    mode: next.mode,
    captureBackend: next.captureBackend,
    clearProtection: next.clearProtection,
    prebuffer: next.prebuffer,
    fastAnswer: next.fastAnswer,
    splitText: next.splitText,
    imageFollowUp: next.imageFollowUp,
    ocrModel: next.ocrModel,
    captureTarget: next.captureTarget,
    imageFormat: next.imageFormat,
    sessionIdSet: next.sessionId !== "",
  }).catch(() => {});

  if (!next.enabled) {
    if (state.restartTimer !== null) clearTimeout(state.restartTimer);
    state.restartTimer = null;
    stopHelper(state);
    state.error = null;
    return;
  }
  if (
    !before.enabled
    || before.hotkey !== next.hotkey
    || before.allScreens !== next.allScreens
    || before.captureBackend !== next.captureBackend
    || before.clearProtection !== next.clearProtection
    || before.prebuffer !== next.prebuffer
    || before.captureTarget !== next.captureTarget
    || before.imageFormat !== next.imageFormat
  ) {
    restart(state);
  }
}

/** Config defaults apply until the card stores its first settings snapshot. */
function reconcile(state, config) {
  if (state.hasPersisted) return;
  applySettings(state, readSettings(config));
}

function publicSettings(settings) {
  return {
    enabled: settings.enabled,
    hotkey: settings.hotkey,
    sessionId: settings.sessionId,
    allScreens: settings.allScreens,
    prompt: settings.prompt,
    mode: settings.mode,
    extract: settings.mode === "extract",
    captureBackend: settings.captureBackend,
    clearProtection: settings.clearProtection,
    prebuffer: settings.prebuffer,
    fastAnswer: settings.fastAnswer,
    splitText: settings.splitText,
    imageFollowUp: settings.imageFollowUp,
    ocrModel: settings.ocrModel,
    captureTarget: settings.captureTarget,
    imageFormat: settings.imageFormat,
    lanEnabled: settings.lanEnabled,
    lanPort: settings.lanPort,
    lanToken: settings.lanToken,
  };
}

/* ------------------------------------------------------------------ helper */

/** First boot: create the shot directory, then arm the helper when enabled. */
async function boot(state) {
  await mkdir(state.shots, { recursive: true }).catch(() => {});
  void log(state, "route-ready", {
    path: ROUTE,
    settings: publicSettings(state.settings),
  }).catch(() => {});
  if (!state.settings.enabled) {
    void log(state, "disabled", {}).catch(() => {});
    return;
  }
  await spawnHelper(state);
}

/** Locate the per-user DSH data directory the same way the desktop app does. */
function homePath(name) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(home, name);
}

/** Kill the current helper, if any. */
function stopHelper(state) {
  const child = state.child;
  state.child = null;
  state.running = false;
  if (child === null || child === undefined) return;
  state.stopping = true;
  try {
    child.kill();
  } catch {
    // already gone
  }
}

async function spawnHelper(state) {
  stopHelper(state);

  // Preferred: one resident native daemon that owns the hotkey, the frame ring
  // and the no-DLL protection clear. Falls back to the PowerShell helper when
  // the binary is missing (source checkout without a build).
  const daemon = fileURLToPath(new URL("./bin/dshshotd.exe", import.meta.url));
  if (existsSync(daemon)) {
    const argv = [
      "--hotkey", state.settings.hotkey,
      "--outdir", state.shots,
      "--backend", state.settings.captureBackend,
      "--prebuffer", state.settings.prebuffer ? "600" : "0",
      "--prelag", "250",
      "--target", state.settings.captureTarget,
      "--format", state.settings.imageFormat,
    ];
    if (state.settings.allScreens) argv.push("--all-screens");
    argv.push(state.settings.clearProtection ? "--clear" : "--no-clear");
    const child = spawn(daemon, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    attachChild(state, child, "daemon");
    return;
  }

  const script = fileURLToPath(new URL("./hotkey.ps1", import.meta.url));
  const captureExe = fileURLToPath(new URL("./bin/shotcap.exe", import.meta.url));
  const clearExe = fileURLToPath(new URL("./bin/wdaclear.exe", import.meta.url));
  const kernelCtl = fileURLToPath(new URL("./bin/dshcapctl.exe", import.meta.url));
  const executable = await resolveShell();
  const argv = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-Hotkey", state.settings.hotkey,
    "-OutDir", state.shots,
    "-Backend", state.settings.captureBackend,
  ];
  if (state.settings.allScreens) argv.push("-AllScreens");
  if (existsSync(captureExe)) argv.push("-CaptureExe", captureExe);
  if (state.settings.clearProtection && existsSync(clearExe)) argv.push("-ClearExe", clearExe);
  if (state.settings.clearProtection && existsSync(kernelCtl)) argv.push("-KernelCtl", kernelCtl);

  const child = spawn(executable, argv, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachChild(state, child, "powershell");
}

/** Wire one helper process into the Host state. */
function attachChild(state, child, source) {
  state.child = child;
  state.running = true;
  state.stopping = false;
  state.error = null;

  child.stdout.setEncoding("utf8");
  readLines(child.stdout, (line) => handleLine(state, line));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text !== "") void log(state, "helper-stderr", { text: text.slice(-400) }).catch(() => {});
  });
  child.on("error", (error) => {
    state.running = false;
    state.error = `helper failed to start: ${error.message}`;
    void log(state, "helper-error", { message: error.message }).catch(() => {});
  });
  child.on("exit", (code, signal) => {
    if (state.child === child) state.child = null;
    state.running = false;
    if (state.disposed) return;
    if (state.stopping) {
      state.stopping = false;
      return;
    }
    if (state.error === null) state.error = `helper exited (code ${String(code)}, signal ${String(signal)})`;
    void log(state, "helper-exit", { code, signal, hotkey: state.settings.hotkey }).catch(() => {});

    // Bring the helper back if it died on its own (hotkey lost to another app,
    // daemon crash). Bounded so a broken install cannot spin forever.
    if (!state.disposed && state.settings.enabled && state.restartTimer === null) {
      state.helperRestarts += 1;
      if (state.helperRestarts <= 6) {
        void log(state, "helper-restart", { attempt: state.helperRestarts }).catch(() => {});
        state.restartTimer = setTimeout(() => {
          state.restartTimer = null;
          if (!state.disposed && state.settings.enabled) {
            spawnHelper(state).catch(() => {});
          }
        }, 2000);
      }
    }
  });

  void log(state, "helper-spawn", {
    source,
    hotkey: state.settings.hotkey,
    allScreens: state.settings.allScreens,
    backend: state.settings.captureBackend,
    prebuffer: state.settings.prebuffer,
  }).catch(() => {});
}

/** Prefer Windows PowerShell 5.1: WinForms and `RegisterHotKey` are guaranteed there. */
async function resolveShell() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const candidates = [
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return "powershell.exe";
}

/** Split a child's stdout into whole lines. */
function readLines(stream, onLine) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") onLine(line);
      index = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    const line = buffer.trim();
    if (line !== "") onLine(line);
  });
}

/** One NDJSON line from the helper. */
function handleLine(state, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    void log(state, "helper-noise", { line: line.slice(0, 300) }).catch(() => {});
    return;
  }
  if (message === null || typeof message !== "object") return;

  if (message.kind === "ready") {
    state.running = true;
    state.error = null;
    state.helperRestarts = 0;
    void log(state, "ready", {
      hotkey: message.hotkey,
      prebuffer: message.prebuffer,
      ring: message.ring,
    }).catch(() => {});
    return;
  }
  if (message.kind === "error") {
    state.error = typeof message.message === "string" ? message.message : "helper error";
    void log(state, "helper-error-line", { message: state.error }).catch(() => {});
    return;
  }
  if (message.kind === "capture" && typeof message.path === "string") {
    recordCapture(state, message);
  }
}

/** Publish one capture to every waiting browser poll. */
function recordCapture(state, message) {
  // The daemon may have saved somewhere else because the sandbox denies its
  // preferred directory; adopt the directory it actually used so pruning and
  // later spawns stay in one place.
  const savedDir = path.dirname(message.path);
  if (savedDir !== state.shots) {
    state.shots = savedDir;
    void log(state, "shots-dir", { dir: savedDir }).catch(() => {});
  }
  state.seq += 1;
  const entry = {
    id: captureId(message.path),
    path: message.path,
    width: typeof message.width === "number" ? message.width : null,
    height: typeof message.height === "number" ? message.height : null,
    at: Date.now(),
    seq: state.seq,
  };
  if (typeof message.backend === "string") entry.backend = message.backend;
  if (typeof message.target === "string") entry.target = message.target;
  if (typeof message.format === "string") entry.format = message.format;
  if (typeof message.ms === "number") entry.ms = message.ms;
  if (typeof message.cleared === "number") entry.cleared = message.cleared;
  if (message.blank === true) entry.blank = true;
  state.captures.push(entry);
  if (state.captures.length > KEEP_ENTRIES) state.captures = state.captures.slice(-KEEP_ENTRIES);

  for (const waiter of [...state.waiters]) {
    try {
      waiter(entry.seq);
    } catch {
      state.waiters.delete(waiter);
    }
  }
  void pruneShots(state).catch(() => {});
  if (state.settings.mode === "extract") void runExtract(state, entry).catch(() => {});
  watchAnswer(state, entry);
  void log(state, "capture", {
    id: entry.id,
    width: entry.width,
    height: entry.height,
    backend: entry.backend,
    blank: entry.blank === true,
  }).catch(() => {});
}

/** Stable identity for one file; the browser only ever sees this token. */
function captureId(filePath) {
  return createHash("sha1").update(path.basename(filePath)).digest("hex").slice(0, 16);
}

/** Keep only the newest PNGs on disk. */
async function pruneShots(state) {
  const names = (await readdir(state.shots)).filter((entry) => {
    const lower = entry.toLowerCase();
    return lower.endsWith(".png") || lower.endsWith(".jpg");
  });
  if (names.length <= KEEP_SHOTS) return;
  names.sort();
  const extra = names.slice(0, names.length - KEEP_SHOTS);
  const removed = new Set(extra);
  await Promise.all(extra.map((entry) => unlink(path.join(state.shots, entry)).catch(() => {})));
  // Forget descriptors whose file just went away: keeping them only produces
  // 404s for the browser half and broken images on the LAN page.
  if (removed.size > 0) {
    state.captures = state.captures.filter((capture) => {
      const name = path.basename(capture.path);
      return path.dirname(capture.path) !== state.shots || !removed.has(name);
    });
  }
  void pruneFigures(state).catch(() => {});
}

/** Cropped figures live one folder per capture; keep the newest ones only. */
async function pruneFigures(state) {
  const root = path.join(state.dir, "figs");
  let names;
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  if (names.length <= KEEP_SHOTS) return;
  const entries = (await Promise.all(names.map(async (name) => {
    try {
      const info = await stat(path.join(root, name));
      return { name, at: info.mtimeMs };
    } catch {
      return null;
    }
  }))).filter((entry) => entry !== null);
  entries.sort((left, right) => right.at - left.at);
  await Promise.all(entries.slice(KEEP_SHOTS).map((entry) => rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {})));
}

/* ------------------------------------------------------------------ extract */

/** Locate one capture by id, or by the file-name suffix the browser may pass. */
function findCapture(state, id) {
  return state.captures.find((entry) => entry.id === id);
}

/** Interpreters worth trying, most specific first. `DSH_PYTHON` wins. */
function pythonCandidates() {
  const list = [];
  if (process.env.DSH_PYTHON) list.push([process.env.DSH_PYTHON]);
  const local = process.env.LOCALAPPDATA;
  if (local) list.push([path.join(local, "Programs", "Python", "Launcher", "py.exe"), "-3"]);
  list.push(["python"]);
  list.push(["py", "-3"]);
  return list;
}

/**
 * One extractor run: the child prints a single JSON line on stdout and puts
 * engine logs on stderr, so stdout is the whole contract. Node is the default
 * engine; Python stays as the developer fallback.
 */
function execExtract(argv, scriptPath, imagePath, figuresDir, extraEnv) {
  return new Promise((resolve, reject) => {
    const args = [...argv.slice(1), scriptPath, imagePath];
    if (figuresDir !== null) args.push(figuresDir);
    const child = spawn(argv[0], args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...extraEnv },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(new Error("extract timed out"));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.startsWith("{")) continue;
        try {
          resolve(JSON.parse(line));
          return;
        } catch {
          // keep looking upward for the payload line
        }
      }
      reject(new Error(`extract printed no JSON (${err.trim().slice(-200)})`));
    });
  });
}

/** Extract once per capture; the browser half may ask twice (poll retries). */
async function runExtract(state, capture) {
  const cached = state.extracts.get(capture.id);
  if (cached !== undefined) return cached;

  const job = (async () => {
    const figuresDir = path.join(state.dir, "figs", capture.id);
    await mkdir(figuresDir, { recursive: true }).catch(() => {});

    // 0) 常驻 worker：模型只加载一次，之后每张图省 0.5–1 秒。
    try {
      const warm = await extractViaOcr(state, capture, figuresDir);
      if (warm !== null && typeof warm.ok === "boolean") {
        warm.engine = "node-warm";
        return warm;
      }
    } catch (error) {
      void log(state, "ocr-worker-failed", {
        reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
      }).catch(() => {});
    }

    // 1) 默认：同一个 Node 运行时跑 extract.mjs（依赖装在本插件里，用户不用装任何东西）。
    const nodeScript = fileURLToPath(new URL("./extract.mjs", import.meta.url));
    const nodeBin = process.env.DSH_NODE && process.env.DSH_NODE.trim() !== ""
      ? process.env.DSH_NODE
      : process.execPath;
    try {
      const result = await execExtract([nodeBin], nodeScript, capture.path, figuresDir, {
        // 模型缓存放到插件自己的运行目录，避免写到用户 home 里乱七八糟的地方
        DSH_HOME: state.home ?? process.env.DSH_HOME ?? "",
        DSH_EXTRACT_MODEL: state.settings.ocrModel ?? "small",
      });
      if (typeof result.ok === "boolean") {
        result.engine = "node";
        return result;
      }
    } catch (error) {
      void log(state, "extract-node-failed", {
        reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
      }).catch(() => {});
    }

    // 2) 兜底：开发机上的 Python（显式关闭用 DSH_EXTRACT_PYTHON=0）。
    if (process.env.DSH_EXTRACT_PYTHON === "0") return { ok: false, reason: "no-engine" };
    const script = fileURLToPath(new URL("./extract.py", import.meta.url));
    const candidates = state.python === null ? pythonCandidates() : [state.python];
    let last = { ok: false, reason: "no-python" };
    for (const candidate of candidates) {
      try {
        const result = await execExtract(candidate, script, capture.path, figuresDir, {});
        if (typeof result.reason === "string" && result.reason.startsWith("engine-unavailable")) {
          last = result;
          continue;
        }
        state.python = candidate;
        result.engine = "python";
        return result;
      } catch (error) {
        last = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    return last;
  })();

  state.extracts.set(capture.id, job);
  while (state.extracts.size > 40) {
    const oldest = state.extracts.keys().next().value;
    if (oldest === undefined) break;
    state.extracts.delete(oldest);
  }
  let result;
  try {
    result = await job;
  } catch (error) {
    // Drop the in-flight entry: keeping a rejected promise would make every
    // later request for this capture fail with the same error forever.
    state.extracts.delete(capture.id);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  state.extracts.set(capture.id, result);
  void log(state, "extract", {
    id: capture.id,
    engine: result.engine ?? null,
    ok: result.ok === true,
    mode: result.mode ?? null,
    reason: result.reason ?? null,
    chars: typeof result.text === "string" ? result.text.length : 0,
    figures: Array.isArray(result.figures) ? result.figures.length : 0,
    suspect: typeof result.suspect === "number" ? result.suspect : 0,
  }).catch(() => {});
  return result;
}

/* ------------------------------------------------------------------- route */

async function serve(request, state, config) {
  const url = new URL(request.url);
  const op = url.searchParams.get("op") ?? "state";

  if (op === "save") {
    if (request.method !== "POST") return fail(405, "save requires POST");
    let body;
    try {
      body = await request.json();
    } catch {
      return fail(400, "invalid JSON body");
    }
    const patch = settingsPatch(body);
    if (patch === null) return fail(400, "invalid settings");
    const next = mergeSettings(state.settings, patch);
    try {
      await persistSettings(state, next);
    } catch (error) {
      return fail(500, error instanceof Error ? error.message : String(error));
    }
    state.hasPersisted = true;
    applySettings(state, next);
    // 只记这次真正改动的键，别把整份设置都打一遍，看着像"顺手重存了会话"。
    void log(state, "settings-save", { changed: Object.keys(patch), patch }).catch(() => {});
    return json(200, {
      settings: publicSettings(state.settings),
      running: state.running,
      error: state.error,
      latestSeq: state.seq,
    });
  }

  if (op === "wait") {
    const since = Number(url.searchParams.get("since") ?? "0");
    const from = Number.isFinite(since) && since > 0 ? since : 0;
    const ready = state.captures.filter((capture) => capture.seq > from);
    if (ready.length > 0) {
      return json(200, { latestSeq: state.seq, captures: ready });
    }
    return await longPoll(request, state, from);
  }

  if (op === "state") {
    return json(200, {
      settings: publicSettings(state.settings),
      running: state.running,
      error: state.error,
      latestSeq: state.seq,
      platform: process.platform,
      lan: lanInfo(state),
    });
  }

  if (op === "extract") {
    const id = url.searchParams.get("id");
    if (id === null || id === "") return fail(400, "missing id");
    const capture = findCapture(state, id);
    if (capture === undefined) return fail(404, "capture expired");
    if (state.settings.mode !== "extract") return json(200, { ok: false, reason: "mode is image" });
    try {
      const result = await runExtract(state, capture);
      return json(200, result);
    } catch (error) {
      return fail(500, error instanceof Error ? error.message : String(error));
    }
  }

  // One cropped figure straight out of the last extraction, so the browser half
  // can attach it to the text it is about to send.
  if (op === "figure") {
    const id = url.searchParams.get("id");
    const n = Number(url.searchParams.get("n"));
    if (id === null || id === "") return fail(400, "missing id");
    if (!Number.isInteger(n) || n < 1 || n > 99) return fail(400, "bad figure number");
    const capture = findCapture(state, id);
    if (capture === undefined) return fail(404, "capture expired");
    try {
      const result = await runExtract(state, capture);
      const entry = (Array.isArray(result.figures) ? result.figures : []).find((item) => item.n === n);
      if (entry === undefined || typeof entry.file !== "string") return fail(404, "figure missing");
      const root = path.resolve(state.dir, "figs");
      if (!path.resolve(entry.file).startsWith(root)) return fail(400, "figure outside the shot directory");
      const bytes = await readFile(entry.file);
      return new Response(request.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=60",
          "Content-Type": "image/png",
          "Content-Length": String(bytes.byteLength),
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return fail(404, error instanceof Error ? error.message : String(error));
    }
  }

  if (op === "image") {
    const id = url.searchParams.get("id");
    if (id === null || id === "") return fail(400, "missing id");
    const capture = findCapture(state, id);
    if (capture === undefined) return fail(404, "capture expired");
    try {
      const bytes = await readFile(capture.path);
      const mime = path.extname(capture.path).toLowerCase() === ".jpg" ? "image/jpeg" : "image/png";
      return new Response(request.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=60",
          "Content-Type": mime,
          "Content-Length": String(bytes.byteLength),
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return fail(404, "capture file missing");
    }
  }

  if (op === "resend") {
    // LAN 页点了「补发这张图」：把 id 交给浏览器半，它取走后逐张补发。
    const ids = state.resend.splice(0, state.resend.length);
    return json(200, { ids });
  }

  if (op === "qr") {
    const lan = lanInfo(state);
    if (!lan.enabled) return fail(404, "lan disabled");
    const svg = qrSvg(lan.url, { cellSize: 5, margin: 4 });
    return new Response(request.method === "HEAD" ? null : svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (op === "diag") {
    const data = url.searchParams.get("data");
    if (data === null || data === "") return fail(400, "missing data");
    try {
      await log(state, "client", { text: decodeURIComponent(data).slice(0, 2000) });
    } catch (error) {
      return fail(500, error instanceof Error ? error.message : String(error));
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  }

  return fail(400, `unknown op: ${op}`);
}

/** Hold the request until the next capture or the wait budget expires. */
function longPoll(request, state, from) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.waiters.delete(waiter);
      resolve(response);
    };
    const waiter = () => {
      finish(json(200, { latestSeq: state.seq, captures: state.captures.filter((capture) => capture.seq > from) }));
    };
    const timer = setTimeout(() => {
      finish(json(200, { latestSeq: state.seq, captures: [] }));
    }, WAIT_MS);
    state.waiters.add(waiter);
    const signal = request.signal;
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        finish(new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } }));
        return;
      }
      signal.addEventListener("abort", () => {
        finish(new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } }));
      }, { once: true });
    }
  });
}

/** Restart the helper so changed settings replace the old registration. */
function restart(state) {
  if (state.disposed) return;
  stopHelper(state);
  if (state.restartTimer !== null) clearTimeout(state.restartTimer);
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    if (state.disposed || !state.settings.enabled) return;
    spawnHelper(state).catch((error) => {
      state.error = error instanceof Error ? error.message : String(error);
    });
  }, 200);
}

/* --------------------------------------------------------- OCR worker */

/** Start the resident extractor if it is not running. */
function ensureOcr(state) {
  if (state.ocr.child !== null) return state.ocr.child;
  const script = fileURLToPath(new URL("./ocr-server.mjs", import.meta.url));
  const env = { ...process.env };
  env.DSH_HOME = state.home ?? process.env.DSH_HOME ?? "";
  env.DSH_EXTRACT_MODEL = state.settings.ocrModel ?? "small";
  const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  state.ocr.child = child;
  child.stdout.setEncoding("utf8");
  readLines(child.stdout, (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = state.ocr.pending.get(message.id);
    if (waiter === undefined) return;
    state.ocr.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok === true) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? "ocr worker failed"));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text !== "") void log(state, "ocr-worker-stderr", { text: text.slice(-300) }).catch(() => {});
  });
  const fail = (reason) => {
    if (state.ocr.child === child) state.ocr.child = null;
    for (const [, waiter] of state.ocr.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    state.ocr.pending.clear();
  };
  child.on("error", (error) => fail(`ocr worker error: ${error.message}`));
  child.on("exit", () => fail("ocr worker exited"));
  return child;
}

function stopOcr(state) {
  const child = state.ocr.child;
  state.ocr.child = null;
  for (const [, waiter] of state.ocr.pending) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("ocr worker stopped"));
  }
  state.ocr.pending.clear();
  if (child !== null) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}

/** One request to the resident worker; null when it is unavailable. */
function extractViaOcr(state, capture, figuresDir) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = ensureOcr(state);
    } catch (error) {
      reject(error);
      return;
    }
    const id = `${++state.ocr.seq}`;
    const timer = setTimeout(() => {
      state.ocr.pending.delete(id);
      stopOcr(state);
      reject(new Error("ocr worker timed out"));
    }, 40_000);
    state.ocr.pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ id, image: capture.path, figuresDir })}\n`);
    } catch (error) {
      clearTimeout(timer);
      state.ocr.pending.delete(id);
      reject(error);
    }
  });
}

/* ------------------------------------------------------------------- LAN */

/** First non-loopback IPv4, or loopback when the machine is offline. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && net.internal === false) return net.address;
    }
  }
  return "127.0.0.1";
}

function lanInfo(state) {
  const token = state.settings.lanToken ?? "";
  // Use the port the listener actually got: the configured one may be squatted.
  const port = state.lan.server !== null ? state.lan.port : state.settings.lanPort;
  const host = lanAddress();
  const query = token === "" ? "/" : `/?k=${encodeURIComponent(token)}`;
  return {
    enabled: state.settings.lanEnabled !== false,
    running: state.lan.server !== null,
    port,
    host,
    url: `http://${host}:${port}${query}`,
    error: state.lan.error ?? state.lanError ?? null,
  };
}

function stopLan(state) {
  const lan = state.lan;
  if (lan !== null && lan !== undefined && lan.server !== null) {
    try {
      lan.server.close();
    } catch {
      // already closed
    }
  }
  state.lan = { server: null, port: 0, token: "", error: state.lanError };
}

async function ensureLan(state) {
  if (state.disposed) return;
  if (state.lanBusy) return;
  state.lanBusy = true;
  try {
    await ensureLanInner(state);
  } finally {
    state.lanBusy = false;
  }
}

async function ensureLanInner(state) {
  const settings = state.settings;
  if (settings.lanToken === "") {
    settings.lanToken = randomBytes(9).toString("hex");
    void persistSettings(state, settings).catch(() => {});
  }
  const current = state.lan;
  if (!settings.lanEnabled) {
    if (current.server !== null) stopLan(state);
    return;
  }
  if (current.server !== null && current.port === settings.lanPort && current.token === settings.lanToken) {
    return;
  }
  stopLan(state);

  const server = createLanServer({
    token: settings.lanToken,
    snapshot: () => lanSnapshot(state),
    image: async (id) => {
      const capture = findCapture(state, id);
      if (capture === undefined) return null;
      try {
        const bytes = await readFile(capture.path);
        const mime = path.extname(capture.path).toLowerCase() === ".jpg" ? "image/jpeg" : "image/png";
        return { bytes, mime };
      } catch {
        return null;
      }
    },
    shoot: () => shootViaDaemon(),
    resend: (id) => {
      const capture = findCapture(state, id);
      if (capture === undefined) return false;
      if (!state.resend.includes(id)) state.resend.push(id);
      return true;
    },
    log: (kind, detail) => {
      void log(state, kind, detail).catch(() => {});
    },
  });
  // A configured port can be squatted by another app (or kept by a Windows
  // reservation netstat does not show). Walk forward a few ports instead of
  // leaving the phone page dead.
  const candidates = [settings.lanPort];
  for (let offset = 1; offset <= 9; offset += 1) {
    const probe = settings.lanPort + offset;
    if (probe <= 65535) candidates.push(probe);
  }
  let bound = 0;
  let lastError = null;
  for (const port of candidates) {
    const ok = await new Promise((resolve) => {
      const onError = (error) => {
        server.removeListener("listening", onListening);
        lastError = error;
        resolve(false);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "0.0.0.0");
    });
    if (ok) {
      bound = port;
      break;
    }
    if (lastError !== null && lastError.code !== "EADDRINUSE" && lastError.code !== "EACCES") break;
  }
  if (bound === 0) {
    const message = lastError === null ? "listen failed" : String(lastError.message ?? lastError);
    state.lanError = message;
    state.lan = { server: null, port: 0, token: settings.lanToken, error: message };
    void log(state, "lan-error", { message }).catch(() => {});
    try {
      server.close();
    } catch {
      // never listened
    }
    return;
  }
  server.on("error", (error) => {
    void log(state, "lan-error", {
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  });
  state.lanError = null;
  state.lan = { server, port: bound, token: settings.lanToken, error: null };
  void log(state, "lan-listen", { port: bound, configured: settings.lanPort, host: lanAddress() }).catch(() => {});
}

function lanSnapshot(state) {
  const items = state.captures.slice(-Math.min(20, KEEP_SHOTS)).map((entry) => {
    const extract = state.extracts.get(entry.id);
    const text = extract !== null && typeof extract === "object" && typeof extract.text === "string"
      ? extract.text
      : "";
    const answer = state.answers.get(entry.id);
    return {
      id: entry.id,
      seq: entry.seq,
      at: entry.at,
      width: entry.width,
      height: entry.height,
      backend: entry.backend ?? null,
      target: entry.target ?? null,
      text: text.slice(0, 6000),
      answer: answer === undefined ? "" : answer.text.slice(0, 8000),
      answerAt: answer === undefined ? null : answer.at,
    };
  });
  const newest = items.length > 0 ? items[items.length - 1] : null;
  if (newest !== null && state.settings.mode === "extract" && !state.extracts.has(newest.id)) {
    const capture = findCapture(state, newest.id);
    if (capture !== undefined) void runExtract(state, capture).catch(() => {});
  }
  const session = sessionOf(state);
  const latest = session === null ? null : lastAssistant(session);
  return {
    seq: state.seq,
    session: session === null ? null : state.settings.sessionId,
    items,
    // 兜底：即使某条回复没绑定到具体截图，手机也能看到"会话最新回答"。
    latestAnswer: latest === null ? null : { text: latest.text.slice(0, 8000), at: Date.now() },
  };
}

function sessionOf(state) {
  const sessions = state.ctx?.get?.("sessions");
  if (sessions === undefined || sessions === null) return null;
  return sessions.get(state.settings.sessionId) ?? null;
}

function assistantEvents(session) {
  try {
    return session.ownEvents()
      .filter((event) => event.type === "assistant/message")
      .map((event) => {
        const blocks = event.data?.message?.content ?? [];
        const text = blocks
          .filter((block) => block !== null && block !== undefined && block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        return {
          seq: Number(event.seq) || 0,
          turn: Number(event.data?.turn ?? 0),
          id: String(event.data?.message?.id ?? ""),
          text,
        };
      })
      .filter((row) => row.text !== "");
  } catch {
    return [];
  }
}

function lastAssistant(session) {
  const events = assistantEvents(session);
  return events.length === 0 ? null : events[events.length - 1];
}

/** Watch the target conversation for the reply that follows this capture. */
function sessionTurn(session) {
  try {
    let turn = 0;
    for (const event of session.ownEvents()) {
      const value = Number(event?.data?.turn ?? 0);
      if (Number.isFinite(value) && value > turn) turn = value;
    }
    return turn;
  } catch {
    return 0;
  }
}

function watchAnswer(state, capture) {
  if (state.settings.sessionId === "") return;
  const session = sessionOf(state);
  if (session === null) return;
  if (state.pendingAnswers === undefined) state.pendingAnswers = new Map();
  if (state.answerSeqs === undefined) state.answerSeqs = new Set();
  state.pendingAnswers.set(capture.id, {
    baselineTurn: sessionTurn(session),
    startedAt: Date.now(),
    seen: new Set(),
    parts: 0,
  });
  if (state.answerPoller === undefined || state.answerPoller === null) {
    state.answerPoller = setInterval(() => pollAnswers(state), 900);
  }
}

/**
 * 一次截图最多产生两轮回答：先发文字（turn N+1），再补图（turn N+2）。
 * 这里按 turn 收集这两轮里的所有 assistant 消息，追加到同一张图的答案里；
 * 出现 N+3 说明下一张图已经开始了，关闭这条等待。
 */
function pollAnswers(state) {
  const pending = state.pendingAnswers;
  if (pending === undefined || pending.size === 0) {
    if (state.answerPoller !== null) clearInterval(state.answerPoller);
    state.answerPoller = null;
    return;
  }
  if (state.disposed) {
    clearInterval(state.answerPoller);
    state.answerPoller = null;
    return;
  }
  const session = sessionOf(state);
  if (session === null) return;
  const events = assistantEvents(session);
  for (const [captureId, job] of pending) {
    if (Date.now() - job.startedAt > 30 * 60_000) {
      pending.delete(captureId);
      void log(state, "answer-timeout", { id: captureId, baselineTurn: job.baselineTurn }).catch(() => {});
      continue;
    }
    // 新的用户轮次（下一张图）出现 → 这张图不再等新回答
    if (events.some((row) => row.turn > job.baselineTurn + 2)) {
      pending.delete(captureId);
      continue;
    }
    let appended = false;
    for (const row of events) {
      if (row.turn <= job.baselineTurn || row.turn > job.baselineTurn + 2) continue;
      if (job.seen.has(row.seq) || state.answerSeqs.has(row.seq)) continue;
      job.seen.add(row.seq);
      state.answerSeqs.add(row.seq);
      const previous = state.answers.get(captureId);
      const text = previous === undefined
        ? row.text
        : previous.text + "\n\n【补图回答】\n" + row.text;
      job.parts += 1;
      const shot = state.captures.find((entry) => entry.id === captureId);
      const latency = shot === undefined ? null : Date.now() - shot.at;
      state.answers.set(captureId, { text, at: Date.now(), latency });
      appended = true;
      void log(state, "answer", { id: captureId, turn: row.turn, seq: row.seq, ms: latency }).catch(() => {});
    }
    if (appended && job.parts >= 2) pending.delete(captureId);
  }
}

/** Ask the resident daemon for one capture through its control pipe. */
function shootViaDaemon() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    let socket;
    try {
      socket = net.connect("\\\\.\\pipe\\dshshotd");
    } catch {
      finish(false);
      return;
    }
    socket.on("connect", () => socket.write("shoot\n"));
    socket.on("data", () => finish(true));
    socket.on("error", () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}
async function log(state, kind, detail) {
  try {
    await mkdir(state.dir, { recursive: true });
    state.logWrites = (state.logWrites ?? 0) + 1;
    if (state.logWrites % 200 === 0) {
      try {
        const info = await stat(state.logPath);
        if (info.size > 2 * 1024 * 1024) {
          await rename(state.logPath, `${state.logPath}.1`).catch(() => {});
        }
      } catch {
        // first write
      }
    }
    await appendFile(
      state.logPath,
      `${new Date().toISOString()} ${JSON.stringify({ kind, detail })}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never break the plugin.
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function fail(status, message) {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}




















