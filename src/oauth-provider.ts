import { randomUUID, randomBytes, timingSafeEqual } from "crypto";
import type { Response } from "express";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // dummy compare -- no early-return timing tell
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

interface PendingAuth {
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

/**
 * Minimal single-user OAuth provider for personal MCP server.
 * Approves authorization requests only when the caller presents the
 * configured api_key as a `key` param (2026-07-12 hardening), then issues
 * that same api_key as the access token. Supports dynamic client
 * registration so Claude.ai can register itself on first connect.
 */
export class SingleUserOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private pendingAuths = new Map<string, PendingAuth>();
  private tokenToClientId = new Map<string, string>();

  constructor(private accessToken: string) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: (client) => {
        if (this.clients.size >= 50) {
          throw new Error("Client registration limit reached (50 max)");
        }
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.clients.set(full.client_id, full);
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams & { key?: string },
    res: Response,
  ): Promise<void> {
    // Validate redirect_uri against registered URIs (RFC 6749 §10.6)
    const registered = client.redirect_uris ?? [];
    if (!registered.includes(params.redirectUri)) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }

    // Passphrase gate (2026-07-12 hardening): authorize() previously approved every
    // request unconditionally. Mirrors Halseth's own oauth.ts:257 precedent in this
    // same suite -- the caller must present the configured api_key as `key` before
    // a code is ever issued. Client self-registration stays open (capped at 50
    // clients in registerClient above); it grants nothing without this key.
    if (!params.key || !safeCompare(params.key, this.accessToken)) {
      res.status(401).json({ error: "invalid_key" });
      return;
    }

    // Auto-approve — this is a personal single-user server, gated above.
    const authCode = randomBytes(16).toString("hex");
    this.pendingAuths.set(authCode, {
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", authCode);
    if (params.state) redirectUrl.searchParams.set("state", params.state);
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const pending = this.pendingAuths.get(authorizationCode);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new Error("Invalid or expired authorization code");
    }
    return pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const pending = this.pendingAuths.get(authorizationCode);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new Error("Invalid or expired authorization code");
    }
    this.pendingAuths.delete(authorizationCode);
    this.tokenToClientId.set(this.accessToken, client.client_id);
    return {
      access_token: this.accessToken,
      token_type: "Bearer",
      expires_in: 31536000,
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
  ): Promise<OAuthTokens> {
    throw new Error("Refresh tokens are not supported by this server");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!safeCompare(token, this.accessToken)) {
      throw new Error("Invalid access token");
    }
    return {
      token,
      clientId: this.tokenToClientId.get(token) ?? "single-user",
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60, // 1 year
    };
  }
}
