import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

/**
 * 模型三件套的获取脚本。
 *
 * - 仓库里带着 models/ 时：只做校验，缺了或坏了才去下（正常情况一条日志就退出）。
 * - 仓库不带 models/（想瘦身仓库）时：npm install 阶段把这三件下下来。
 *
 * 用法：
 *   node scripts/fetch-models.mjs            缺就下，失败退出码 1
 *   node scripts/fetch-models.mjs --optional 失败只警告，不影响安装
 */

const REV = process.env.DSH_MODEL_REVISION || "v3.10.0";
const SOURCE = `https://www.modelscope.cn/api/v1/models/RapidAI/RapidOCR/repo?Revision=${REV}&FilePath=`;
const DEST = path.resolve(import.meta.dirname, "..", "models");
const optional = process.argv.includes("--optional");
const wantMedium = process.argv.includes("--medium");

const SMALL = [
  { name: "PP-OCRv6_det_small.onnx", remote: "onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx", sha256: "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f" },
  { name: "PP-OCRv6_rec_small.onnx", remote: "onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx", sha256: "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884" },
  { name: "ppocrv6_dict.txt", remote: "paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt", sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d" },
];

// 可选的高精度模型（det 62 MB + rec 76 MB）。默认不装；装了就由 DSH_EXTRACT_MODEL=medium 启用。
const MEDIUM = [
  { name: "medium/PP-OCRv6_det_medium.onnx", remote: "onnx/PP-OCRv6/det/PP-OCRv6_det_medium.onnx", sha256: null },
  { name: "medium/PP-OCRv6_rec_medium.onnx", remote: "onnx/PP-OCRv6/rec/PP-OCRv6_rec_medium.onnx", sha256: null },
];


const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function download(item) {
  const target = path.join(DEST, item.name);
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.part`;
  const response = await fetch(SOURCE + item.remote);
  if (!response.ok || response.body === null) throw new Error(`http ${response.status} for ${item.remote}`);
  await new Promise((resolve, reject) => {
    const out = createWriteStream(tmp);
    Readable.fromWeb(response.body).pipe(out).on("finish", resolve).on("error", reject);
  });
  if (item.sha256 !== null) {
    const got = digest(tmp);
    if (got !== item.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`checksum mismatch for ${item.name}: ${got}`);
    }
  }
  renameSync(tmp, target);
  return statSync(target).size;
}

let downloaded = 0;
try {
  mkdirSync(DEST, { recursive: true });
  for (const item of wantMedium ? [...SMALL, ...MEDIUM] : SMALL) {
    const file = path.join(DEST, item.name);
    if (existsSync(file) && (item.sha256 === null || digest(file) === item.sha256)) continue;
    downloaded += await download(item);
    console.log(`fetch-models: got ${item.name}`);
  }
  console.log(downloaded === 0 ? "fetch-models: all present and verified" : `fetch-models: downloaded ${(downloaded / 1048576).toFixed(1)} MB`);
} catch (error) {
  if (!optional) {
    console.error(`fetch-models: ${error && error.message}`);
    process.exit(1);
  }
  console.warn(`fetch-models: skipped (${error && error.message}); extraction will fall back to sending the image`);
}
