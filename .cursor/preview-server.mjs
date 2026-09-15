// Live-reload Markdown preview server for the Research IDE documentation repo.
// Renders GitHub-flavored Markdown (tables, code with syntax highlighting) and
// Mermaid diagrams, and reloads connected browsers when a tracked .md changes.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import hljs from "highlight.js";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// Mermaid's ESM build lazily imports sibling chunks, so the whole dist/
// directory is served under /assets/mermaid/ for those relative imports.
const MERMAID_DIST_DIR = path.join(path.dirname(require.resolve("mermaid/package.json")), "dist");
const HLJS_CSS = require.resolve("highlight.js/styles/github.css");

const CONTENT_TYPES = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(code, lang) {
    if (lang && lang.toLowerCase() === "mermaid") {
      // Rendered client-side by Mermaid; return a sentinel handled below.
      return null;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch {
        /* fall through to default escaping */
      }
    }
    return "";
  },
}).use(anchor, { permalink: anchor.permalink.headerLink() });

// Custom fence rendering so ```mermaid blocks become <div class="mermaid">.
const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = (token.info ?? "").trim().toLowerCase();
  if (info === "mermaid") {
    return `<div class="mermaid">${md.utils.escapeHtml(token.content)}</div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

function listDocs() {
  return fs
    .readdirSync(REPO_ROOT)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .sort();
}

const LIVE_RELOAD = `
<script>
  (function () {
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var ws = new WebSocket(proto + "://" + location.host + "/__livereload");
    ws.onmessage = function () { location.reload(); };
    ws.onclose = function () { setTimeout(function () { location.reload(); }, 1000); };
  })();
</script>`;

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${md.utils.escapeHtml(title)}</title>
<link rel="stylesheet" href="/assets/highlight.css" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.6; }
  .layout { display: flex; min-height: 100vh; }
  nav { width: 300px; flex: 0 0 300px; border-right: 1px solid #d0d7de; padding: 20px; box-sizing: border-box; background: #f6f8fa; }
  nav h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #57606a; }
  nav a { display: block; padding: 6px 8px; border-radius: 6px; color: #0969da; text-decoration: none; font-size: 14px; word-break: break-word; }
  nav a:hover { background: #eaeef2; }
  main { flex: 1; padding: 32px 48px; max-width: 900px; }
  main img { max-width: 100%; }
  main table { border-collapse: collapse; }
  main table th, main table td { border: 1px solid #d0d7de; padding: 6px 13px; }
  main pre { background: #f6f8fa; padding: 16px; overflow: auto; border-radius: 6px; }
  main code { background: rgba(175,184,193,.2); padding: .2em .4em; border-radius: 6px; }
  main pre code { background: none; padding: 0; }
  .mermaid { background: #fff; padding: 12px; border-radius: 6px; overflow: auto; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #c9d1d9; }
    nav { background: #161b22; border-color: #30363d; }
    main pre { background: #161b22; }
    main table th, main table td { border-color: #30363d; }
  }
</style>
</head>
<body>
<div class="layout">
${bodyHtml}
</div>
<script type="module">
  import mermaid from "/assets/mermaid/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: true, theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
  await mermaid.run({ querySelector: ".mermaid" });
</script>
${LIVE_RELOAD}
</body>
</html>`;
}

function navHtml(activeName) {
  const links = listDocs()
    .map((name) => {
      const active = name === activeName ? ' style="font-weight:600;background:#eaeef2;"' : "";
      return `<a href="/doc/${encodeURIComponent(name)}"${active}>${md.utils.escapeHtml(name)}</a>`;
    })
    .join("\n");
  return `<nav><h2>Documents</h2>${links}</nav>`;
}

function send(res, status, contentType, body) {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" ) {
    const docs = listDocs();
    if (docs.length === 0) {
      return send(res, 200, "text/html; charset=utf-8", page("Docs", `${navHtml()}<main><h1>No Markdown documents found</h1></main>`));
    }
    res.writeHead(302, { Location: `/doc/${encodeURIComponent(docs[0])}` });
    return res.end();
  }

  if (pathname.startsWith("/assets/mermaid/")) {
    const rel = pathname.slice("/assets/mermaid/".length);
    const filePath = path.join(MERMAID_DIST_DIR, rel);
    if (!filePath.startsWith(MERMAID_DIST_DIR) || !fs.existsSync(filePath)) {
      return send(res, 404, "text/plain; charset=utf-8", "Not found");
    }
    const type = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
    return send(res, 200, type, fs.readFileSync(filePath));
  }
  if (pathname === "/assets/highlight.css") {
    return send(res, 200, "text/css; charset=utf-8", fs.readFileSync(HLJS_CSS));
  }

  if (pathname.startsWith("/doc/")) {
    const name = pathname.slice("/doc/".length);
    const filePath = path.join(REPO_ROOT, name);
    if (!filePath.startsWith(REPO_ROOT) || !name.toLowerCase().endsWith(".md") || !fs.existsSync(filePath)) {
      return send(res, 404, "text/html; charset=utf-8", page("Not found", `${navHtml()}<main><h1>404</h1><p>${md.utils.escapeHtml(name)} not found.</p></main>`));
    }
    const markdown = fs.readFileSync(filePath, "utf8");
    const rendered = md.render(markdown);
    return send(res, 200, "text/html; charset=utf-8", page(name, `${navHtml(name)}<main>${rendered}</main>`));
  }

  send(res, 404, "text/plain; charset=utf-8", "Not found");
});

const wss = new WebSocketServer({ server, path: "/__livereload" });
function broadcastReload() {
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send("reload");
  }
}

const watcher = chokidar.watch(path.join(REPO_ROOT, "*.md"), { ignoreInitial: true });
watcher.on("all", (event, file) => {
  console.log(`[preview] ${event}: ${path.relative(REPO_ROOT, file)} -> reloading clients`);
  broadcastReload();
});

server.listen(PORT, HOST, () => {
  console.log(`[preview] Serving docs from ${REPO_ROOT}`);
  console.log(`[preview] Listening on http://${HOST}:${PORT}`);
  for (const doc of listDocs()) console.log(`[preview]   /doc/${encodeURIComponent(doc)}`);
});
