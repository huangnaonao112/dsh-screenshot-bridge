// slice-corpus.mjs — cut a tall page screenshot into viewport-sized slices and
// score the extractor on each (this emulates "the user scrolled and截图").
//
//   node slice-corpus.mjs .web-corpus/a502-tall.png 1200 1400

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const [, , imagePath, stepArg, heightArg] = process.argv;
const step = Number(stepArg ?? 1200);
const height = Number(heightArg ?? 1400);

const meta = await sharp(imagePath).metadata();
const base = path.basename(imagePath, path.extname(imagePath));
const outDir = path.join(here, ".web-corpus", `${base}-slices`);
await mkdir(outDir, { recursive: true });

function extract(image, figures) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(here, "extract.mjs"), image, figures],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error && !stdout) return resolve({ ok: false, reason: error.message });
        try {
          resolve(JSON.parse(String(stdout).trim().split("\n").pop()));
        } catch {
          resolve({ ok: false, reason: "unparseable" });
        }
      });
  });
}

const rows = [];
for (let y = 0; y < meta.height; y += step) {
  const h = Math.min(height, meta.height - y);
  if (h < 400) break;
  const slicePath = path.join(outDir, `slice-${y}.png`);
  await sharp(imagePath).extract({ left: 0, top: y, width: meta.width, height: h }).png().toFile(slicePath);
  const out = await extract(slicePath, path.join(outDir, `figs-${y}`));
  rows.push({
    y,
    ok: out.ok,
    chars: typeof out.text === "string" ? out.text.length : 0,
    figures: Array.isArray(out.figures) ? out.figures.length : 0,
    table: out.table ? out.table.cols : null,
    firstLine: typeof out.text === "string" ? out.text.split("\n")[0].slice(0, 40) : "",
  });
}

await writeFile(path.join(outDir, "summary.json"), JSON.stringify(rows, null, 1), "utf8");
for (const row of rows) console.log(JSON.stringify(row));
console.log("slices:", rows.length);