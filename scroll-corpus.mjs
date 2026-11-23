// scroll-corpus.mjs — render a local copy of a long page at successive scroll
// offsets and score the figure/table extractor on each viewport.
//
//   node scroll-corpus.mjs .web-corpus/a502.html 0 24000 1400
//
// The offset is applied as `body { position: relative; top: -Npx }`, which is a
// layout shift (not a transform) so lazy-loaded images still count as visible.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const [, , htmlPath, fromArg, toArg, stepArg] = process.argv;
const from = Number(fromArg ?? 0);
const to = Number(toArg ?? 20000);
const step = Number(stepArg ?? 1400);

const corpus = path.join(here, ".web-corpus");
const base = path.basename(htmlPath, path.extname(htmlPath));
const outDir = path.join(corpus, `${base}-scroll`);
const profile = path.join(corpus, "profile");
await mkdir(outDir, { recursive: true });
const raw = await readFile(htmlPath, "utf8");

function shoot(offset) {
  return new Promise(async (resolve) => {
    const style = `<style>html{overflow:visible!important}body{position:relative!important;top:${-offset}px!important}</style>`;
    const html = raw.replace("</head>", `${style}</head>`);
    const file = path.join(outDir, `o${offset}.html`);
    await writeFile(file, html, "utf8");
    const image = path.join(outDir, `o${offset}.png`);
    const child = execFile(edge, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--disable-extensions", "--mute-audio", "--allow-file-access-from-files",
      `--user-data-dir=${profile}`,
      "--window-size=1440,1400", "--virtual-time-budget=7000",
      `--screenshot=${image}`,
      `file:///${file.replace(/\\/g, "/")}`,
    ], { windowsHide: true, timeout: 60_000 }, async () => resolve(image));
    child.on("error", () => resolve(null));
  });
}

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
for (let offset = from; offset <= to; offset += step) {
  const image = await shoot(offset);
  if (image === null) { rows.push({ offset, shot: false }); continue; }
  const out = await extract(image, path.join(outDir, `figs-${offset}`));
  const row = {
    offset,
    ok: out.ok,
    chars: typeof out.text === "string" ? out.text.length : 0,
    figures: Array.isArray(out.figures) ? out.figures.length : 0,
    table: out.table ? out.table.cols : null,
    firstLine: typeof out.text === "string" ? out.text.split("\n")[0].slice(0, 50) : "",
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(path.join(outDir, "summary.json"), JSON.stringify(rows, null, 1), "utf8");
console.log("done");