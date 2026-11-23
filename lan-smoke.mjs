// lan-smoke.mjs — start the LAN server against fake data and exercise it.
//
//   node lan-smoke.mjs
//
// Verifies: token gate, page HTML, state JSON, image bytes, shoot hook.

import { createLanServer } from "./lan.mjs";

const token = "smoke-token";
let shot = 0;
const resent = [];
const server = createLanServer({
  token,
  snapshot: () => ({
    seq: 1,
    session: "session-smoke",
    items: [
      { id: "a1", seq: 1, at: Date.now(), width: 4, height: 3, backend: "ring", target: "screen", text: "题 1 + 2 = ?", answer: "3", answerAt: Date.now() },
    ],
  }),
  image: async () => ({
    bytes: Buffer.from("89504e470d0a1a0a", "hex"),
    mime: "image/png",
  }),
  shoot: async () => {
    shot += 1;
    return true;
  },
  resend: async (id) => {
    resent.push(id);
    return id === "a1";
  },
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(8899, "127.0.0.1", resolve);
});

const base = "http://127.0.0.1:8899";
const unauthorized = await fetch(`${base}/api/state`);
const page = await fetch(`${base}/?k=${token}`);
const state = await fetch(`${base}/api/state?k=${token}`);
const image = await fetch(`${base}/img?id=a1&k=${token}`);
const shoot = await fetch(`${base}/api/shoot?k=${token}`, { method: "POST" });
const resend = await fetch(`${base}/api/resend?k=${token}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id: "a1" }),
});

const result = {
  unauthorizedStatus: unauthorized.status,
  pageStatus: page.status,
  pageHasTitle: (await page.text()).includes("截图桥"),
  stateStatus: state.status,
  stateItems: (await state.json()).items.length,
  imageStatus: image.status,
  imageBytes: (await image.arrayBuffer()).byteLength,
  shootStatus: shoot.status,
  shootCalled: shot,
  resendStatus: resend.status,
  resendCalled: resent.length,
  resendOk: (await resend.json()).ok,
};
server.close();
console.log(JSON.stringify(result));

const pass = result.unauthorizedStatus === 401 && result.pageStatus === 200 && result.pageHasTitle &&
  result.stateStatus === 200 && result.stateItems === 1 && result.imageStatus === 200 &&
  result.imageBytes === 8 && result.shootStatus === 200 && result.shootCalled === 1 && result.resendStatus === 200 &&
  result.resendCalled === 1 && result.resendOk === true;
process.exit(pass ? 0 : 1);