// One-shot vault write verification probe. Run on the VPS where second-brain lives.
// Does a real PUT -> GET -> DELETE round-trip through the Obsidian Local REST API tunnel,
// then lists materializer output dirs to confirm scheduled writes are landing.
// Safe + self-cleaning: the probe file is deleted at the end.
const root = "/home/nullsafe/nullsafe-second-brain";
const c = require(root + "/second-brain.config.json");
const base = c.obsidian_rest.url.replace(new RegExp("/+$"), "");
const key = c.obsidian_rest.api_key;
const H = { Authorization: "Bearer " + key };
const SLASH = String.fromCharCode(47);
const enc = (p) => p.split(SLASH).map(encodeURIComponent).join(SLASH);
const vurl = (p) => base + SLASH + "vault" + SLASH + enc(p);

(async () => {
  const ts = new Date().toISOString();
  const probe = "_write-verify" + SLASH + "probe-" + Date.now() + ".md";
  const body = "nullsafe write verification " + ts;

  let r = await fetch(vurl(probe), { method: "PUT", headers: { ...H, "Content-Type": "text/markdown" }, body, signal: AbortSignal.timeout(15000) });
  console.log("PUT  -> " + r.status + " " + r.statusText);

  r = await fetch(vurl(probe), { headers: H, signal: AbortSignal.timeout(15000) });
  const got = await r.text();
  console.log("GET  -> " + r.status + "  content_match=" + (got.trim() === body));

  r = await fetch(vurl(probe), { method: "DELETE", headers: H, signal: AbortSignal.timeout(15000) });
  console.log("DEL  -> " + r.status + " (probe cleaned up)");

  for (const d of [
    "Companions" + SLASH + "cypher" + SLASH + "growth" + SLASH + "journal",
    "Companions" + SLASH + "drevan" + SLASH + "growth" + SLASH + "journal",
    "Companions" + SLASH + "gaia" + SLASH + "growth" + SLASH + "markers",
  ]) {
    try {
      const lr = await fetch(vurl(d) + SLASH, { headers: { ...H, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      const j = await lr.json();
      const files = j.files || [];
      console.log("LIST " + d + " -> " + lr.status + "  files=" + files.length + (files.length ? "  recent: " + files.slice(-2).join(", ") : ""));
    } catch (e) { console.log("LIST " + d + " ERR " + e.message); }
  }
})();
