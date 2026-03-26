# Security Audit Report — Hearth

**Audit Date:** 2026-03-13
**Audit Scope:** Authentication (Auth API, Middleware), Companion Routes, Mutation Routes, Project Configuration.

## Executive Summary

The project has made significant strides in security (e.g., input stripping on several routes, CSRF/Clickjacking protections via headers). However, a **CRITICAL** vulnerability exists in the session management where the master secret is stored in plaintext in the user's cookie. Several **MEDIUM** risks related to timing attacks and inconsistent input validation were also identified.

---

## 1. Authentication & Session Management

### [CRITICAL] Plaintext Secret in Session Cookie
- **Location:** `app/api/auth/route.ts:22`, `middleware.ts:9-10`
- **Issue:** The `hearth_session` cookie directly stores the `DASHBOARD_SECRET`.
- **Impact:** If an attacker steals this cookie (via XSS, network interception, or local access), they gain the master passphrase. There is no session rotation or revocation mechanism.
- **Recommendation:** Replace the literal secret with a randomly generated session token or a signed JWT that contains non-sensitive session identifiers.

### [MEDIUM] Timing Attack Vulnerability
- **Location:** `app/api/auth/route.ts:16`, `app/api/companion/house/route.ts:15`
- **Issue:** Secrets are compared using standard equality operators (`!==`, `===`).
- **Impact:** An attacker can measure the time it takes for the response to return to infer the secret character-by-character.
- **Recommendation:** Use a constant-time comparison helper like `crypto.timingSafeEqual`.

---

## 2. API Security & Input Validation

### [MEDIUM] Missing Input Validation on `biometrics` Route
- **Location:** `app/api/biometrics/route.ts:35`
- **Issue:** Unlike other routes (notes, house, deltas), the `POST` route for biometrics forwards the entire request body to the Halseth backend without stripping unknown fields.
- **Impact:** Potential for Mass Assignment or unexpected behavior if the backend relies on internal fields that shouldn't be client-controlled.
- **Recommendation:** Implement a strict allowlist for the `biometrics` POST body, similar to the `notes` and `house` routes.

### [MEDIUM] Lack of Rate Limiting
- **Location:** All API mutation endpoints.
- **Issue:** There is no rate limiting on authentication attempts or state updates.
- **Impact:** Vulnerable to brute-force passphrase guessing and denial-of-service/spamming on mutation routes.
- **Recommendation:** Implement rate limiting using a service like Upstash (as noted in `CLAUDE.md`) or a local middleware-based counter.

---

## 3. Middleware & Access Control

### [LOW] Broad Auth Exceptions
- **Location:** `middleware.ts:21`
- **Issue:** The `api/companion/.*` routes are excluded from the main dashboard auth middleware.
- **Impact:** While these routes have their own Bearer token check, centralized auth is easier to audit and harder to bypass accidentally.
- **Recommendation:** Consider moving the companion Bearer auth into a centralized middleware check if possible, or ensure all excluded routes have rigorous manual checks.

---

## 4. Findings from Verification of Claims

The audit verified the following claims in `CLAUDE.md`:
- [x] **Limit Clamping**: Verified in `app/api/deltas/route.ts`.
- [x] **Input Allowlists**: Verified for `notes` and `house`, but found to be **missing** for `biometrics`.
- [x] **Generic Errors**: Verified; raw upstream errors are generally masked.
- [x] **Security Headers**: Verified via `next.config.ts`.

---

## 5. Summary of Recommendations

1.  **Migrate Session Management**: Stop storing the raw `DASHBOARD_SECRET` in cookies immediately.
2.  **Fix Timing Sensitivity**: Update all secret comparison logic to be constant-time.
3.  **Harden Biometrics Route**: Add input validation to `app/api/biometrics/route.ts`.
4.  **Implement Rate Limiting**: Focus first on the `/api/auth` endpoint.
5.  **Remove Secrets from Docs**: Ensure `CLAUDE.md` and other documentation do not contain any real secrets or highly sensitive architecture details if the repository is not private.
