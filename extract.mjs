/**
 * screenshot-bridge · 题面提取器（Node 版，无 Python 依赖）
 *
 * 与 extract.py 同一套规则：认字 → 切题 → 抠图 → 拼装。区别只在引擎：
 * OCR 用 rapidocr-node（onnxruntime-node + PP-OCRv6 模型），像素用 sharp。
 *
 * 用法（进程内）：const { extractFile } = await import("./extract.mjs")
 * 用法（命令行）：node extract.mjs <png> [figuresDir]
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------ 题号 / 选项的候选写法 */

const DIGITS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const CIRCLED = "ⒶⒷⒸⒹⒺⒻ";
const SECTION_WORDS = ["单选", "多选", "判断", "填空", "简答", "问答", "编程", "论述", "计算",
  "名词解释", "综合", "案例", "分析"];
const SECTION_RE = /^([一二三四五六七八九十]{1,3})\s*[、.．]\s*/u;

const STEM = {
  数字顿号: { re: /^(\d{1,2})\s*[、.．]\s*/u, num: (m) => Number(m[1]) },
  括号数字: { re: /^[（(]\s*(\d{1,2})\s*[)）]\s*/u, num: (m) => Number(m[1]) },
  数字右括号: { re: /^(\d{1,2})\s*[)）]\s*/u, num: (m) => Number(m[1]) },
  第N题: { re: /^第\s*(\d{1,2})\s*[题道]\s*[、.．:：]?\s*/u, num: (m) => Number(m[1]) },
  圈号: { re: new RegExp(`^([${DIGITS}])\\s*`, "u"), num: (m) => DIGITS.indexOf(m[1]) + 1 },
};

const OPT = {
  字母点: { re: /^([A-Fa-f])\s*[.．、]\s*/u },
  括号字母: { re: /^[（(]\s*([A-Fa-f])\s*[)）]\s*/u },
  字母右括号: { re: /^([A-Fa-f])\s*[)）]\s*/u },
  圈字母: { re: new RegExp(`^([${CIRCLED}])\\s*`, "u") },
};

const CODE_RE = /(^[#/{}]|^int\s|^return\s|^printf|^#include|^void\s|^\/\/|^\/\*)/u;
const LABEL_RE = /^[（(]?([A-Ha-h])[)）]?[、.．]?$/u;

/* ------------------------------------------------------------ 小工具 */

const cjkRatio = (s) => [...s].filter((ch) => ch >= "\u4e00" && ch <= "\u9fff").length / Math.max(1, [...s].length);
const width = (t) => [...t].length;   // 按字符数算，和 Python 的 len() 一致

function dominantHeight(rows) {
  const hs = rows.map((r) => r.y2 - r.y).filter((h) => h >= 6);
  if (hs.length === 0) return 18;
  let bestV = 18;
  let bestC = -1;
  for (const v of [...new Set(hs)].sort((a, b) => a - b)) {
    let c = 0;
    for (const h of hs) if (Math.abs(h - v) <= 2) c += 1;
    if (c > bestC) {
      bestV = v;
      bestC = c;
    }
  }
  return bestV;
}

function anchorHeight(rows) {
  const body = rows.filter((r) => !(SECTION_RE.test(r.text) && SECTION_WORDS.some((w) => r.text.includes(w))));
  return dominantHeight(body);
}

/** A) 一行被切成 ≥4 个超短碎片 → 工具栏/图标条；B) 同 x 连续递增的纯数字 → 行号 */
function stripChromeFragments(rows, lh) {
  const bandTol = Math.max(2, Math.round(lh * 0.2));
  const medianLen = (rs) => [...rs].sort((a, b) => width(a.text) - width(b.text))[Math.floor(rs.length / 2)];
  const keep = [];
  let dropped = 0;
  let band = [];
  const flush = () => {
    if (band.length === 0) return;
    if (band.length >= 4 && width(medianLen(band).text) <= 6) {
      // 答题卡的 1 2 3 4 5 和右边的题干常在同一行，只甩掉那些短碎片，
      // 别把同一行里的整句题目一起带走。
      // 短碎片≠一定是图标：选项"D.7""C.堆排序"本身就很短，带题号/选项标记的要留下。
      const looksContent = (s) => /^[（(]?[A-Fa-f][)）.．、]/u.test(s) || /^\d{1,2}\s*[、.．]/u.test(s);
      const shorts = band.filter((r) => width(r.text) <= 6 && !looksContent(r.text));
      if (shorts.length >= 4) {
        dropped += shorts.length;
        if (process.env.DSH_EXTRACT_DEBUG === "1") {
          for (const r of shorts) console.error("[chrome-short]", r.y, r.x, JSON.stringify(r.text));
        }
        keep.push(...band.filter((r) => !shorts.includes(r)));
        band = [];
        return;
      }
    }
    keep.push(...band);
    band = [];
  };
  for (const r of [...rows].sort((a, b) => a.y - b.y)) {
    if (band.length > 0 && r.y - band[0].y > bandTol) flush();
    band.push(r);
  }
  flush();

  const nums = keep.filter((r) => /^\d+$/u.test(r.text) && r.text.length <= 3);
  const gut = new Set();
  for (const r of nums) {
    const same = nums.filter((n) => Math.abs(n.x - r.x) <= lh * 0.5).sort((a, b) => a.y - b.y);
    if (same.length >= 3) {
      let step = 0;
      for (let i = 0; i + 1 < same.length; i += 1) if (Number(same[i + 1].text) - Number(same[i].text) === 1) step += 1;
      if (step >= same.length - 1) for (const n of same) gut.add(n);
    }
  }
  return { rows: keep.filter((r) => !gut.has(r)), dropped, lines: gut.size };
}

/** 同一视觉行里的碎片按 x 拼回一行 */
function buildLines(rows, lh) {
  const bandTol = Math.max(2, Math.round(lh * 0.2));
  const mergeGap = Math.round(lh * 3.6);
  const lines = [];
  let band = [];
  const flush = () => {
    if (band.length === 0) return;
    band.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const r of band) {
      if (cur !== null) {
        const gap = r.x - cur.x2;
        // OCR 的字框偶尔会互相压一点（"D、" 和它后面的正文），允许轻微重叠，别拆成两行。
        // 但两段各自都以选项标记开头时（A.… B.… 排在同一行），必须拆开。
        const bothOpt = /^[（(]?[A-Fa-f][)）.．、]/u.test(cur.text) && /^[（(]?[A-Fa-f][)）.．、]/u.test(r.text);
        if (!bothOpt && gap >= -Math.round(lh * 0.4) && gap <= mergeGap) {
          cur.text += r.text;
          cur.x2 = Math.max(cur.x2, r.x2);
          cur.y2 = Math.max(cur.y2, r.y2);
          cur.frags.push(r);
          continue;
        }
        lines.push(cur);
      }
      cur = { text: r.text, x: r.x, y: r.y, x2: r.x2, y2: r.y2, h: r.y2 - r.y, frags: [r] };
    }
    if (cur !== null) lines.push(cur);
    band = [];
  };
  for (const r of [...rows].sort((a, b) => a.y - b.y)) {
    if (band.length > 0 && r.y - band[0].y > bandTol) flush();
    band.push(r);
  }
  flush();
  lines.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return lines;
}

function pickTemplate(lines, candidates, minHits = 2) {
  let best = null;
  for (const [name, spec] of Object.entries(candidates)) {
    let hits = 0;
    const nums = [];
    for (const ln of lines) {
      const m = spec.re.exec(ln.text);
      if (!m) continue;
      hits += 1;
      if (spec.num) nums.push(spec.num(m));
    }
    if (hits < minHits) continue;
    let mono = 1;
    if (nums.length >= 3) {
      let ok = 0;
      for (let i = 0; i + 1 < nums.length; i += 1) if (nums[i + 1] === nums[i] + 1 || nums[i + 1] > nums[i]) ok += 1;
      mono = ok / (nums.length - 1);
    }
    const score = hits * (0.5 + 0.5 * mono);
    if (best === null || score > best.score) best = { name, score, spec, hits, mono };
  }
  return best;
}

const isMarker = (t) => Object.values(STEM).some((s) => s.re.test(t)) || Object.values(OPT).some((s) => s.re.test(t));

/* --------------------------------------------------------- 图像与原语 */

/** 灰度 + 原始 RGB，一次解码两用 */
async function loadPixels(imagePath) {
  const sharp = (await import("sharp")).default;
  const gray = await sharp(imagePath).greyscale().raw().toBuffer({ resolveWithObject: true });
  // 截图 PNG 有时带 alpha（4 通道），不剥掉的话按 3 通道取色会整体错位，
  // 白底会被当成"高饱和色块"，把整行正文当按钮丢掉。
  const rgb = await sharp(imagePath).removeAlpha().toColourspace("srgb").raw()
    .toBuffer({ resolveWithObject: true });
  return {
    gray: gray.data,
    rgb: rgb.data,
    W: gray.info.width,
    H: gray.info.height,
  };
}

/** 9×9 矩形膨胀，可分离实现：先横向窗口取最大，再纵向 */
function dilate(mask, W, H, radius) {
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  const span = radius * 2 + 1;
  const prefix = new Int32Array(W + 1);
  for (let y = 0; y < H; y += 1) {
    const row = y * W;
    prefix[0] = 0;
    for (let x = 0; x < W; x += 1) prefix[x + 1] = prefix[x] + mask[row + x];
    for (let x = 0; x < W; x += 1) {
      const lo = Math.max(0, x - radius);
      const hi = Math.min(W - 1, x + radius);
      tmp[row + x] = prefix[hi + 1] - prefix[lo] > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < W; x += 1) {
    for (let y = 0; y < H; y += 1) prefix[y + 1] = prefix[y] + tmp[y * W + x];
    for (let y = 0; y < H; y += 1) {
      const lo = Math.max(0, y - radius);
      const hi = Math.min(H - 1, y + radius);
      out[y * W + x] = prefix[hi + 1] - prefix[lo] > 0 ? 1 : 0;
    }
  }
  return out;
}

/** 8 邻接连通域：返回每个域的包围盒与像素数 */
function connectedComponents(mask, W, H) {
  const label = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const comps = [];
  let next = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const idx = y * W + x;
      if (mask[idx] === 0 || label[idx] !== 0) continue;
      next += 1;
      let top = 0;
      stack[top] = idx;
      top += 1;
      label[idx] = next;
      let minX = x; let maxX = x; let minY = y; let maxY = y; let area = 0;
      while (top > 0) {
        top -= 1;
        const at = stack[top];
        const cy = Math.floor(at / W);
        const cx = at - cy * W;
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = cy + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= W) continue;
            const ni = ny * W + nx;
            if (mask[ni] === 0 || label[ni] !== 0) continue;
            label[ni] = next;
            stack[top] = ni;
            top += 1;
          }
        }
      }
      comps.push({ x: minX, y: minY, x2: maxX + 1, y2: maxY + 1, area });
    }
  }
  return comps;
}

/** 块是不是"彩色按钮"：饱和度和亮度都够高（等价于 OpenCV 的 S/V 均值判据） */
function satBlock(px, b) {
  const { rgb, W, H } = px;
  const x1 = Math.max(0, b.x);
  const y1 = Math.max(0, b.y);
  const x2 = Math.min(W, b.x2);
  const y2 = Math.min(H, b.y2);
  if (x2 <= x1 || y2 <= y1) return false;
  let sumS = 0;
  let sumV = 0;
  let n = 0;
  for (let y = y1; y < y2; y += 2) {
    for (let x = x1; x < x2; x += 2) {
      const i = (y * W + x) * 3;
      const r = rgb[i]; const g = rgb[i + 1]; const bl = rgb[i + 2];
      const max = Math.max(r, g, bl);
      const min = Math.min(r, g, bl);
      sumS += max === 0 ? 0 : (max - min) / max;
      sumV += max / 255;
      n += 1;
    }
  }
  if (n === 0) return false;
  return sumS / n >= 0.35 && sumV / n >= 0.25;
}

/* ------------------------------------------------------------- 抠图 */

function mergeComps(comps, gapY) {
  const blocks = [];
  for (const c of [...comps].sort((a, b) => a.y - b.y)) {
    let found = false;
    for (const b of blocks) {
      const overlap = Math.min(b.x2, c.x2) - Math.max(b.x, c.x);
      const minW = Math.min(b.x2 - b.x, c.x2 - c.x);
      if (c.y - b.y2 <= gapY && overlap > -minW * 0.5) {
        b.x = Math.min(b.x, c.x); b.y = Math.min(b.y, c.y);
        b.x2 = Math.max(b.x2, c.x2); b.y2 = Math.max(b.y2, c.y2);
        b.ink += c.ink;
        found = true;
        break;
      }
    }
    if (!found) blocks.push({ ...c });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < blocks.length; i += 1) {
      for (let j = i + 1; j < blocks.length; j += 1) {
        const a = blocks[i];
        const b = blocks[j];
        if (b.y - a.y2 <= gapY * 0.6 && Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 0) {
          a.x = Math.min(a.x, b.x); a.y = Math.min(a.y, b.y);
          a.x2 = Math.max(a.x2, b.x2); a.y2 = Math.max(a.y2, b.y2);
          a.ink += b.ink;
          blocks.splice(j, 1);
          changed = true;
          break;
        }
        // 并排的图（一道题里横着排开的几个图形/几张图）也要粘成一块，
        // 否则每张都太小，会被"太小"规则逐个甩掉。
        const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x2, b.x2));
        const overlapY = Math.min(a.y2, b.y2) - Math.max(a.y, b.y);
        const shortY = Math.min(a.y2 - a.y, b.y2 - b.y);
        if (gapX <= gapY * 5.5 && shortY > 0 && overlapY >= shortY * 0.5) {
          a.x = Math.min(a.x, b.x); a.y = Math.min(a.y, b.y);
          a.x2 = Math.max(a.x2, b.x2); a.y2 = Math.max(a.y2, b.y2);
          a.ink += b.ink;
          blocks.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return blocks;
}

/** "被文字盖住的是字，抹掉字剩下的墨迹就是图" → 圈矩形 */
function detectFigures(px, boxes, lh, tally) {
  const { gray, W, H } = px;
  const dbg = process.env.DSH_EXTRACT_DEBUG === "1";
  const textShareOf = (b) => {
    const area = Math.max(1, (b.x2 - b.x) * (b.y2 - b.y));
    let sum = 0;
    for (const t of boxes) {
      const ix = Math.max(0, Math.min(b.x2, t.x2) - Math.max(b.x, t.x));
      const iy = Math.max(0, Math.min(b.y2, t.y2) - Math.max(b.y, t.y));
      const cx = (t.x + t.x2) / 2;
      const cy = (t.y + t.y2) / 2;
      if (b.x <= cx && cx <= b.x2 && b.y <= cy && cy <= b.y2) sum += ix * iy;
    }
    return sum / area;
  };
  const drop = (why, b, extra) => {
    if (dbg) console.error("[fig:drop]", why, b.x, b.y, b.x2 - b.x, b.y2 - b.y, extra ?? "");
    // 大块、墨迹不浓不稀、里面几乎没字 —— 这是一张图被规则甩掉的样子，记一笔让上层补发原截图。
    if (tally && (why === "huge" || why === "cov/density")
      && (b.x2 - b.x) >= lh * 6 && (b.y2 - b.y) >= lh * 4) {
      const d = b.ink / Math.max(1, (b.x2 - b.x) * (b.y2 - b.y));
      if (d >= 0.015 && d <= 0.35 && textShareOf(b) <= 0.12) tally.suspect = (tally.suspect ?? 0) + 1;
    }
  };
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < ink.length; i += 1) ink[i] = gray[i] < 190 ? 1 : 0;
  // 先把 OCR 认出来的字全部涂掉，剩下的墨迹才是"图"。
  // 这样一整段文字不会跟旁边的图粘成一大块，段落自己也会消失。
  for (const t of boxes) {
    const x1 = Math.max(0, t.x - 1);
    const y1 = Math.max(0, t.y - 1);
    const x2 = Math.min(W, t.x2 + 1);
    const y2 = Math.min(H, t.y2 + 1);
    for (let y = y1; y < y2; y += 1) ink.fill(0, y * W + x1, y * W + x2);
  }
  const closed = dilate(ink, W, H, 4);
  const raw = connectedComponents(closed, W, H);

  const comps = [];
  for (const c of raw) {
    const w = c.x2 - c.x;
    const h = c.y2 - c.y;
    if (w < 24 || h < 12 || c.area < 120) continue;
    if (w > W * 0.85 || h > H * 0.85) continue;
    let inkPx = 0;
    for (let y = c.y; y < c.y2; y += 1) {
      const row = y * W;
      for (let x = c.x; x < c.x2; x += 1) inkPx += ink[row + x];
    }
    if (inkPx < 40) continue;
    comps.push({ x: c.x, y: c.y, x2: c.x2, y2: c.y2, ink: inkPx });
  }

  const figs = [];
  for (const b of mergeComps(comps, Math.max(6, Math.round(lh * 0.7)))) {
    const w = b.x2 - b.x;
    const h = b.y2 - b.y;
    if (dbg) console.error("[fig:cand]", b.x, b.y, w, h, b.ink, (b.ink / Math.max(1, w * h)).toFixed(3));
    // 太小的是图标/工具栏按钮，太大的是整块白卡片，都不是题图。
    if (w < 130 || h < 80 || w < lh * 2.2 || h < lh * 2.2) { drop("small", b, `lh=${lh}`); continue; }
    if (w * h > W * H * 0.15) { drop("huge", b, W * H * 0.15); continue; }
    if (w / h > 8 && h < lh * 4) { drop("wide", b); continue; }
    let covered = 0;
    let insideChars = 0;
    let insideArea = 0;
    for (const t of boxes) {
      const ix = Math.max(0, Math.min(b.x2, t.x2) - Math.max(b.x, t.x));
      const iy = Math.max(0, Math.min(b.y2, t.y2) - Math.max(b.y, t.y));
      covered += ix * iy;
      const cx = (t.x + t.x2) / 2;
      const cy = (t.y + t.y2) / 2;
      if (b.x <= cx && cx <= b.x2 && b.y <= cy && cy <= b.y2) {
        insideChars += width(t.text);
        insideArea += ix * iy;
      }
    }
    // 成段的字就是段落。但图题里常有 ①②③ 这种小标号，字少、占面积也小，
    // 不能因为它就把整块图判掉，所以字数和"字迹占块面积"要一起看。
    const textShare = insideArea / Math.max(1, w * h);
    if (insideChars >= 20 && textShare > 0.16) { drop("text-block", b, `chars=${insideChars} share=${textShare.toFixed(3)}`); continue; }
    const cov = covered / Math.max(1, w * h);
    const density = b.ink / Math.max(1, w * h);
    if (cov > 0.3 || density < 0.02 || density > 0.45) { drop("cov/density", b, `cov=${cov.toFixed(3)} d=${density.toFixed(3)}`); continue; }
    figs.push({ ...b, cov: Math.round(cov * 1000) / 1000 });
  }

  // 选项标签：紧贴左侧（竖直有重叠）或正下方居中的单个字母，一起吞进来
  for (const f of figs) {
    f.label = null;
    for (const t of boxes) {
      const m = LABEL_RE.exec(t.text.trim());
      if (!m) continue;
      const overlap = Math.min(f.y2, t.y2) - Math.max(f.y, t.y);
      const leftClose = (f.x - t.x2) > 0 && (f.x - t.x2) < lh * 6 && overlap > (f.y2 - f.y) * 0.4;
      const below = f.y2 <= t.y && t.y < f.y2 + lh * 1.2 && t.x >= f.x && t.x2 <= f.x2 + lh;
      if (leftClose || below) {
        f.label = m[1].toUpperCase();
        f.x = Math.min(f.x, t.x);
        f.y = Math.min(f.y, t.y);
        f.x2 = Math.max(f.x2, t.x2);
        f.y2 = Math.max(f.y2, t.y2);
        break;
      }
    }
  }
  return figs;
}

/** 页面"底色"：取中间区域的灰度众数。只看中间，免得被深色的浏览器边框/工具栏带偏。 */
function backgroundGray(gray, W, H) {
  const x1 = Math.round(W * 0.12);
  const x2 = Math.round(W * 0.88);
  const y1 = Math.round(H * 0.12);
  const y2 = Math.round(H * 0.88);
  const hist = new Uint32Array(256);
  for (let y = y1; y < y2; y += 2) {
    const row = y * W;
    for (let x = x1; x < x2; x += 2) hist[gray[row + x]] += 1;
  }
  let best = 255;
  let bestCount = 0;
  for (let v = 0; v < 256; v += 1) {
    if (hist[v] > bestCount) {
      bestCount = hist[v];
      best = v;
    }
  }
  return best;
}

/* ---------------------------------------------------- 表格（有框线的题） */

/** 把命中行/列聚成一条线：相邻像素差 ≤2 就算同一条 */
function clusterTicks(list, gap = 2) {
  const out = [];
  for (const v of list) {
    const last = out[out.length - 1];
    if (last !== undefined && v - last[1] <= gap) last[1] = v;
    else out.push([v, v]);
  }
  return out.map(([a, b]) => Math.round((a + b) / 2));
}

/** 找横线：某一 y 上最长的一段连续深色像素是否够长（≥ 50% 宽） */
function hRulings(px) {
  const { gray, W, H } = px;
  const hits = [];
  for (let y = 0; y < H; y += 1) {
    const row = y * W;
    let run = 0;
    let best = 0;
    for (let x = 0; x < W; x += 1) {
      if (gray[row + x] < 150) {
        run += 1;
        if (run > best) best = run;
      } else run = 0;
    }
    if (best >= W * 0.5) hits.push(y);
  }
  return clusterTicks(hits);
}

/** 找竖线：同理，纵向 ≥ 30% 高（竖线通常短一些） */
function vRulings(px) {
  const { gray, W, H } = px;
  const hits = [];
  for (let x = 0; x < W; x += 1) {
    let run = 0;
    let best = 0;
    for (let y = 0; y < H; y += 1) {
      if (gray[y * W + x] < 150) {
        run += 1;
        if (run > best) best = run;
      } else run = 0;
    }
    if (best >= H * 0.3) hits.push(x);
  }
  return clusterTicks(hits);
}

/**
 * 有框线的表格：横线 ≥3、竖线 ≥2 才算表格（单页外的方框只有 2 条横线，放过）。
 * 用框线当行列边界，把 OCR 出来的行按中心点丢进单元格，按行拼「a | b | c」。
 * 认不出来也不影响原有输出，只是多一段【表格重排】。
 */
function tableOf(px, lines, lh) {
  const hs = hRulings(px);
  const vs = vRulings(px);
  if (hs.length < 3 || vs.length < 2) return null;
  // 框线本身就是行列边界：n 条线夹出 n-1 格。
  const band = (edges, v) => {
    if (v < edges[0] || v > edges[edges.length - 1]) return -1;
    let i = 0;
    while (i < edges.length - 2 && v > edges[i + 1]) i += 1;
    return i;
  };
  const cells = new Map();
  for (const ln of lines) {
    const cx = (ln.x + ln.x2) / 2;
    const cy = (ln.y + ln.y2) / 2;
    const r = band(hs, cy);
    const c = band(vs, cx);
    if (r < 0 || c < 0) continue;
    const key = `${r},${c}`;
    cells.set(key, (cells.get(key) ?? "") + (cells.has(key) ? " " : "") + ln.text);
  }
  const rows = [];
  for (let r = 0; r < hs.length - 1; r += 1) {
    const parts = [];
    for (let c = 0; c < vs.length - 1; c += 1) parts.push((cells.get(`${r},${c}`) ?? "").trim());
    if (parts.every((p) => p === "")) continue;
    rows.push(parts.join(" | "));
  }
  const solid = rows.filter((row) => row.split(" | ").filter((p) => p !== "").length >= 2);
  if (solid.length < 2) return null;
  return { rows: rows.slice(0, 40), cols: vs.length - 1, lines: hs.length + vs.length };
}

/* ------------------------------------------------------------ 主流程 */

const stripUrl = (s) => s.replace(/\s+/gu, "");

export async function extractFile(imagePath, figuresDir, engine) {
  const sharp = (await import("sharp")).default;
  // 深色主题（深底浅字）先翻成浅底深字再处理，否则"墨迹=灰<190"一条都取不到。
  const base = await loadPixels(imagePath);
  let workPath = imagePath;
  let px = base;
  let inverted = false;
  const bg = backgroundGray(base.gray, base.W, base.H);
  if (bg < 120) {
    const { tmpdir } = await import("node:os");
    workPath = path.join(tmpdir(), `dsh-inv-${Date.now()}-${Math.round(Math.random() * 1e6)}.png`);
    await sharp(imagePath).negate({ alpha: false }).png().toFile(workPath);
    px = await loadPixels(workPath);
    inverted = true;
  }
  const res = await engine.recognize(workPath);
  const raw = [];
  for (const line of res.lines ?? []) {
    const xs = line.box.map((p) => p.x);
    const ys = line.box.map((p) => p.y);
    raw.push({
      x: Math.round(Math.min(...xs)),
      y: Math.round(Math.min(...ys)),
      x2: Math.round(Math.max(...xs)),
      y2: Math.round(Math.max(...ys)),
      text: stripUrl(String(line.text ?? "")),
    });
  }
  if (raw.length === 0) return { ok: false, reason: "no-text" };
  if (process.env.DSH_EXTRACT_DEBUG === "1") {
    for (const r of raw) console.error("[raw]", r.y, r.x, JSON.stringify(r.text));
  }
  const allBoxes = raw.map((r) => ({ ...r }));

  const lh = anchorHeight(raw);
  const chrome = stripChromeFragments(raw, lh);

  const short = chrome.rows.filter((r) => width(r.text) <= 14).map((r) => r.text);
  const cnt = new Map();
  for (const t of short) cnt.set(t, (cnt.get(t) ?? 0) + 1);
  const maxCnt = cnt.size === 0 ? 0 : Math.max(...cnt.values());
  const repThr = Math.max(2, Math.ceil(maxCnt * 0.5));
  const kept = [];
  let dup = 0;
  for (const r of chrome.rows) {
    const t = r.text;
    if (width(t) <= 14 && (cnt.get(t) ?? 0) >= repThr && repThr >= 3 && !/^[0-9A-Fa-f一二三四]/u.test(t)) {
      dup += 1;
      continue;
    }
    kept.push(r);
  }

  const lines = buildLines(kept, lh);
  if (process.env.DSH_EXTRACT_DEBUG === "1") {
    console.error("[lines]", lines.length, "kept", kept.length, "chrome", chrome.dropped, "dup", dup);
    for (const ln of lines) console.error("[L]", ln.y, ln.x, JSON.stringify(ln.text));
  }

  const xs = [...new Set(lines.map((ln) => ln.x))].sort((a, b) => a - b);
  const groups = [];
  let cur = xs.length > 0 ? [xs[0]] : [];
  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i] - cur[cur.length - 1] <= lh * 0.6) cur.push(xs[i]);
    else {
      groups.push(cur);
      cur = [xs[i]];
    }
  }
  if (cur.length > 0) groups.push(cur);

  let members = [];
  let bestKey = null;
  for (const g of groups) {
    const mem = lines.filter((ln) => g[0] <= ln.x && ln.x <= g[g.length - 1]);
    const stems = mem.filter((m) => isMarker(m.text) && Object.values(STEM).some((s) => s.re.test(m.text))).length;
    // 只有一个"像题号"的行不算题库列——洛谷页右上角一个 "P1001" 就能把整列抢走。
    const stemScore = stems >= 2 ? stems : 0;
    // 用"文字总宽度"而不是"汉字宽度"来量这条列的正文量：英文页面（Codeforces）汉字占比是 0，
    // 只看汉字会把整页判成没有正文。
    const cjk = mem.reduce((sum, m) => sum + width(m.text), 0);
    const span = mem.length === 0 ? 0 : Math.max(...mem.map((m) => m.y2)) - Math.min(...mem.map((m) => m.y));
    if (process.env.DSH_EXTRACT_DEBUG === "1") console.error("[grp]", g.join(","), "mem", mem.length, "stems", stems, "cjk", Math.round(cjk));
    if (bestKey === null || stemScore > bestKey[0]
      || (stemScore === bestKey[0] && cjk > bestKey[1])
      || (stemScore === bestKey[0] && cjk === bestKey[1] && span > bestKey[2])) {
      bestKey = [stemScore, cjk, span];
      members = mem;
    }
  }
  let baseX = members.length > 0 ? Math.min(...members.map((m) => m.x)) : 0;
  const stemX = members.filter((m) => /^\d{1,2}\s*[、.．]/u.test(m.text)).map((m) => m.x);
  baseX = stemX.length > 0 ? Math.min(...stemX) : baseX;

  const optAny = /^[（(]?[A-Fa-f][)）.．、]/u;
  const pct = (arr, p) => arr[Math.max(0, Math.floor(arr.length * p) - 1)];
  const offs = lines
    .filter((ln) => optAny.test(ln.text) && ln.x - baseX > 0 && ln.x - baseX < lh * 8)
    .map((ln) => ln.x - baseX)
    .sort((a, b) => a - b);
  // 列右界：优先按"选项这一行右边缘"量，别按选项前缀的缩进去量——
  // 前缀紧贴题号时缩进会是 0，界会窄到把选项正文自己切掉。
  const ends = lines
    .filter((ln) => optAny.test(ln.text) && ln.x >= baseX - lh && ln.x <= baseX + lh * 8)
    .map((ln) => ln.x2 - baseX)
    .sort((a, b) => a - b);
  let indent;
  if (ends.length >= 2) indent = pct(ends, 0.9) + lh * 0.6;
  else if (offs.length > 0) indent = offs[Math.max(0, Math.floor(offs.length * 0.9) - 1)] + lh * 0.6;
  else {
    // 选项是"A A"这种字母卡片时认不出前缀，就按"贴着这一列的行右边缘"量。
    const near = lines.filter((ln) => ln.x >= baseX - lh && ln.x <= baseX + lh * 6)
      .map((ln) => ln.x2 - baseX)
      .sort((a, b) => a - b);
    indent = near.length >= 2 ? pct(near, 0.9) + lh * 0.6 : lh * 2.2;
  }
  if (offs.length > 0) indent = Math.max(indent, pct(offs, 0.9) + lh * 2.4);
  indent = Math.max(lh * 1.2, Math.min(indent, lh * 40));

  const topY = members.length > 0 ? Math.min(...members.map((m) => m.y)) : 0;
  let inside = lines.filter((ln) => ln.x >= baseX - lh * 2.0 && ln.x <= baseX + indent && ln.y >= topY - lh * 0.5);
  const stats = { lines: lines.length, chrome: chrome.dropped, gutter: chrome.lines, inside: inside.length, lh: Math.round(lh * 10) / 10, col: [baseX, Math.round(baseX + indent)] };

  let before = inside.length;
  inside = inside.filter((ln) => ln.h >= lh * 0.72 || isMarker(ln.text) || cjkRatio(ln.text) >= 0.4);
  stats.small = before - inside.length;

  const codeish = (s) => CODE_RE.test(s) || /[;{}#]|^\s*[a-zA-Z_]\w*\s*\(|^\s*[a-zA-Z_]\w*\s*=/u.test(s);
  before = inside.length;
  inside = inside.filter((ln) => isMarker(ln.text) || !(cjkRatio(ln.text) < 0.25 && codeish(ln.text)));
  stats.code = before - inside.length;

  before = inside.length;
  inside = inside.filter((ln) => {
    const sat = ln.frags.every((f) => satBlock(px, f));
    if (sat && process.env.DSH_EXTRACT_DEBUG === "1") console.error("[sat-drop]", ln.y, ln.x, JSON.stringify(ln.text));
    return !sat;
  });
  stats.button = before - inside.length;
  stats.dup = dup;

  // 图里单个的 ① ② ③ 是图自带的序号，图本身已经画出来了，别当题号也别当选项；
  // 但 "②⑤⑥" 这种是选项内容，得留下。
  const isFigLabel = (s) => {
    const bare = s.replace(/[\s、.，,：:]/gu, "");
    return bare.length > 0 && bare.length <= 2 && /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]+$/u.test(bare);
  };
  before = inside.length;
  inside = inside.filter((ln) => !isFigLabel(ln.text));
  stats.label = before - inside.length;

  // 屏幕最底下一条是任务栏（搜索框、时钟、日期），永远不是题。
  // 中文题库网站常见的"下载真题及答案解析"浮层也是页面杂项。
  before = inside.length;
  inside = inside.filter((ln) => ln.y < px.H * 0.93
    && !/下载.{0,4}(真题|答案|解析)/u.test(ln.text)
    && !/^(搜索|搜一搜)$/u.test(ln.text.trim())
    && !/^第\s*\d+\s*页\s*[/／]\s*共\s*\d+\s*页$/u.test(ln.text.trim())
    && !/本试卷由.{0,10}提供/u.test(ln.text));
  stats.chromeLines = before - inside.length;
  if (process.env.DSH_EXTRACT_DEBUG === "1") {
    console.error("[col]", baseX, Math.round(indent), "inside", inside.length);
    for (const ln of inside) console.error("[ln]", ln.y, ln.x, ln.x2, JSON.stringify(ln.text));
  }

  // 实验模式：不做题号/选项结构切分，只按阅读顺序把整页文字吐出来。
  // 用于"这页不是行测题库、没有 N、+ A.B.C.D 结构"的页面（LeetCode、洛谷、文档预览等）。
  if (process.env.DSH_EXTRACT_RAW === "1") {
    const rawText = inside.slice().sort((a, b) => a.y - b.y).map((l) => l.text).join("\n");
    return {
      ok: rawText.length > 0,
      mode: "raw",
      inverted,
      text: rawText,
      questions: [],
      figures: [],
      suspect: 0,
      hint: /(如下图|如上图|下图|上图|图中|如图|所示)/u.test(rawText),
      gaps: [],
      stats,
    };
  }


  const stemT = pickTemplate(inside, STEM, 2) ?? pickTemplate(inside, STEM, 1);
  const optT = pickTemplate(inside, OPT, 2) ?? pickTemplate(inside, OPT, 1);
  const nStem = stemT === null ? 0 : stemT.hits;
  const listMode = nStem >= 1;
  stats.stem = stemT === null ? null : `${stemT.name}(${nStem})`;
  stats.opt = optT === null ? null : optT.name;

  inside.sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const out = [];
  const warns = [];
  let lastNo = null;
  let expect = null;
  let lastOptLetter = null;
  let lastOptY2 = 0;
  for (const ln of inside) {
    const t = ln.text;
    const sm = stemT === null ? null : stemT.spec.re.exec(t);
    if (sm) {
      lastNo = stemT.spec.num ? stemT.spec.num(sm) : (lastNo ?? 0) + 1;
      // 题干前面常挂一个题型标签（"第82题·判断推理 单选"），去掉它只留题目本身。
      let body = t.slice(sm[0].length).replace(/^[·•・]?\s*(判断推理|图形推理|言语理解与表达|言语理解|数量关系|常识判断|资料分析|定义判断)\s*(单选|多选|判断题?)?\s*/u, "");
      out.push({ txt: `${lastNo}、${body}`, x: ln.x, y: ln.y, y2: ln.y2, h: ln.h, kind: "stem" });
      lastOptLetter = null;
      continue;
    }
    const om = optT === null ? null : optT.spec.re.exec(t);
    if (om) {
      let letter = String(om[1]).toUpperCase();
      if (CIRCLED.includes(letter)) letter = String.fromCharCode(65 + CIRCLED.indexOf(letter));
      out.push({ txt: `${letter}. ${t.slice(om[0].length)}`, x: ln.x, y: ln.y, y2: ln.y2, h: ln.h, kind: "opt" });
      lastOptLetter = letter;
      lastOptY2 = ln.y2;
      continue;
    }
    // 选项前缀认出来了、正文却被拆到下一行（只剩一个 "D、"）时并回去。
    const lastOut = out.length > 0 ? out[out.length - 1] : null;
    if (listMode && lastOut !== null && lastOut.kind === "opt" && /^[A-F]\. *$/u.test(lastOut.txt)
      && ln.x - baseX >= lh * 0.8 && (ln.y - lastOut.y2) < lh * 1.3) {
      lastOut.txt += t;
      lastOut.y2 = ln.y2;
      continue;
    }
    // 选项前缀整段没认出来（例如 B、C 的字母被吞、只剩 ①②⑥ 这种内容）时，
    // 按字母顺序补一个（补号）标记，否则这一行会整条消失。
    // 注意：长段的纯汉字行更可能是"题号没认出来"，交给下面的题干补号，别算成选项。
    if (listMode && lastOptLetter !== null && lastOptLetter < "F"
      && (cjkRatio(t) < 0.6 || width(t) < 15)
      && ln.x - baseX >= lh * 0.8 && width(t) >= 3
      && ln.y >= lastOptY2 + lh * 0.5 && ln.y - lastOptY2 < lh * 2.6) {
      const letter = String.fromCharCode(lastOptLetter.charCodeAt(0) + 1);
      out.push({ txt: `${letter}、（补号）${t}`, x: ln.x, y: ln.y, y2: ln.y2, h: ln.h, kind: "opt" });
      lastOptLetter = letter;
      lastOptY2 = ln.y2;
      continue;
    }
    if (SECTION_RE.test(t) && SECTION_WORDS.some((w) => t.includes(w))) {
      out.push({ txt: t, x: ln.x, y: ln.y, y2: ln.y2, h: ln.h, kind: "sec" });
      lastOptLetter = null;
      lastNo = 0;
      continue;
    }
    // "第五部分 判断推理"这类分段标题，页面里是一行的，别当杂项丢掉。
    if (/^第[一二三四五六七八九十0-9]{1,3}部分/u.test(t)) {
      out.push({ txt: t, x: ln.x, y: ln.y, y2: ln.y2, h: ln.h, kind: "sec" });
      lastOptLetter = null;
      lastNo = 0;
      continue;
    }
    if (/^[、.．]/u.test(t) && SECTION_WORDS.some((w) => t.slice(0, 6).includes(w))) {
      const n = out.filter((o) => o.kind === "sec").length;
      const pre = n < 10 ? `一二三四五六七八九十`[n] + "、" : "、";
      out.push({ txt: pre + t.replace(/^[、.．]+/u, ""), x: ln.x, y: ln.y, y2: ln.y2, h: ln.h, kind: "sec" });
      continue;
    }

    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev !== null && prev.kind === "stem") {
      const endsClean = !/[。.？?]$/u.test(prev.txt);
      if ((ln.y - prev.y2) < prev.h * 1.6 && Math.abs(ln.x - prev.x) <= indent && endsClean) {
        prev.txt += t;
        prev.y2 = ln.y2;
        continue;
      }
    }

    if (!listMode) {
      if (prev !== null && (ln.y - prev.y2) < prev.h * 1.6) {
        prev.txt += t;
        prev.y2 = ln.y2;
      } else {
        out.push({ txt: t, x: ln.x, y: ln.y, y2: ln.y2, h: ln.h, kind: out.length === 0 ? "stem" : "other" });
      }
      continue;
    }

    if (prev !== null && lastNo !== null && ln.x - baseX >= lh * 0.8
      && cjkRatio(t) >= 0.6 && width(t) >= 15
      && (prev.kind === "opt" || ln.y - prev.y2 > lh * 1.3)) {
      lastNo += 1;
      out.push({ txt: `${lastNo}、（补号）${t}`, x: baseX, y: ln.y, y2: ln.y2, h: ln.h, kind: "stem" });
      continue;
    }

    if (prev !== null && (ln.y - prev.y2) < prev.h * 1.6) {
      out.push({ txt: t, x: ln.x, y: ln.y, y2: ln.y2, h: ln.h, kind: "other" });
      continue;
    }
    stats.isolated = (stats.isolated ?? 0) + 1;
  }

  for (const o of out) {
    if (o.kind === "stem") expect = "A";
    else if (o.kind === "opt") {
      const letter = o.txt[0];
      if (expect !== null && letter !== expect) warns.push(`${expect}->${letter}`);
      expect = letter < "F" ? String.fromCharCode(letter.charCodeAt(0) + 1) : null;
    }
  }

  let text = out.map((o) => (o.kind === "opt" ? "    " : "") + o.txt).join("\n");
  const body = out.filter((o) => o.kind === "stem" || o.kind === "opt");
  const ok = body.length > 0 && !(listMode && warns.length > 3);

  const figures = [];
  const tally = { suspect: 0 };
  if (body.length > 0) {
    const top = 0;
    const bottom = px.H * 0.93;
    const left = baseX - lh * 4.0;
    let figs = detectFigures(px, allBoxes, lh, tally).filter((f) => {
      const cy = (f.y + f.y2) / 2;
      // 右边栏（微信码、客服浮窗、摄像头）里的东西一律不算题图：它的左边已经跑到题面列外面了。
      const inColumn = f.x < baseX + indent + lh * 5;
      const keep = cy >= top && cy <= bottom && f.x2 > left && inColumn;
      if (process.env.DSH_EXTRACT_DEBUG === "1" && !keep) {
        console.error("[fig:window-drop]", f.x, f.y, f.x2 - f.x, f.y2 - f.y, `cy=${Math.round(cy)} top=${Math.round(top)} bottom=${Math.round(bottom)} left=${Math.round(left)} inCol=${inColumn}`);
      }
      return keep;
    });

    for (const f of figs) {
      let q = null;
      for (const o of out) {
        if (o.kind !== "stem" || o.y > f.y) continue;
        const m = /^(\d+)、/u.exec(o.txt);
        q = m ? Number(m[1]) : q;
      }
      f.q = q;
    }
    figs.sort((a, b) => a.y - b.y);
    if (figuresDir) await mkdir(figuresDir, { recursive: true }).catch(() => {});
    const stemName = path.basename(imagePath, path.extname(imagePath)).slice(0, 16);
    let index = 0;
    for (const f of figs) {
      index += 1;
      f.n = index;
      const pad = Math.max(8, Math.round(lh * 0.9));
      // 外扩不能把上下相邻的题干/选项字吃进画里（PDF 页上常见），
      // 所以上下留白最多到"离最近一行文字还剩 3px"为止。
      let padTop = pad;
      let padBottom = pad;
      for (const b of allBoxes) {
        const ov = Math.min(f.x2, b.x2) - Math.max(f.x, b.x);
        if (ov < Math.min(f.x2 - f.x, b.w) * 0.5) continue;
        if (b.y2 <= f.y && f.y - b.y2 < padTop) padTop = Math.max(3, f.y - b.y2 - 3);
        if (b.y >= f.y2 && b.y - f.y2 < padBottom) padBottom = Math.max(3, b.y - f.y2 - 3);
      }
      const x1 = Math.max(0, f.x - pad);
      const y1 = Math.max(0, f.y - padTop);
      const x2 = Math.min(px.W, f.x2 + pad);
      const y2 = Math.min(px.H, f.y2 + padBottom);
      const record = { n: index, q: f.q, label: f.label, w: x2 - x1, h: y2 - y1, cov: f.cov };
      if (figuresDir) {
        const file = path.join(figuresDir, `${stemName}-fig${index}.png`);
        await sharp(imagePath).extract({ left: x1, top: y1, width: x2 - x1, height: y2 - y1 }).png().toFile(file);
        record.file = file;
      }
      figures.push(record);
    }
    figs.sort((a, b) => a.y - b.y);

    const merged = [];
    let fi = 0;
    const ordered = figs;
    for (const o of out) {
      while (fi < ordered.length && ordered[fi].y < o.y) {
        const f = ordered[fi];
        merged.push(`〔图${f.n}${f.label ? "：" + f.label : ""}〕`);
        fi += 1;
      }
      merged.push((o.kind === "opt" ? "    " : "") + o.txt);
    }
    while (fi < ordered.length) {
      const f = ordered[fi];
      merged.push(`〔图${f.n}${f.label ? "：" + f.label : ""}〕`);
      fi += 1;
    }
    text = merged.join("\n");
  }

  // 结构切分只对"题号 + A/B/C/D"这一族版式有效。力扣、洛谷、Codeforces 这类页面
  // 根本没有这套结构，硬切会把整页当孤立行扔掉——这时改用整页全文，别输出半页残句。
  const rawAll = rawTextOf(inside, lh);
  let usedRaw = false;
  if (rawAll.length >= 120 && text.length < rawAll.length * 0.6) {
    text = rawAll;
    out.length = 0;
    usedRaw = true;
    stats.rawFallback = true;
  }

  // 本地自己查一遍：题号跳号、某题选项没认全。这两类都是"我看漏了"，
  // 交给上层在提示词里说出来，同时因为原图必发，模型能自己核对。
  const warnings = [];
  const stemNos = out.filter((o) => o.kind === "stem").map((o) => {
    const m = /^(\d{1,3})、/u.exec(o.txt);
    return m ? Number(m[1]) : null;
  }).filter((n) => n !== null);
  for (let i = 1; i < stemNos.length; i += 1) {
    if (stemNos[i] - stemNos[i - 1] > 1) warnings.push(`题号跳号：${stemNos[i - 1]}→${stemNos[i]}`);
  }
  {
    let curNo = null;
    let curTxt = "";
    const counts = new Map();
    for (const o of out) {
      if (o.kind === "stem") {
        const m = /^(\d{1,3})、/u.exec(o.txt);
        curNo = m ? Number(m[1]) : null;
        curTxt = o.txt;
        if (curNo !== null && !counts.has(curNo)) counts.set(curNo, 0);
      } else if (o.kind === "opt" && curNo !== null) {
        counts.set(curNo, (counts.get(curNo) ?? 0) + 1);
      }
    }
    // 题干明显是选择题（有空括号/“以下…的是”），选项却不足两个 → 多半是被切掉或没认出来。
    const looksChoice = /（\s*）|的是[：:]|的一项是|正确的是/u;
    for (const [no, c] of counts) {
      const stem = out.find((o) => o.kind === "stem" && new RegExp(`^${no}、`, "u").test(o.txt));
      const body = stem === undefined ? "" : stem.txt.replace(/^\d{1,3}、/u, "");
      const choice = stem !== undefined && looksChoice.test(stem.txt);
      if (body.length < 8 && c === 0) warnings.push(`第${no}题只认到题号，题干和选项都没认出来`);
      else if (c === 1 || (c === 0 && choice)) warnings.push(`第${no}题选项不全（认到 ${c} 个）`);
    }
  }


  // 有框线的表格：额外按单元格重排一段，避免整行被拍成一句话；不影响上面的原有结果。
  let table = null;
  try {
    table = tableOf(px, allBoxes, lh);
  } catch (error) {
    if (process.env.DSH_EXTRACT_DEBUG === "1") console.error("[table] failed", error.message);
  }
  if (table) {
    if (process.env.DSH_EXTRACT_DEBUG === "1") console.error("[table]", table.cols, table.lines, JSON.stringify(table.rows));
    text += `\n\n【表格重排】${table.cols} 列\n${table.rows.join("\n")}`;
  }

  // 题面自己在说"如下图/所示/坐标图"却不带图，多半是我没认出来 → 让上层把原截图补上。
  const hint = /(如下图|如上图|下图|上图|图中|如图|所示|坐标图|饼图|柱状图|折线图|示意图|流程图)/u.test(text);

  return {
    ok,
    mode: usedRaw ? "raw" : listMode ? "list" : "single",
    inverted,
    text,
    questions: out.map((o) => o.txt),
    figures,
    suspect: tally.suspect,
    hint,
    gaps: warns,
    warnings,
    table: table === null ? null : { cols: table.cols, rows: table.rows.length },
    stats,
  };
}

/** 整页文字按阅读顺序输出；左右两栏（主栏 + 右侧栏）时先出左栏再出右栏，避免两栏串行。 */
export function rawTextOf(inside, lh = 20) {
  const ordered = inside.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (ordered.length === 0) return "";
  const minX = Math.min(...ordered.map((l) => l.x));
  const maxX2 = Math.max(...ordered.map((l) => l.x2));
  const mid = (minX + maxX2) / 2;
  // 只有"两条竖列各自连续、中间有明显空白"时才分栏；否则原样按 y 输出。
  const left = ordered.filter((l) => l.x2 <= mid + lh);
  const right = ordered.filter((l) => l.x > mid + lh * 2);
  const cross = ordered.filter((l) => l.x2 > mid + lh && l.x <= mid + lh * 2);
  if (left.length >= 4 && right.length >= 4 && left.length + right.length >= ordered.length - 1 && cross.length <= 1) {
    const ltxt = left.map((l) => l.text).join("\n");
    const rtxt = right.map((l) => l.text).join("\n");
    return ltxt + "\n\n—— 右侧栏 ——\n" + rtxt;
  }
  return ordered.map((l) => l.text).join("\n");
}



if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [image, figDir] = process.argv.slice(2);
  if (!image) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "usage: extract.mjs <png> [figuresDir]" }) + "\n");
    process.exit(2);
  }
  const { engine, close } = await import("./engine.mjs");
  try {
    const result = await extractFile(image, figDir ?? null, await engine());
    process.stdout.write(JSON.stringify(result) + "\n");
    await close();
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, reason: `failed: ${error && error.message}`.slice(0, 300) }) + "\n");
    process.exit(1);
  }
}
