// test-ocr-worker.mjs — cold vs warm extraction through the resident worker.
//
//   node test-ocr-worker.mjs
//
// Also runs the one-shot extractor twice for comparison.

import { execFile, spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const page = path.join(here, "bin/.shots/shot-20261123-213725-520.jpg");
const images = [page, page, page];

function runWorker(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "ocr-server.mjs")], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, DSH_EXTRACT_MODEL: "small" },
    });
    const times = [];
    const rl = readline.createInterface({ input: child.stdout });
    let index = 0;
    const started = [];
    const send = () => {
      if (index >= requests.length) return;
      const id = String(index + 1);
      started[index] = Date.now();
      child.stdin.write(`${JSON.stringify({ id, image: requests[index], figuresDir: null })}\n`);
    };
    rl.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const i = Number(message.id) - 1;
      times[i] = Date.now() - started[i];
      if (message.ok !== true) { reject(new Error(message.error)); child.kill(); return; }
      index += 1;
      if (index >= requests.length) {
        child.stdin.end();
        child.kill();
        resolve(times);
      } else {
        send();
      }
    });
    child.on("error", reject);
    send();
    setTimeout(() => { try { child.kill(); } catch {} reject(new Error("worker timeout")); }, 120_000);
  });
}

function runOneShot(image) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    execFile(process.execPath, [path.join(here, "extract.mjs"), image], { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error && !stdout) return reject(error);
      const elapsed = Date.now() - started;
      try { resolve({ elapsed, ok: JSON.parse(String(stdout).trim().split("\n").pop()).ok === true }); }
      catch { reject(new Error("unparseable")); }
    });
  });
}

const warm = await runWorker(images);
const cold = [];
for (const image of images) cold.push(await runOneShot(image));
const result = { workerMs: warm, oneShotMs: cold.map((row) => row.elapsed) };
console.log(JSON.stringify(result));
const pass = warm.every((ms) => ms > 0) && warm[2] < warm[0] && cold.every((row) => row.ok);
process.exit(pass ? 0 : 1);
