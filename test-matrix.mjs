import sharp from "sharp";
import { mkdirSync } from "node:fs";
import path from "node:path";

const svgCard = (rows) => {
  const cells = [];
  let n = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      n += 1;
      const x = 30 + c * 62;
      const y = 60 + r * 70;
      cells.push(`<rect x="${x - 14}" y="${y - 26}" width="46" height="40" rx="6" fill="#f4f6fb" stroke="#e2e6ef"/>`);
      cells.push(`<text x="${x + 4}" y="${y + 4}" font-family="Arial" font-size="24" fill="#333">${n}</text>`);
    }
  }
  return `<svg width="340" height="${60 + rows * 70}" xmlns="http://www.w3.org/2000/svg">
    <rect width="340" height="${60 + rows * 70}" fill="#ffffff"/>
    <text x="30" y="28" font-family="Arial" font-size="20" fill="#888">答题卡</text>
    ${cells.join("")}
  </svg>`;
};

const svgPanel = `<svg width="180" height="220" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="4" width="168" height="208" rx="10" fill="#ffffff" stroke="#dddddd"/>
  <text x="24" y="34" font-family="Arial" font-size="15" fill="#666">微信小程序</text>
  <rect x="34" y="52" width="112" height="112" fill="#111"/>
  <text x="52" y="192" font-family="Arial" font-size="13" fill="#999">扫码或长按识别</text>
</svg>`;

async function meta(file) {
  return await sharp(file).metadata();
}

async function scaleTo(src, dst, factor) {
  const m = await meta(src);
  await sharp(src).resize({ width: Math.round(m.width * factor), kernel: "lanczos3" }).png().toFile(dst);
}

/** 左边加一条答题卡栏，图片整体右移 */
async function withAnswerCard(src, dst) {
  const m = await meta(src);
  const card = Buffer.from(svgCard(13));
  await sharp(src)
    .extend({ left: 340, background: "#ffffff" })
    .composite([{ input: card, top: 0, left: 0 }])
    .png()
    .toFile(dst);
}

/** 右边加一块浮窗（二维码小窗） */
async function withRightPanel(src, dst) {
  const m = await meta(src);
  await sharp(src)
    .extend({ right: 200, background: "#ffffff" })
    .composite([{ input: Buffer.from(svgPanel), top: 260, left: m.width + 6 }])
    .png()
    .toFile(dst);
}

const OUT = path.join(process.env.TEMP ?? ".", "dsh-matrix", "cases");
mkdirSync(OUT, { recursive: true });

const DATA = path.join(import.meta.dirname, "testdata");
const BASES = {
  grid6: path.join(DATA, "grid6.png"),
  cube: path.join(DATA, "cube.png"),
  plain: path.join(DATA, "plain.png"),
  // Chrome 内置 PDF 阅读器的真题页（深灰外框 + 白纸页 + 工具栏 + 页脚），另一套完全不同的版式
  pdf: path.join(DATA, "pdf.png"),
};

const cases = [];
for (const [name, src] of Object.entries(BASES)) {
  cases.push({ name: `${name}@100`, file: src, base: null });
  for (const f of [0.75, 0.9, 1.15, 1.4]) {
    const dst = path.join(OUT, `${name}@${String(f).replace(".", "_")}.png`);
    await scaleTo(src, dst, f);
    cases.push({ name: `${name}@${f}`, file: dst, base: name });
  }
  const card = path.join(OUT, `${name}-card.png`);
  await withAnswerCard(src, card);
  cases.push({ name: `${name}@answer-card`, file: card, base: name });

  const panel = path.join(OUT, `${name}-panel.png`);
  await withRightPanel(src, panel);
  cases.push({ name: `${name}@right-panel`, file: panel, base: name });

  const dark = path.join(OUT, `${name}-dark.png`);
  await sharp(src).negate({ alpha: false }).png().toFile(dark);
  cases.push({ name: `${name}@dark`, file: dark, base: name });
}

const report = [];
for (const c of cases) {
  const { extractFile } = await import("./extract.mjs");
  const { engine, close } = await import("./engine.mjs");
  const eng = await engine();
  const t0 = Date.now();
  let r;
  try {
    r = await extractFile(c.file, null, eng);
  } catch (error) {
    report.push({ name: c.name, error: String(error && error.message).slice(0, 80) });
    continue;
  }
  report.push({
    name: c.name,
    ms: Date.now() - t0,
    chars: r.text ? r.text.length : 0,
    figs: Array.isArray(r.figures) ? r.figures.length : -1,
    q: Array.isArray(r.questions) ? r.questions.length : 0,
    head: (r.text ?? "").slice(0, 40).replace(/\n/gu, " "),
  });
  await close();
}
console.log(JSON.stringify(report, null, 1));
