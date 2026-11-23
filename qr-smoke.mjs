// qr-smoke.mjs — prove the settings-card QR actually encodes the LAN URL.
//
//   node qr-smoke.mjs
//
// Renders the QR with qr.mjs, rasterises it with sharp, decodes it with jsQR and
// compares the payload with the input.

import { createRequire } from "node:module";
import sharp from "sharp";
import { qrSvg } from "./qr.mjs";

const require = createRequire(import.meta.url);
const jsqrModule = require("./vendor/jsqr.cjs");
const decode = typeof jsqrModule === "function" ? jsqrModule : jsqrModule.default;

const samples = [
  "http://192.168.1.5:8787/?k=0123456789abcdef",
  "http://10.0.0.23:8790/?k=deadbeefcafebabe",
  "http://127.0.0.1:8787/?k=" + "a".repeat(64),
];

const results = [];
for (const text of samples) {
  const svg = qrSvg(text, { cellSize: 8, margin: 4 });
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(520, 520, { kernel: "nearest" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const decoded = decode(new Uint8ClampedArray(data), info.width, info.height);
  results.push({ length: text.length, ok: decoded !== null && decoded.data === text, got: decoded === null ? null : decoded.data });
}

console.log(JSON.stringify(results));
process.exit(results.every((entry) => entry.ok) ? 0 : 1);