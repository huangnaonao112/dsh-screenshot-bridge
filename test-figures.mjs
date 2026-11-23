// test-figures.mjs — prove the relaxed pass rescues a thin-line diagram that the
// default thresholds drop.
//
//   node test-figures.mjs
//
// 1. plain.png alone must yield 0 figures (no false positives).
// 2. the same page plus a faint line drawing must yield >= 1 figure, and the
//    result must say it came from the relaxed rule.

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const nodeBin = process.execPath;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

async function extract(imagePath, figuresDir, extraEnv) {
  const { stdout } = await run(nodeBin, [path.join(here, "extract.mjs"), imagePath, figuresDir], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

// 工作区内的临时目录：C:\Env\Temp 在沙箱里不允许写。
const temp = path.join(here, ".fig-test");
await rm(temp, { recursive: true, force: true }).catch(() => {});
await mkdir(temp, { recursive: true });
try {
  const base = path.join(here, "testdata", "plain.png");
  const plain = await extract(base, path.join(temp, "plain-figs"));

  const meta = await sharp(base).metadata();
  const width = meta.width;
  const height = meta.height;
  // 一张"很淡"的题图：细线坐标系 + 一条曲线，墨迹占比约 1%，低于默认 2% 阈值。
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="700" height="300">
    <rect width="700" height="300" fill="#ffffff"/>
    <g stroke="#111111" stroke-width="1" fill="none">
      <path d="M20 280 L680 280"/>
      <path d="M20 280 L20 20"/>
      <path d="M30 270 L230 210 L430 230 L630 160"/>
      <path d="M30 260 L230 190 L430 210 L630 140"/>
      <path d="M30 250 L230 170 L430 190 L630 120"/>
    </g>
  </svg>`);  const composed = await sharp(base)
    .composite([{ input: svg, left: 70, top: Math.max(0, height - 340) }])
    .png()
    .toBuffer();
  const image = path.join(temp, "with-figure.png");
  await writeFile(image, composed);

  const withFigure = await extract(image, path.join(temp, "fig-figs"), { DSH_EXTRACT_FORCE_RELAXED: "1" });

  const result = {
    plainFigures: plain.figures.length,
    figureFigures: withFigure.figures.length,
    relaxed: withFigure.stats.figureRelaxed === true,
    relaxedAdded: withFigure.stats.figureRelaxedAdded ?? 0,
    warnings: withFigure.warnings,
  };
  console.log(JSON.stringify(result));

  const pass = result.plainFigures === 0 && result.figureFigures >= 1 && result.relaxed === true;
  await rm(temp, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
} catch (error) {
  await rm(temp, { recursive: true, force: true }).catch(() => {});
  console.error(error.message);
  process.exit(1);
}





