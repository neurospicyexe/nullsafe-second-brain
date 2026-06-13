import { describe, it, expect } from "vitest";
import {
  sanitizeFilename, topLevelFolders, applyProperties, renderPlanLine, parsePlan,
  parseDecision, buildClassifyPrompt, runInboxFiler, INBOX_FOLDER, PLAN_FILE, LOG_FILE,
  type FilingDecision,
} from "./inbox-filer.js";
import type { VaultAdapter } from "../adapters/vault-adapter.js";

// ── in-memory vault ──────────────────────────────────────────────────────────
class FakeVault implements VaultAdapter {
  files = new Map<string, string>();
  moves: Array<[string, string]> = [];
  constructor(seed: Record<string, string> = {}) { for (const [k, v] of Object.entries(seed)) this.files.set(k, v); }
  async write(o: { path: string; content: string; overwrite?: boolean }) { this.files.set(o.path, o.content); }
  async read(path: string) { const c = this.files.get(path); if (c === undefined) throw new Error(`not found: ${path}`); return c; }
  async list(dir = "") {
    const prefix = dir.replace(/\/+$/, "");
    const out = new Set<string>();
    for (const p of this.files.keys()) {
      if (prefix === "") { out.add(p); continue; }
      if (p.startsWith(prefix + "/")) out.add(p);
    }
    return [...out];
  }
  async move(from: string, to: string) {
    const c = this.files.get(from);
    if (c === undefined) throw new Error(`move src missing: ${from}`);
    this.files.delete(from); this.files.set(to, c); this.moves.push([from, to]);
  }
  async exists(path: string) { return this.files.has(path); }
  async delete(path: string) { this.files.delete(path); }
}

// ── pure helpers ──────────────────────────────────────────────────────────────
describe("sanitizeFilename", () => {
  it("strips illegal chars and ensures .md", () => {
    expect(sanitizeFilename('My: Note/With*bad?"chars')).toBe("My Note With bad chars.md");
  });
  it("keeps an existing .md without doubling", () => {
    expect(sanitizeFilename("Chapter 01.md")).toBe("Chapter 01.md");
  });
  it("falls back to Untitled on empty", () => {
    expect(sanitizeFilename("   ")).toBe("Untitled.md");
  });
});

describe("topLevelFolders", () => {
  it("derives folders, excluding root files, dotfiles, and _control", () => {
    const entries = [
      "Books/The-Overstory/ch1.md", "companions/cypher/note.md", "Praxis/x.md",
      "README.md", ".obsidian/app.json", "_templates/t.md", "00 - INBOX/a.md",
    ];
    expect(topLevelFolders(entries)).toEqual(["00 - INBOX", "Books", "Praxis", "companions"]);
  });
});

describe("applyProperties", () => {
  it("prepends frontmatter when none exists", () => {
    const out = applyProperties("# Hello\nbody", { type: "note", tags: ["a", "b"] });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("type: note");
    expect(out).toContain("  - a");
  });
  it("merges only missing keys into existing frontmatter", () => {
    const out = applyProperties("---\ntype: book\n---\nbody", { type: "note", created: "2026-06-13" });
    expect(out).toContain("type: book");   // existing preserved
    expect(out).toContain("created: 2026-06-13");
    expect(out.match(/type:/g)).toHaveLength(1); // not duplicated
  });
});

describe("plan round-trip", () => {
  it("renders and re-parses a checkbox line", () => {
    const line = renderPlanLine("00 - INBOX/a.md", "Books/X/a.md", 0.62, "a book chapter");
    const parsed = parsePlan(line);
    expect(parsed[0]).toEqual({ from: "00 - INBOX/a.md", to: "Books/X/a.md", checked: false });
  });
  it("detects a checked (approved) item", () => {
    const parsed = parsePlan("- [x] `00 - INBOX/a.md` → `Books/X/a.md`  (0.62) — x");
    expect(parsed[0].checked).toBe(true);
  });
});

describe("parseDecision", () => {
  it("parses valid JSON and clamps confidence", () => {
    const d = parseDecision('{"destination_folder":"Books/X","filename":"Ch 1.md","confidence":1.5,"reason":"r"}');
    expect(d?.destination_folder).toBe("Books/X");
    expect(d?.confidence).toBe(1);
  });
  it("returns null on missing destination", () => {
    expect(parseDecision('{"filename":"x.md","confidence":0.9}')).toBeNull();
  });
  it("returns null on garbage", () => {
    expect(parseDecision("not json")).toBeNull();
  });
});

describe("buildClassifyPrompt", () => {
  it("includes the real taxonomy and the excerpt", () => {
    const p = buildClassifyPrompt({ path: "00 - INBOX/x.md", title: "X", excerpt: "hello", folders: ["Books", "Praxis"] });
    expect(p).toContain("Books, Praxis");
    expect(p).toContain("hello");
  });
});

// ── runner ────────────────────────────────────────────────────────────────────
const classifierFor = (map: Record<string, FilingDecision>) =>
  async (n: { title: string }) => map[n.title] ?? null;

describe("runInboxFiler hybrid", () => {
  it("auto-files a confident note and queues an uncertain one", async () => {
    const vault = new FakeVault({
      "Books/.keep": "", "companions/.keep": "",
      "00 - INBOX/Overstory Notes.md": "trees and time",
      "00 - INBOX/Random Scrap.md": "??? unclear",
    });
    const classify = classifierFor({
      "Overstory Notes": { destination_folder: "Books/The Overstory", filename: "Overstory Notes.md", confidence: 0.92, reason: "book notes" },
      "Random Scrap": { destination_folder: "Praxis", filename: "Random Scrap.md", confidence: 0.4, reason: "unsure" },
    });
    const moved: string[] = [];
    const stats = await runInboxFiler(
      { vault, classify, onMoved: (f) => { moved.push(f); } },
      { mode: "hybrid", dryRun: false, confidenceThreshold: 0.75 },
    );
    expect(stats.filed).toBe(1);
    expect(stats.queued).toBe(1);
    expect(vault.files.has("Books/The Overstory/Overstory Notes.md")).toBe(true); // confident moved
    expect(vault.files.has("00 - INBOX/Random Scrap.md")).toBe(true);             // uncertain stayed
    expect(moved).toContain("00 - INBOX/Overstory Notes.md");
    const plan = vault.files.get(PLAN_FILE)!;
    expect(plan).toContain("Random Scrap.md");                                    // queued in plan
  });

  it("dry run moves nothing", async () => {
    const vault = new FakeVault({ "Books/.keep": "", "00 - INBOX/A.md": "x" });
    const classify = classifierFor({ "A": { destination_folder: "Books", filename: "A.md", confidence: 0.99, reason: "r" } });
    const stats = await runInboxFiler({ vault, classify }, { mode: "hybrid", dryRun: true, confidenceThreshold: 0.75 });
    expect(stats.filed).toBe(1);            // would file
    expect(vault.moves).toHaveLength(0);    // but nothing actually moved
    expect(vault.files.has("00 - INBOX/A.md")).toBe(true);
  });

  it("applies a human-checked plan item, then re-queues uncertain new ones", async () => {
    const vault = new FakeVault({
      "Books/.keep": "",
      [PLAN_FILE]: "# Filing plan\n\n- [x] `00 - INBOX/Approved.md` → `Books/Approved.md`  (0.6) — approved\n- [ ] `00 - INBOX/Wait.md` → `Books/Wait.md`  (0.5) — later\n",
      "00 - INBOX/Approved.md": "content",
      "00 - INBOX/Wait.md": "content",
    });
    const stats = await runInboxFiler(
      { vault, classify: async () => null }, // no new INBOX classification needed
      { mode: "hybrid", dryRun: false, confidenceThreshold: 0.75 },
    );
    expect(stats.approved).toBe(1);
    expect(vault.files.has("Books/Approved.md")).toBe(true);          // checked item moved
    expect(vault.files.has("00 - INBOX/Approved.md")).toBe(false);
    expect(vault.files.get(PLAN_FILE)).toContain("Wait.md");          // unchecked carried over
  });

  it("never files its own control files", async () => {
    const vault = new FakeVault({
      "Books/.keep": "",
      [PLAN_FILE]: "# Filing plan\n", [LOG_FILE]: "# Filing log\n",
      "00 - INBOX/Real.md": "x",
    });
    let classifiedTitles: string[] = [];
    await runInboxFiler(
      { vault, classify: async (n) => { classifiedTitles.push(n.title); return null; } },
      { mode: "suggest", dryRun: false, confidenceThreshold: 0.75 },
    );
    expect(classifiedTitles).toEqual(["Real"]); // _filing-plan / _filing-log skipped
  });

  it("clobber-safe: suffixes a colliding destination instead of overwriting", async () => {
    const vault = new FakeVault({
      "Books/Dupe.md": "ORIGINAL",
      "00 - INBOX/Dupe.md": "NEW",
    });
    const classify = classifierFor({ "Dupe": { destination_folder: "Books", filename: "Dupe.md", confidence: 0.99, reason: "r" } });
    await runInboxFiler({ vault, classify }, { mode: "auto", dryRun: false, confidenceThreshold: 0.75 });
    expect(vault.files.get("Books/Dupe.md")).toBe("ORIGINAL"); // original untouched
    expect(vault.files.get("Books/Dupe 2.md")).toBe("NEW");    // new one suffixed
  });
});
