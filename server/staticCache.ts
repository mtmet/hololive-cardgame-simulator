// ビルド更新後に新しいJSと古いカードJSONが混在しないための配信ポリシー。
export function cacheControlForExtension(ext: string): string {
  if (ext === ".json") return "no-cache";
  if (ext === "" || ext === ".html") return "no-cache";
  return "public, max-age=3600";
}
