import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * onnxruntime-node 解包时把 macOS / Linux / Windows-arm64 的二进制全带上，
 * 实际只用 win32-x64 的 CPU 那一份。这里把别的平台和 GPU 相关的 dll 删掉：
 * 287 MB → 约 30 MB，别人 npm i 也快得多。
 *
 * 只做"删减"，不下载、不改版本；失败一律吞掉，不能因此装不上。
 */

const root = path.resolve(import.meta.dirname, "..", "node_modules", "onnxruntime-node", "bin", "napi-v6");
const dry = process.argv.includes("--dry");

function sizeOf(p) {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (st.isFile()) return st.size;
  return readdirSync(p).reduce((sum, name) => sum + sizeOf(path.join(p, name)), 0);
}

function drop(target) {
  if (!existsSync(target)) return 0;
  const bytes = sizeOf(target);
  if (!dry) rmSync(target, { recursive: true, force: true });
  return bytes;
}

if (!existsSync(root)) {
  console.log("prune-onnxruntime: not installed, skip");
  process.exit(0);
}

const before = sizeOf(root);
const targets = [
  path.join(root, "darwin"),
  path.join(root, "linux"),
  path.join(root, "win32", "arm64"),
];
const gpuDlls = ["DirectML.dll", "dxcompiler.dll", "dxil.dll"];
for (const name of gpuDlls) targets.push(path.join(root, "win32", "x64", name));

let saved = 0;
for (const target of targets) saved += drop(target);
const after = sizeOf(root);

console.log(`${dry ? "[dry] " : ""}prune-onnxruntime: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB (saved ${(saved / 1048576).toFixed(1)} MB)`);
