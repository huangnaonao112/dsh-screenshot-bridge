// 生成一张带框线的表格图（拉丁字母 + 数字，避免字体缺失影响 OCR），用来验证【表格重排】
import path from "node:path";
const OUT = process.argv[2] ?? path.join(process.env.TEMP, "dsh-table-test.png");
const sharp = (await import("sharp")).default;

const cols = 3;
const rows = 4; // 表头 + 3 行数据
const cw = 200;
const rh = 60;
const W = cols * cw;
const H = rows * rh;
const data = [
  ["Name", "Qty", "Price"],
  ["Apple", "12", "3.5"],
  ["Banana", "8", "2.0"],
  ["Cherry", "30", "9.9"],
];
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#fff"/>`;
for (let r = 0; r <= rows; r += 1) svg += `<line x1="0" y1="${r * rh}" x2="${W}" y2="${r * rh}" stroke="#000" stroke-width="2"/>`;
for (let c = 0; c <= cols; c += 1) svg += `<line x1="${c * cw}" y1="0" x2="${c * cw}" y2="${H}" stroke="#000" stroke-width="2"/>`;
for (let r = 0; r < rows; r += 1) {
  for (let c = 0; c < cols; c += 1) {
    svg += `<text x="${c * cw + 20}" y="${r * rh + rh / 2 + 12}" font-family="Arial" font-size="30" fill="#000">${data[r][c]}</text>`;
  }
}
svg += "</svg>";
await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(OUT);
