import { describe, it, expect } from "vitest";
import { checkApiKey } from "../http-auth.js";

describe("checkApiKey", () => {
  it("returns true when Authorization header matches", () => {
    expect(checkApiKey("Bearer mysecret", "mysecret")).toBe(true);
  });

  it("returns false when header is wrong", () => {
    expect(checkApiKey("Bearer wrong", "mysecret")).toBe(false);
  });

  it("returns false when header is missing", () => {
    expect(checkApiKey(undefined, "mysecret")).toBe(false);
  });

  it("returns false when header has no Bearer prefix", () => {
    expect(checkApiKey("mysecret", "mysecret")).toBe(false);
  });

  it("returns true when api_key is empty string (auth disabled)", () => {
    expect(checkApiKey(undefined, "")).toBe(true);
    expect(checkApiKey("anything", "")).toBe(true);
  });
});
