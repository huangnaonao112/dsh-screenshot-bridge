// analyze-session.mjs — timeline for one DSH session log.
// usage: node analyze-session.mjs <sessionId>
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const target = process.argv[2];
const root = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");

function walk(dir, depth, out) {
  if (depth > 3) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, out);
    else if (entry.name.endsWith(".zstd")) out.push(full);
  }
}

// DSH writes one zstd frame per flush batch; decode every frame in the file.
function readAllFrames(buffer) {
  const offsets = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) offsets.push(i);
  }
  if (offsets.length === 0) return zlib.zstdDecompressSync(buffer).toString("utf8");
  let text = "";
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buffer.length;
    try {
      text += zlib.zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
    } catch {
      // torn frame at the tail
    }
  }
  return text;
}

const files = [];
walk(root, 0, files);

let found = null;
for (const file of files) {
  let text;
  try {
    text = readAllFrames(fs.readFileSync(file));
  } catch {
    continue;
  }
  const firstLine = text.split("\n")[0];
  let header;
  try {
    header = JSON.parse(firstLine);
  } catch {
    continue;
  }
  const id = String(header.id ?? "");
  if (id !== target && ("session-" + id) !== target && id !== target.replace(/^session-/, "")) continue;
  found = { file, text };
  break;
}
if (!found) {
  console.log(JSON.stringify({ error: "session not found", scanned: files.length }));
  process.exit(1);
}

const rows = [];
for (const line of found.text.split("\n")) {
  if (!line.trim()) continue;
  try {
    rows.push(JSON.parse(line));
  } catch {
    // torn tail
  }
}

const events = rows.filter((row) => row && row.type && row.seq !== undefined);
const start = events.length > 0 ? events[0].time : 0;
const out = [];
let last = start;
for (const event of events) {
  const gap = event.time - last;
  last = event.time;
  const entry = {
    seq: event.seq,
    at: new Date(event.time).toISOString().slice(11, 23),
    rel: Math.round((event.time - start) / 1000),
    gap: Math.round(gap / 1000),
    type: event.type,
  };
  const data = event.data ?? {};
  if (event.type === "user/message") {
    const blocks = data.content ?? [];
    entry.text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").slice(0, 120);
    entry.images = blocks.filter((b) => b.type === "image").length;
  }
  if (event.type === "assistant/message") {
    const msg = data.message ?? {};
    entry.tokensOut = data.usage?.outputTokens ?? null;
    entry.tokensIn = data.usage?.inputTokens ?? null;
    entry.blocks = (msg.content ?? []).map((b) => b.type + (b.type === "tool-call" ? ":" + b.name : "")).join(",");
    entry.textLen = (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").length;
  }
  if (event.type === "tool/call") {
    entry.tool = data.name;
    entry.args = String(data.arguments ?? "").slice(0, 160);
  }
  if (event.type === "tool/result") {
    entry.tool = "result";
    entry.error = data.error?.code ?? null;
  }
  out.push(entry);
}

const totalMs = events.length > 0 ? events[events.length - 1].time - start : 0;
const slow = out.filter((row) => row.gap >= 5).slice(0, 40);

console.log(JSON.stringify({
  file: found.file,
  firstLines: found.text.split("\n").slice(0, 3).map((l) => l.slice(0, 220)),
  events: out.length,
  minutes: Math.round(totalMs / 60000 * 10) / 10,
  toolCalls: out.filter((r) => r.type === "tool/call").length,
  assistants: out.filter((r) => r.type === "assistant/message").length,
  slowSteps: slow,
  timeline: out,
}, null, 1));


