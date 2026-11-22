// Live plumbing check: real helper, real screen, real extract + figure routes.
// Uses its own DSH_HOME and its own hotkey, so the running app is untouched.
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";

process.env.DSH_HOME = mkdtempSync(path.join(os.tmpdir(), "dsh-sb-live-"));
const { apply } = await import("./index.js");
const { execFileSync } = await import("node:child_process");

const routes = [];
const ctx = {
  effect(fn) {
    fn();
    return () => {};
  },
  on() {},
  connection: {
    fetch: {
      register(spec) {
        routes.push(spec);
        return () => {};
      },
    },
  },
};

apply(ctx, { enabled: true, hotkey: "Ctrl+Alt+F10", allScreens: false, prompt: "", mode: "extract" });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const handler = routes[0].fetch;
const call = async (query) => {
  const response = await handler(new Request("http://127.0.0.1/api/screenshot-bridge?" + query));
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.json() : response.text();
  return { status: response.status, type, body };
};

await sleep(4000);
console.log("state:", JSON.stringify(await call("op=state")));

const pending = call("op=wait&since=0");
await sleep(600);
try {
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('^%{F10}')",
  ], { stdio: "ignore" });
} catch (error) {
  console.log("sendkeys failed:", error.message);
}

const waited = await pending;
const capture = waited.body.captures?.[0];
console.log("capture:", capture?.id ?? "none", capture?.width, capture?.height);
if (capture === undefined) process.exit(1);

const t0 = Date.now();
const extracted = await call("op=extract&id=" + capture.id);
console.log("extract", Date.now() - t0, "ms status:", extracted.status,
  "ok:", extracted.body.ok, "chars:", extracted.body.text?.length, "figures:", extracted.body.figures?.length,
  "reason:", extracted.body.reason ?? "-");
console.log("text head:", (extracted.body.text ?? "").slice(0, 160).replace(/\n/g, " / "));

for (const figure of extracted.body.figures ?? []) {
  const got = await call("op=figure&id=" + capture.id + "&n=" + figure.n);
  console.log("figure", figure.n, "->", got.status, got.type, got.body.length ?? "-", "bytes; file:", figure.file);
  if (figure.n > 2) break;
}

const bad = await call("op=figure&id=" + capture.id + "&n=99");
console.log("figure 99 ->", bad.status, String(bad.body).slice(0, 60));
console.log("DSH_HOME:", process.env.DSH_HOME);
process.exit(0);
