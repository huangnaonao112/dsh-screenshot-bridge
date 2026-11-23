// ocr-server.mjs — long-lived extraction worker.
//
// The Host used to spawn `extract.mjs` per capture, which re-loads the OCR model
// every time (0.5–1 s cold, every shot). This process loads it once and then
// answers NDJSON requests on stdin:
//
//   {"id":"c1","image":"C:\\...png","figuresDir":"C:\\...\\figs"}   ->
//   {"id":"c1","ok":true,"result":{...}}                          or
//   {"id":"c1","ok":false,"error":"..."}
//
// One request at a time (the engine is not re-entrant), so the Host's write
// order is the execution order.

import readline from "node:readline";
import { extractFile } from "./extract.mjs";
import { engine } from "./engine.mjs";

const reply = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    reply({ id: null, ok: false, error: "bad request json" });
    return;
  }
  queue = queue.then(async () => {
    try {
      const ocr = await engine();
      const result = await extractFile(request.image, request.figuresDir ?? null, ocr);
      reply({ id: request.id ?? null, ok: true, result });
    } catch (error) {
      reply({ id: request.id ?? null, ok: false, error: String(error?.message ?? error) });
    }
  });
});

process.stdin.on("end", () => {
  void (async () => {
    await queue.catch(() => {});
    const { close } = await import("./engine.mjs");
    await close().catch(() => {});
    process.exit(0);
  })();
});