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
 *   GET  ?op=diag&data=<text>   append one diagnostics line
 *   POST ?op=save               merge one validated settings patch
 *
 * @module screenshot-bridge
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

/** Plugin name; also the profile row id and the settings form namespace. */
export const name = "screenshot-bridge";

/** Host services: the route fence is the only one this half needs. */
export const inject = ["connection"];

/**
 * Live settings, edited from the card. Volatile fields are what the settings
 * service projects into a form; `default` is what a fresh profile starts with.
 */
const DEFAULT_PROMPT = "我给的截图里面有一些题，你根据截图里的题目按顺序给出答案。只给干净的答案，不要给思考过程";

export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description("Capture bridge on/off"),
  hotkey: z.string().default("Alt+Z").volatile().description("System-wide capture hotkey"),
  sessionId: z.string().default("").volatile().description("Target conversation id; required for delivery"),
  allScreens: z.boolean().default(false).volatile().description("Capture every display instead of the display under the pointer"),
  prompt: z.string().default(DEFAULT_PROMPT).volatile().description("Text sent with each screenshot; {time} becomes the local clock"),
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
const KEEP_ENTRIES = 200;

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
    shots: path.join(dir, "shots"),
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
  ) {
    return;
  }
  state.settings = next;
  void log(state, "settings", { settings: publicSettings(next) }).catch(() => {});

  if (!next.enabled) {
    if (state.restartTimer !== null) clearTimeout(state.restartTimer);
    state.restartTimer = null;
    stopHelper(state);
    state.error = null;
    return;
  }
  if (!before.enabled || before.hotkey !== next.hotkey || before.allScreens !== next.allScreens) {
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
  const script = fileURLToPath(new URL("./hotkey.ps1", import.meta.url));
  const executable = await resolveShell();
  const argv = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-Hotkey", state.settings.hotkey,
    "-OutDir", state.shots,
  ];
  if (state.settings.allScreens) argv.push("-AllScreens");

  const child = spawn(executable, argv, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  });

  void log(state, "helper-spawn", {
    executable,
    hotkey: state.settings.hotkey,
    allScreens: state.settings.allScreens,
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
    void log(state, "ready", { hotkey: message.hotkey }).catch(() => {});
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
  state.seq += 1;
  const entry = {
    id: captureId(message.path),
    path: message.path,
    width: typeof message.width === "number" ? message.width : null,
    height: typeof message.height === "number" ? message.height : null,
    at: Date.now(),
    seq: state.seq,
  };
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
  void log(state, "capture", { id: entry.id, width: entry.width, height: entry.height }).catch(() => {});
}

/** Stable identity for one file; the browser only ever sees this token. */
function captureId(filePath) {
  return createHash("sha1").update(path.basename(filePath)).digest("hex").slice(0, 16);
}

/** Keep only the newest PNGs on disk. */
async function pruneShots(state) {
  const names = (await readdir(state.shots)).filter((entry) => entry.toLowerCase().endsWith(".png"));
  if (names.length <= KEEP_SHOTS) return;
  names.sort();
  const extra = names.slice(0, names.length - KEEP_SHOTS);
  await Promise.all(extra.map((entry) => unlink(path.join(state.shots, entry)).catch(() => {})));
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
    void log(state, "settings-save", { settings: publicSettings(next) }).catch(() => {});
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
    });
  }

  if (op === "image") {
    const id = url.searchParams.get("id");
    if (id === null || id === "") return fail(400, "missing id");
    const capture = state.captures.find((entry) => entry.id === id)
      ?? state.captures.find((entry) => entry.path.endsWith(id));
    if (capture === undefined) return fail(404, "capture expired");
    try {
      const bytes = await readFile(capture.path);
      return new Response(request.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=60",
          "Content-Type": "image/png",
          "Content-Length": String(bytes.byteLength),
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return fail(404, "capture file missing");
    }
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

async function log(state, kind, detail) {
  try {
    await mkdir(state.dir, { recursive: true });
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
