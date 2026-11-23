// host-lan-smoke.mjs — boot the real Host module with a stub Cordis context and
// verify the LAN page end to end (server, token gate, state, remote shoot).
//
//   node host-lan-smoke.mjs
//
// Uses a free hotkey so it never fights the daemon of a running DSH.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const module = await import("./index.js");

const settingsFile = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"),
  "screenshot-bridge", "settings.json");

const registered = [];
const disposers = [];
const fakeSessions = {
  get() { return null; },
};

const ctx = {
  effect(fn, label) {
    const dispose = fn();
    disposers.push(dispose);
    return dispose;
  },
  on() { return () => {}; },
  get(name) { return name === "sessions" ? fakeSessions : undefined; },
  connection: { fetch: { register(route) { registered.push(route); return () => {}; } } },
};

const config = {
  enabled: true,
  hotkey: "Alt+F6",
  sessionId: "",
  allScreens: false,
  prompt: "smoke",
  mode: "image",
  captureBackend: "auto",
  clearProtection: false,
  prebuffer: false,
  selfCheck: false,
  ocrModel: "small",
  captureTarget: "screen",
  imageFormat: "jpg",
  lanEnabled: true,
  lanPort: 8893,
  lanToken: "",
};

module.apply(ctx, config);
await new Promise((resolve) => setTimeout(resolve, 1200));

const settings = JSON.parse(await readFile(settingsFile, "utf8"));
const token = settings.lanToken;
if (!token) throw new Error("token was not generated");

const route = registered[0];
const qr = await route.fetch(new Request("http://127.0.0.1/api/screenshot-bridge?op=qr"));
const qrSvg = await qr.text();
const resend = await route.fetch(new Request("http://127.0.0.1/api/screenshot-bridge?op=resend"));
const resendBody = await resend.json();

const base = "http://127.0.0.1:8893";
const unauthorized = await fetch(`${base}/api/state`);
const page = await fetch(`${base}/?k=${token}`);
const before = await (await fetch(`${base}/api/state?k=${token}`)).json();
const shoot = await fetch(`${base}/api/shoot?k=${token}`, { method: "POST" });
const shootBody = await shoot.json();
await new Promise((resolve) => setTimeout(resolve, 1500));
const after = await (await fetch(`${base}/api/state?k=${token}`)).json();

const result = {
  routes: registered.map((route) => route.path),
  unauthorizedStatus: unauthorized.status,
  pageStatus: page.status,
  pageHasTitle: (await page.text()).includes("截图桥"),
  qrStatus: qr.status,
  qrType: qr.headers.get("content-type"),
  qrLooksLikeSvg: qrSvg.startsWith("<svg") && qrSvg.includes("<path"),
  resendStatus: resend.status,
  resendIds: Array.isArray(resendBody.ids) ? resendBody.ids.length : -1,
  tokenLength: token.length,
  beforeItems: before.items.length,
  session: before.session,
  shoot: shootBody,
  afterItems: after.items.length,
  newest: after.items.length > 0 ? {
    id: after.items[0].id,
    width: after.items[0].width,
    format: after.items[0].backend,
  } : null,
};
console.log(JSON.stringify(result));

for (const dispose of disposers) {
  try {
    if (typeof dispose === "function") await dispose();
  } catch {
    // ignore shutdown noise
  }
}

// Another DSH may own \\.\pipe\dshshotd; then the shoot goes to that daemon and
// this Host never sees the capture. The page/route checks still hold.
const allowForeignPipe = process.env.DSH_SMOKE_ALLOW_FOREIGN_PIPE === "1";
const captureGrew = allowForeignPipe ? true : result.afterItems > result.beforeItems;
const pass = result.unauthorizedStatus === 401 && result.pageStatus === 200 && result.pageHasTitle &&
  result.qrStatus === 200 && String(result.qrType).includes("image/svg") && result.qrLooksLikeSvg &&
  result.resendStatus === 200 && result.resendIds === 0 &&
  result.tokenLength > 10 && result.shoot.ok === true && captureGrew;
process.exit(pass ? 0 : 1);

