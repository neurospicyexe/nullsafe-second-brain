import { describe, it, expect, vi } from "vitest";
import { SingleUserOAuthProvider } from "../oauth-provider.js";

function makeClient(redirectUri: string) {
  return {
    client_id: "test-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: [redirectUri],
  } as any;
}

describe("SingleUserOAuthProvider.authorize", () => {
  it("rejects when no key is provided", async () => {
    const provider = new SingleUserOAuthProvider("the-real-key");
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), redirect: vi.fn() } as any;
    await provider.authorize(
      makeClient("https://example.com/cb"),
      { redirectUri: "https://example.com/cb", codeChallenge: "cc" } as any,
      res,
    );
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects when the wrong key is provided", async () => {
    const provider = new SingleUserOAuthProvider("the-real-key");
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), redirect: vi.fn() } as any;
    await provider.authorize(
      makeClient("https://example.com/cb"),
      { redirectUri: "https://example.com/cb", codeChallenge: "cc", key: "wrong-key" } as any,
      res,
    );
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("approves and redirects when the correct key is provided", async () => {
    const provider = new SingleUserOAuthProvider("the-real-key");
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), redirect: vi.fn() } as any;
    await provider.authorize(
      makeClient("https://example.com/cb"),
      { redirectUri: "https://example.com/cb", codeChallenge: "cc", key: "the-real-key" } as any,
      res,
    );
    expect(res.redirect).toHaveBeenCalledTimes(1);
    const redirectedTo = new URL(res.redirect.mock.calls[0][0]);
    expect(redirectedTo.searchParams.get("code")).toBeTruthy();
  });
});

describe("SingleUserOAuthProvider.verifyAccessToken", () => {
  it("accepts the correct token", async () => {
    const provider = new SingleUserOAuthProvider("the-real-key");
    const info = await provider.verifyAccessToken("the-real-key");
    expect(info.token).toBe("the-real-key");
  });

  it("rejects an incorrect token", async () => {
    const provider = new SingleUserOAuthProvider("the-real-key");
    await expect(provider.verifyAccessToken("wrong")).rejects.toThrow("Invalid access token");
  });
});
