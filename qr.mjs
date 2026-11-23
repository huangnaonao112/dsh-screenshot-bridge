// qr.mjs — render a QR code as SVG with the vendored qrcode-generator.
//
// The settings card shows this for the LAN answer page so a phone can scan
// instead of typing the URL + token. No native deps, no network at runtime.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("./vendor/qrcode.cjs");

/**
 * @param {string} text
 * @param {{ cellSize?: number, margin?: number, errorCorrection?: 'L'|'M'|'Q'|'H' }} [options]
 * @returns {string} standalone SVG document
 */
export function qrSvg(text, options = {}) {
  const cell = Math.max(2, Math.min(16, Math.trunc(options.cellSize ?? 5)));
  const margin = Math.max(4, Math.trunc(options.margin ?? 4));
  const qr = qrcode(0, options.errorCorrection ?? "M");
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = (count + margin * 2) * cell;
  const parts = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x = (col + margin) * cell;
      const y = (row + margin) * cell;
      parts.push(`M${x} ${y}h${cell}v${cell}h-${cell}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><path d="${parts.join("")}" fill="#000000"/></svg>`;
}

