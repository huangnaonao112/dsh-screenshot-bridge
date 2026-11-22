import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * 安装钩子：补模型（缺了才下，失败不阻塞）+ 裁掉 onnxruntime 里用不到的平台。
 * 任何一步失败都只警告，绝不让 npm install 失败。
 */
const here = import.meta.dirname;
for (const entry of [["fetch-models.mjs", ["--optional"]], ["prune-onnxruntime.mjs", []]]) {
  try {
    execFileSync(process.execPath, [path.join(here, entry[0]), ...entry[1]], { stdio: "inherit" });
  } catch (error) {
    console.warn(`postinstall: ${entry[0]} skipped (${error && error.message})`);
  }
}
