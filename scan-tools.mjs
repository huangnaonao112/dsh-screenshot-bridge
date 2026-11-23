// scan-tools.mjs — which sessions called web_search / subagent recently?
// usage: node scan-tools.mjs [hours]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const hours = Number(process.argv[2] ?? 3);
const root = path.join(process.env.USERPROFILE ?? ".", ".dsh", "sessions");
const since = Date.now() - hours * 3600 * 1000;

function readAllFrames(buffer) {
  const offsets = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) offsets.push(i);
  }
  let text = "";
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buffer.length;
    try {
      text += zlib.zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
    } catch {
      // torn tail
    }
  }
  return text;
}

const files = [];
(function walk(dir, depth) {
  if (depth > 3) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1);
    else if (entry.name.endsWith(".zstd")) files.push(full);
  }
})(root, 0);

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readAllFrames(fs.readFileSync(file));
  } catch {
    continue;
  }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) continue;
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    continue;
  }
  let calls = 0;
  let first = null;
  let last = null;
  const names = new Map();
  for (const line of lines) {
    if (!line.includes('"tool/call"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "tool/call" || row.time < since) continue;
    const name = row.data?.name ?? "?";
    if (name !== "web_search" && name !== "web_fetch" && name !== "subagent" && name !== "subagent_fork") continue;
    calls += 1;
    names.set(name, (names.get(name) ?? 0) + 1);
    if (first === null || row.time < first) first = row.time;
    if (last === null || row.time > last) last = row.time;
  }
  if (calls > 0) {
    hits.push({
      id: header.id,
      calls,
      names: Object.fromEntries(names),
      last: new Date(last).toISOString(),
      file,
    });
  }
}

hits.sort((a, b) => (a.last < b.last ? 1 : -1));
console.log(JSON.stringify({ hours, sessions: hits.length, hits }, null, 1));