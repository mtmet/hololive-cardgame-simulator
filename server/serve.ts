// ============================================================
// 一体型サーバー: ビルド済みアプリ (dist/) の配信 + オンライン対戦リレー
//
//   npm run build
//   npm run serve            (ポート変更: PORT=9000 npm run serve)
//
// http://localhost:8787/?room=部屋コード で対戦・観戦に参加する。
// ============================================================
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay } from "./relayCore";
import { cacheControlForExtension } from "./staticCache";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist");
const port = Number(process.env.PORT ?? 8787);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    const target = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const filePath = normalize(join(root, target));
    // 前方一致だけだと dist と同じ接頭辞のディレクトリ (dist-old 等) を配信しうる。
    // 区切り文字まで含めて dist の中にあることを確かめる
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const ext = extname(filePath).toLowerCase();
    try {
      const body = await readFile(
        ext === "" ? join(root, "index.html") : filePath,
      );
      res.writeHead(200, {
        "content-type":
          ext === ""
            ? MIME[".html"]
            : (MIME[ext] ?? "application/octet-stream"),
        "cache-control": cacheControlForExtension(ext),
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  } catch {
    res.writeHead(500);
    res.end();
  }
});

const relay = createRelay((line) => console.log(`[relay] ${line}`));
relay.attach(server);

server.listen(port, () => {
  console.log(`hololive-cardgame server: http://localhost:${port}`);
  console.log(`  配信: ${root}`);
});
