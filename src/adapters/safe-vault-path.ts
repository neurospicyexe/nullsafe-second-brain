/**
 * Rejects any vault-relative path that could escape the vault root: `..` segments,
 * absolute paths (leading slash or drive letter), or null bytes. Mirrors the
 * resolve+relative check FilesystemAdapter.safePath already does against a real
 * filesystem root -- this is the pure string-level version shared by adapters
 * that don't resolve against a local directory (ObsidianRestAdapter, CouchDBAdapter),
 * so a `..`-laden destination (e.g. from LLM-chosen inbox-filer output) can't reach
 * their PUT/DELETE calls or CouchDB doc ids unchecked.
 */
export function assertVaultRelativePath(path: string): string {
  if (path.includes("\0")) {
    throw new Error(`Path resolves outside vault root: contains a null byte`);
  }
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) {
    throw new Error(`Path resolves outside vault root: absolute path "${path}"`);
  }
  const segments = path.split(/[\\/]/);
  if (segments.some(s => s === "..")) {
    throw new Error(`Path resolves outside vault root: "${path}"`);
  }
  return path;
}
