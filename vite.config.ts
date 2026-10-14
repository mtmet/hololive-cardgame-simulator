import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createRelay, type RelayOptions } from "./server/relayCore";
import { CPU_RULES_VERSION } from "./src/game/matches/rulesVersion";

export function onlineRelayPlugin(options: RelayOptions = {}): Plugin {
  return {
    name: "hocg-online-relay",
    configureServer(server) {
      if (!server.httpServer) return;
      const relay = createRelay(undefined, options);
      relay.attach(server.httpServer);
      server.httpServer.on("close", () => relay.close());
    },
  };
}

// data/ 配下のカード画像を静的ファイルとして配信する
// (例: /card_images/hBP01-001.png)
export default defineConfig({
  define: { __CPU_RULES_VERSION__: JSON.stringify(CPU_RULES_VERSION) },
  plugins: [
    react(),
    // ローカルの開発サーバーにも対戦リレーを同居させる。
    onlineRelayPlugin(),
  ],
  // カードデータはバンドルへ焼き込まず、publicDirの静的JSONをfetchする
  // (Node/tsx 用の cardSource.ts はJSONを直接importする)
  resolve: {
    alias: [
      {
        find: /^\.\/sampleSource$/,
        replacement: fileURLToPath(
          new URL("./src/game/decks/sampleSource.browser.ts", import.meta.url),
        ),
      },
      {
        find: /^\.\/rulesVersion$/,
        replacement: fileURLToPath(
          new URL(
            "./src/game/matches/rulesVersion.browser.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^\.\/cardSource$/,
        replacement: fileURLToPath(
          new URL("./src/data/cardSource.browser.ts", import.meta.url),
        ),
      },
    ],
  },
  publicDir: "data",
  build: {
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
  },
});
