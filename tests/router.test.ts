import { describe, it, expect } from "vitest";
import { RouteResolver } from "../src/router.js";
import type { RoutingRule } from "../src/types.js";

const rules: RoutingRule[] = [
  { companion: "companion-a", type: "document", destination: "Companions/companion-a/Creative/" },
  { tag: "study", destination: "Areas/Education/" },
  { type: "observation", destination: "00 - INBOX/" },
];

describe("RouteResolver", () => {
  const resolver = new RouteResolver(rules);

  it("matches explicit companion + type rule", () => {
    expect(resolver.resolve({ companion: "companion-a", type: "document", tags: [] }))
      .toBe("Companions/companion-a/Creative/");
  });

  it("matches tag rule", () => {
    expect(resolver.resolve({ companion: null, type: "note", tags: ["study"] }))
      .toBe("Areas/Education/");
  });

  it("matches type-only rule", () => {
    expect(resolver.resolve({ companion: null, type: "observation", tags: [] }))
      .toBe("00 - INBOX/");
  });

  it("falls back to INBOX when no rule matches", () => {
    expect(resolver.resolve({ companion: "unknown", type: "note", tags: [] }))
      .toBe("00 - INBOX/");
  });

  it("explicit path overrides all rules", () => {
    expect(resolver.resolve({ companion: "companion-a", type: "document", tags: [], explicitPath: "Custom/Path/" }))
      .toBe("Custom/Path/");
  });

  it("empty rules list always returns INBOX", () => {
    const empty = new RouteResolver([]);
    expect(empty.resolve({ companion: null, type: "note", tags: [] })).toBe("00 - INBOX/");
  });

  it("companion rule does not match different companion", () => {
    expect(resolver.resolve({ companion: "companion-b", type: "document", tags: [] }))
      .toBe("00 - INBOX/");
  });
});
