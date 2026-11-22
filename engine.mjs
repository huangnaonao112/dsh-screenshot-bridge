/**
 * 引擎单例：把 rapidocr-node 的会话只加载一次，进程内反复用。
 * 模型优先用插件自带的 models/，其次落到 %DSH_HOME%\screenshot-bridge\models（首次联网下载一次）。
 */

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.join(HERE, "models");

function cachedModelDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
    ? process.env.DSH_HOME
    : path.join(os.homedir(), ".dsh");
  return path.join(home, "screenshot-bridge", "models");
}

/** 自带模型优先；否则用缓存目录（第一次会下载，约 30 MB）。 */
export function modelDirectory() {
  if (process.env.DSH_EXTRACT_MODELS) return process.env.DSH_EXTRACT_MODELS;
  const det = path.join(BUNDLED, "PP-OCRv6_det_small.onnx");
  const rec = path.join(BUNDLED, "PP-OCRv6_rec_small.onnx");
  if (existsSync(det) && existsSync(rec)) return BUNDLED;
  return cachedModelDir();
}

/** 可选的高精度模型目录（`npm run models:medium` 才会装）。 */
const MEDIUM_DIR = path.join(BUNDLED, "medium");

function mediumPaths() {
  const det = path.join(MEDIUM_DIR, "PP-OCRv6_det_medium.onnx");
  const rec = path.join(MEDIUM_DIR, "PP-OCRv6_rec_medium.onnx");
  const dict = path.join(BUNDLED, "ppocrv6_dict.txt");
  if (!existsSync(det) || !existsSync(rec) || !existsSync(dict)) return null;
  return { det, rec, dict };
}

let instance = null;
let native = null;

/** 只创建一次；失败不缓存，下一次还能重试。 */
export function engine() {
  if (instance === null) {
    instance = (async () => {
      const { RapidOCR } = await import("rapidocr-node");
      const modelDir = modelDirectory();
      const options = { modelDirectory: modelDir };
      // 默认用自带的 small（实测 medium 在 PDF 页上会把两排图并成一张、且慢 2–3 倍，
      // 所以不自动切换）；只有显式 DSH_EXTRACT_MODEL=medium 才用高精度模型。
      const want = (process.env.DSH_EXTRACT_MODEL ?? "small").toLowerCase();
      const medium = want === "medium" ? mediumPaths() : null;
      if (medium !== null) {
        options.detectionModelPath = medium.det;
        options.recognitionModelPath = medium.rec;
        options.dictionaryPath = medium.dict;
      }
      native = await RapidOCR.create(options);
      return native;
    })().catch((error) => {
      instance = null;
      throw error;
    });
  }
  return instance;
}

export async function close() {
  const current = instance;
  instance = null;
  const real = native ?? (current === null ? null : await current.catch(() => null));
  native = null;
  if (real !== null && real !== undefined) await real.close().catch(() => {});
}

export const enginePaths = { bundled: BUNDLED, cached: cachedModelDir() };
