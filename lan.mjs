// lan.mjs — LAN answer page for the screenshot bridge.
//
// The Host already owns the captures, the OCR text and (through `sessions`) the
// model's replies. This module puts a small authenticated HTTP server on the LAN
// so a phone or tablet can watch the newest capture, its recognised text and the
// answer, and fire a capture without touching the PC.
//
// Endpoints (token required, `?k=TOKEN` or `x-dsh-token` header):
//   GET  /             mobile page
//   GET  /api/state    { seq, session, items: [...] }
//   GET  /img?id=      image bytes of one capture
//   POST /api/shoot    ask the daemon for a fresh capture
//
// No dependencies beyond node:http. Bound to 0.0.0.0 by the Host, so treat the
// token as the only gate: anyone on the LAN with the URL can read the page.

import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>截图桥 · 局域网</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --bg:#f5f6f7; --card:#fff; --line:#e3e5e8; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --dim:#9aa0a6; --bg:#141516; --card:#1d1f21; --line:#2b2e31; --accent:#4f8cff; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:12px; font:15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
  header h1 { font-size:16px; margin:0; flex:1; }
  .pill { font-size:12px; color:var(--dim); border:1px solid var(--line); border-radius:999px; padding:2px 8px; }
  button { font:inherit; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px; margin-bottom:10px; }
  .meta { font-size:12px; color:var(--dim); display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
  img.shot { width:100%; border-radius:8px; display:block; background:#000; cursor:zoom-in; }
  img.shot.zoom { cursor:zoom-out; }
  .label { font-size:12px; color:var(--dim); margin:8px 0 4px; }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; font:13px/1.5 ui-monospace, "Cascadia Mono", monospace; background:transparent; }
  .answer { border-left:3px solid var(--accent); padding-left:8px; }
  .empty { color:var(--dim); text-align:center; padding:24px 0; }
  .old { display:flex; gap:8px; align-items:center; padding:6px 0; border-top:1px solid var(--line); font-size:13px; }
  .old img { width:56px; height:36px; object-fit:cover; border-radius:4px; }
  .old:first-child { border-top:none; }
  a { color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>截图桥</h1>
  <span class="pill" id="status">连接中</span>
  <button class="primary" id="shoot">拍一张</button>
</header>
<div id="app"><div class="empty">还没有截图</div></div>
<script>
  var TOKEN = new URLSearchParams(location.search).get("k") || "";
  function api(path, options) {
    var url = path + (path.indexOf("?") >= 0 ? "&" : "?") + "k=" + encodeURIComponent(TOKEN);
    return fetch(url, options);
  }
  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  }
  function fmt(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  }
  function card(item, newest) {
    var html = '<div class="card">';
    html += '<div class="meta"><span>' + fmt(item.at) + '</span>';
    if (item.backend) html += '<span>' + esc(item.backend) + '</span>';
    if (item.target) html += '<span>' + esc(item.target) + '</span>';
    if (item.width) html += '<span>' + item.width + '×' + item.height + '</span>';
    html += '</div>';
    html += '<img class="shot" loading="lazy" src="/img?id=' + encodeURIComponent(item.id) +
            '&k=' + encodeURIComponent(TOKEN) + '" onclick="this.classList.toggle(\\'zoom\\')">';
    if (item.text) html += '<div class="label">识别文字</div><pre>' + esc(item.text) + '</pre>';
    if (item.answer) {
      html += '<div class="label">回答' + (item.answerAt ? ' · ' + fmt(item.answerAt) : '') + '</div>';
      html += '<pre class="answer">' + esc(item.answer) + '</pre>';
    } else if (newest) {
      html += '<div class="label">回答</div><div class="empty" style="padding:8px 0">等待模型回复…</div>';
    }
    html += '</div>';
    return html;
  }
  var lastPayload = "";
  var lastTickAt = 0;

  function status(text) {
    document.getElementById("status").textContent = text;
  }

  function clock() {
    var d = new Date();
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  }

  async function tick() {
    // A hidden tab is throttled to ~1/minute by every mobile browser; skip the
    // fetch and refresh immediately when the page becomes visible again.
    if (document.visibilityState === "hidden") return;
    try {
      var response = await api("/api/state");
      if (!response.ok) throw new Error("HTTP " + response.status);
      var data = await response.json();
      lastTickAt = Date.now();
      var payload = JSON.stringify(data);
      if (payload === lastPayload) {
        status((data.session ? "会话在线" : "会话未打开") + " · " + clock());
        return;
      }
      lastPayload = payload;
      var app = document.getElementById("app");
      if (!data.items || data.items.length === 0) {
        app.innerHTML = '<div class="empty">还没有截图</div>';
        status((data.session ? "会话在线" : "会话未打开") + " · " + clock());
        return;
      }
      var items = data.items.slice().reverse();
      var html = card(items[0], true);
      if (items.length > 1) {
        html += '<div class="card"><div class="label">历史</div>';
        for (var i = 1; i < items.length; i += 1) {
          var it = items[i];
          html += '<div class="old"><img src="/img?id=' + encodeURIComponent(it.id) +
                  '&k=' + encodeURIComponent(TOKEN) + '"><span>' + fmt(it.at) + ' · ' +
                  (it.answer ? "有回答" : "无回答") + '</span></div>';
        }
        html += '</div>';
      }
      var scrolled = window.scrollY > 40;
      var previous = window.scrollY;
      app.innerHTML = html;
      if (scrolled) window.scrollTo(0, previous);
      status((data.session ? "会话在线" : "会话未打开") + " · " + clock());
    } catch (error) {
      status("离线");
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") void tick();
  });
  window.addEventListener("online", function () { void tick(); });

  document.getElementById("shoot").addEventListener("click", async function () {
    var button = this;
    button.disabled = true;
    button.textContent = "拍摄中…";
    try {
      var response = await api("/api/shoot", { method: "POST" });
      var data = await response.json();
      button.textContent = data.ok ? "已拍" : "失败";
    } catch (error) {
      button.textContent = "失败";
    }
    setTimeout(function () { button.disabled = false; button.textContent = "拍一张"; }, 1200);
    setTimeout(tick, 400);
  });
  tick();
  setInterval(tick, 1200);
  setInterval(function () { if (document.visibilityState === "visible" && Date.now() - lastTickAt > 4000) void tick(); }, 4000);
</script>
</body>
</html>`;

/**
 * @param {{
 *   token: string,
 *   snapshot: () => { seq: number, session: string | null, items: object[] },
 *   image: (id: string) => Promise<{ bytes: Buffer, mime: string } | null>,
 *   shoot: () => Promise<boolean>,
 *   log?: (kind: string, detail: object) => void,
 * }} options
 */
// The page lives in lan-page.html so it can be fixed without restarting DSH:
// every request re-checks the file's mtime and serves the fresh copy.
const HERE = path.dirname(fileURLToPath(import.meta.url));
let pageCache = { mtime: 0, text: "" };

function readPage() {
  try {
    const file = path.join(HERE, "lan-page.html");
    const stats = statSync(file);
    if (stats.mtimeMs !== pageCache.mtime) {
      pageCache = { mtime: stats.mtimeMs, text: readFileSync(file, "utf8") };
    }
    return pageCache.text;
  } catch {
    return PAGE;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8192) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function createLanServer(options) {
  const { token, snapshot, image, shoot, resend, log } = options;

  function authorized(request) {
    if (!token) return false;
    const url = new URL(request.url ?? "/", "http://lan");
    const fromQuery = url.searchParams.get("k");
    const fromHeader = request.headers["x-dsh-token"];
    return fromQuery === token || fromHeader === token;
  }

  function reply(response, status, body, type) {
    response.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.end(body);
  }

  return http.createServer(async (request, response) => {
    try {
      if (!authorized(request)) {
        reply(response, 401, "unauthorized", "text/plain; charset=utf-8");
        return;
      }
      const url = new URL(request.url ?? "/", "http://lan");
      const route = url.pathname;

      if (request.method === "GET" && (route === "/" || route === "/index.html")) {
        reply(response, 200, readPage(), "text/html; charset=utf-8");
        return;
      }

      if (request.method === "GET" && route === "/api/state") {
        const data = snapshot();
        reply(response, 200, JSON.stringify(data), "application/json; charset=utf-8");
        return;
      }

      if (request.method === "GET" && route === "/img") {
        const id = url.searchParams.get("id") ?? "";
        const found = await image(id);
        if (found === null) {
          reply(response, 404, "missing", "text/plain; charset=utf-8");
          return;
        }
        response.writeHead(200, {
          "Content-Type": found.mime,
          "Content-Length": String(found.bytes.byteLength),
          "Cache-Control": "private, max-age=120",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(found.bytes);
        return;
      }

      if (request.method === "POST" && route === "/api/resend") {
        let id = "";
        try {
          const body = JSON.parse(await readBody(request));
          id = typeof body.id === "string" ? body.id : "";
        } catch {
          id = "";
        }
        const ok = id !== "" && typeof resend === "function" ? await resend(id) : false;
        reply(response, 200, JSON.stringify({ ok }), "application/json; charset=utf-8");
        return;
      }

      if (request.method === "POST" && route === "/api/shoot") {
        const ok = await shoot();
        reply(response, 200, JSON.stringify({ ok }), "application/json; charset=utf-8");
        return;
      }

      reply(response, 404, "not found", "text/plain; charset=utf-8");
    } catch (error) {
      if (typeof log === "function") log("lan-error", { message: String(error).slice(0, 300) });
      reply(response, 500, "error", "text/plain; charset=utf-8");
    }
  });
}

