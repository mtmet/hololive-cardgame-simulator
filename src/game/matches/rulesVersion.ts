import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

/** 分割したルール実装と、今後追加する下層モジュールも互換性判定へ含める。 */
function ruleModules(directory: string): string[] {
  return readdirSync(new URL(directory, import.meta.url), {
    withFileTypes: true,
  })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const file = `${directory}${entry.name}`;
      return entry.isDirectory()
        ? ruleModules(`${file}/`)
        : entry.name.endsWith(".ts")
          ? [file]
          : [];
    });
}

// 保存中の効果処理を別のルール実装で実行しない。UIだけの更新では再開を妨げない。
export const CPU_RULES_SOURCE_FILES = [
  "../actions.ts",
  "../effects.ts",
  "../engine.ts",
  "../types.ts",
  "../view.ts",
  "../ai/cloneState.ts",
  "../../data/loader.ts",
  "../../data/types.ts",
  ...ruleModules("../effects/"),
  ...ruleModules("../engine/"),
];
export const CPU_RULES_VERSION = createHash("sha256")
  .update(
    CPU_RULES_SOURCE_FILES.map((file) =>
      readFileSync(new URL(file, import.meta.url), "utf8").replace(
        /\r\n/g,
        "\n",
      ),
    ).join("\n"),
  )
  .digest("hex");
