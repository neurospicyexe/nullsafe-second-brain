/**
 * Returns true if the request is authorized.
 * A missing or empty api_key always denies -- there is no "auth disabled" mode.
 */
export function checkApiKey(authHeader: string | undefined, apiKey: string): boolean {
  if (!apiKey) return false;
  return authHeader === `Bearer ${apiKey}`;
}
