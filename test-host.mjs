// Offline Host check: mount the real plugin module against a fake Cordis
// context, let it spawn the real PowerShell helper, fire the registered hotkey
// through SendKeys, and read the route the browser half would call.
import { apply } from "./index.js";
import { execFileSync } from "node:child_process";

const routes = [];
const disposers = [];

const ctx = {
  effect(fn) {
    const cleanup = fn();
    if (typeof cleanup === "function") disposers.push(cleanup);
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

apply(ctx, { enabled: true, hotkey: "Ctrl+Alt+F10", allScreens: false, prompt: "" });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const handler = routes[0].fetch;
const call = async (query) => {
  const response = await handler(new Request("http://127.0.0.1/api/screenshot-bridge?" + query));
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

await sleep(3500);
console.log("state before:", JSON.stringify(await call("op=state")));

// Long poll first, then fire the chord the helper registered.
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
console.log("wait:", JSON.stringify(waited));
if (waited.body.captures?.length > 0) {
  const id = waited.body.captures[0].id;
  const image = await handler(new Request("http://127.0.0.1/api/screenshot-bridge?op=image&id=" + id));
  console.log("image:", image.status, image.headers.get("content-type"), image.headers.get("content-length"));
}

console.log("state after:", JSON.stringify(await call("op=state")));

for (const dispose of disposers) {
  try {
    dispose();
  } catch {}
}
await sleep(300);
console.log("OK");
process.exit(0);
