import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * 回归自测：矩阵不变式 + 真实网页截图 + 真机样本 + 校验告警 + 双栏切分。
 * 用法：node test-suite.mjs        （失败退出码 1）
 */

const HERE = import.meta.dirname;
const SHOTS = path.join(os.homedir(), ".dsh", "screenshot-bridge", "shots");
const WEB = path.join(process.env.TEMP ?? os.tmpdir(), "webcrawl");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

const { extractFile } = await import("./extract.mjs");
const eng = await (await import("./engine.mjs")).engine();

// 1) 32 个合成变体：图形页张数必须与底片一致，纯文字页必须 0
const matrix = JSON.parse(execFileSync(process.execPath, [path.join(HERE, "test-matrix.mjs")], { encoding: "utf8" }));
const wantFigs = { grid6: 2, cube: 1, plain: 0, pdf: 2 };
const wantChars = { grid6: 600, cube: 90, plain: 480, pdf: 400 };
check("matrix/count", matrix.length === 32, `${matrix.length} cases`);
for (const row of matrix) {
  const base = row.name.split("@")[0];
  const figsOk = row.figs === wantFigs[base];
  const charsOk = row.chars >= wantChars[base];
  check(`matrix/${row.name}`, figsOk && charsOk, `chars=${row.chars} figs=${row.figs}`);
}

// 2) 真实网页截图（力扣 / 洛谷 / Codeforces / 无忧考网）
const WEB_EXPECT = {
  "lc-twosum.png": { min: 250 },
  "lc-rain.png": { min: 180 },
  "lc-container.png": { min: 180 },
  "luogu.png": { min: 380 },
  "luogu-p1002.png": { min: 200 },
  "cf-4a.png": { min: 800 },
  "51test-gwy-doc.png": { min: 240 },
};
for (const [file, expect] of Object.entries(WEB_EXPECT)) {
  const full = path.join(WEB, file);
  if (!existsSync(full)) {
    check(`web/${file}`, false, "sample missing");
    continue;
  }
  const out = await extractFile(full, null, eng);
  check(`web/${file}`, out.ok && out.text.length >= expect.min, `chars=${out.text.length} mode=${out.mode}`);
}

// 3) 真机样本（题库/PDF/纯文字）
const SHOT_EXPECT = [
  ["shot-20261122-082553-822.png", 440, 2],
  ["shot-20261122-052043-711.png", 95, 1],
  ["shot-20261122-034949-276.png", 680, 2],
  ["shot-20261122-082631-401.png", 440, 2],
];
for (const [file, minChars, figs] of SHOT_EXPECT) {
  const full = path.join(SHOTS, file);
  if (!existsSync(full)) {
    check(`shot/${file}`, false, "sample missing");
    continue;
  }
  const out = await extractFile(full, null, eng);
  check(`shot/${file}`, out.ok && out.text.length >= minChars, `chars=${out.text.length} figs=${out.figures.length}`);
  if (figs > 0) check(`shot/${file}/figs`, out.figures.length === figs, `${out.figures.length} vs ${figs}`);
}

// 4) 校验告警：把一页裁掉下半（选项丢了）应该主动报"选项不全"
{
  const sharp = (await import("sharp")).default;
  const src = path.join(SHOTS, "shot-20261122-052043-711.png");
  const dst = path.join(process.env.TEMP ?? os.tmpdir(), "suite-clipped.png");
  const meta = await sharp(src).metadata();
  await sharp(src).extract({ left: 0, top: 0, width: meta.width, height: Math.round(meta.height * 0.55) }).png().toFile(dst);
  const out = await extractFile(dst, null, eng);
  const hasWarn = Array.isArray(out.warnings) && out.warnings.length > 0;
  check("warnings/clipped-page", hasWarn, `warnings=${JSON.stringify(out.warnings || [])}`);
}

// 5) 双栏切分：左栏优先输出，右栏单独标注
{
  const fake = [
    { x: 10, x2: 300, y: 10, text: "左一" },
    { x: 10, x2: 300, y: 40, text: "左二" },
    { x: 10, x2: 300, y: 70, text: "左三" },
    { x: 10, x2: 300, y: 100, text: "左四" },
    { x: 620, x2: 800, y: 15, text: "右一" },
    { x: 620, x2: 800, y: 45, text: "右二" },
    { x: 620, x2: 800, y: 75, text: "右三" },
    { x: 620, x2: 800, y: 105, text: "右四" },
  ];
  const { rawTextOf } = await import("./extract.mjs");
  const text = rawTextOf(fake, 20);
  check("raw/two-columns", text.indexOf("—— 右侧栏 ——") > 0 && text.indexOf("左四") < text.indexOf("—— 右侧栏 ——"), text.replace(/\n/gu, " | "));
}

// 6) 表格：带框线的表格要额外按单元格重排，且普通页面不能误报
{
  const tmp = process.env.TEMP ?? os.tmpdir();
  const tablePath = execFileSync(process.execPath, [path.join(HERE, "scripts", "make-table-sample.mjs"), path.join(tmp, "suite-table.png")], {
    encoding: "utf8",
  }).trim();
  const out = await extractFile(tablePath, null, eng);
  const text = out.text ?? "";
  check("table/detected", text.indexOf("【表格重排】") > 0, text.split("\n").slice(-3).join(" | "));
  check("table/cols", out.table && out.table.cols === 3, `table=${JSON.stringify(out.table)}`);
  check("table/rows", text.indexOf("Name | Qty | Price") > 0 && text.indexOf("Cherry | 30 | 9.9") > 0, text.replace(/\n/gu, " | "));
  // 普通截图（无框线）不能被误判成表格
  const plain = await extractFile(path.join(HERE, "testdata", "plain.png"), null, eng);
  check("table/no-false-positive", plain.table === null && (plain.text ?? "").indexOf("【表格重排】") < 0, `table=${JSON.stringify(plain.table)}`);
}

await (await import("./engine.mjs")).close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.log("failed:");
  for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
  process.exit(1);
}
