/**
 * Returns true if the request is authorized.
 * If api_key is empty, auth is disabled and all requests pass.
 */
export function checkApiKey(authHeader: string | undefined, apiKey: string): boolean {
  if (!apiKey) return true;
  return authHeader === `Bearer ${apiKey}`;
}
