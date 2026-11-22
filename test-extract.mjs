// Offline smoke test for the extract route: no screen capture, no helper spawn.
// DSH_HOME points at a throwaway directory so the real settings.json is untouched.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "./index.js";

process.env.DSH_HOME = mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));

const routes = [];
const ctx = {
  effect(fn) { const c = fn(); return () => { if (typeof c === "function") c(); }; },
  on() {},
  connection: { fetch: { register(spec) { routes.push(spec); return () => {}; } } },
};

apply(ctx, { enabled: false, hotkey: "Alt+Z", sessionId: "", allScreens: false, prompt: "", extract: true });

const handler = routes[0].fetch;
const call = async (query, body) => {
  const init = body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) };
  const response = await handler(new Request("http://127.0.0.1/api/screenshot-bridge?" + query, init));
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, body: type.includes("json") ? await response.json() : await response.text() };
};

console.log("state:", JSON.stringify((await call("op=state")).body.settings));
console.log("save extract=false ->", JSON.stringify((await call("op=save", { extract: false })).body.settings));
console.log("save back ->", JSON.stringify((await call("op=save", { extract: true })).body.settings));
const missing = await call("op=extract&id=deadbeef");
console.log("extract unknown id ->", missing.status, String(missing.body).slice(0, 60));
process.exit(0);
