// web-corpus.mjs — screenshot real exam pages and score the figure/table extractor.
//
//   node web-corpus.mjs 500 501 502 ...
//
// For each aipta article id: headless Edge screenshot (1440x2600), then run
// extract.mjs with a figures dir and record chars / figures / table / warnings.

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const corpus = path.join(here, ".web-corpus");
const profile = path.join(corpus, "profile");
await mkdir(corpus, { recursive: true });

function shoot(url, out) {
  return new Promise((resolve) => {
    const child = spawn(edge, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--disable-extensions", "--mute-audio",
      `--user-data-dir=${profile}`,
      "--window-size=1440,2600",
      "--virtual-time-budget=9000",
      `--screenshot=${out}`,
      url,
    ], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 45_000);
    child.on("exit", async () => {
      clearTimeout(timer);
      try {
        const info = await stat(out);
        resolve(info.size > 20_000);
      } catch {
        resolve(false);
      }
    });
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

const ids = process.argv.slice(2).map(Number);
const rows = [];
for (const id of ids) {
  const url = `https://www.aipta.com/article/${id}.html`;
  const image = path.join(corpus, `a${id}.png`);
  const shot = await shoot(url, image);
  if (!shot) { rows.push({ id, shot: false }); console.log(`#${id} shot FAILED`); continue; }
  const out = await extract(image, path.join(corpus, `figs-${id}`));
  const row = {
    id,
    ok: out.ok,
    mode: out.mode,
    chars: typeof out.text === "string" ? out.text.length : 0,
    figures: Array.isArray(out.figures) ? out.figures.length : 0,
    figKinds: Array.isArray(out.figures) ? out.figures.map((f) => f.kind ?? "fig") : [],
    table: out.table ? { cols: out.table.cols, rows: out.table.rows } : null,
    relaxed: out.stats?.figureRelaxed === true,
    warnings: out.warnings ?? [],
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(path.join(corpus, "summary.json"), JSON.stringify(rows, null, 1), "utf8");
console.log("summary written");