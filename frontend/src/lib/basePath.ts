/**
 * Prepend the configured base path to an absolute-from-root URL.
 *
 * Next prepends `basePath` automatically for `<Image>`, `<Link>`, and
 * `metadata.icons`. It does NOT touch runtime `fetch()` calls, so any
 * code that fetches `/data/...` or `/foo.json` directly needs to wrap
 * the path through this helper or it'll 404 on a project-Pages deploy
 * (`devabsnt.github.io/minti/data/...` vs the bare `/data/...`).
 *
 * On the custom domain (`minti.art`) `basePath` is empty and this is a
 * no-op — same code works for both deployment targets.
 *
 * @param path Absolute path starting with `/`
 */
export function withBasePath(path: string): string {
  if (!path.startsWith("/")) return path;
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  if (!base) return path;
  return base + path;
}
