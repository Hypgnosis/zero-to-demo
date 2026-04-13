/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Policy Enforcement Point (PEP)
 *
 * Phase 1: Zero-Trust Identity Gate.
 * Every API route MUST call authenticateRequest() before processing.
 *
 * Supports:
 * - JWKS-based RS256/ES256 verification (Clerk, Auth0, Firebase)
 * - Development bypass (explicit opt-in, BLOCKED in production)
 *
 * Principle: "Every request is malicious until a signed JWT proves otherwise."
 * ═══════════════════════════════════════════════════════════════════
 */

import { jwtVerify, createRemoteJWKSet } from 'jose';
import { ApiError, Errors } from './errors';

/* ─── Types ───────────────────────────────────────────────────── */

export interface AxiomClaims {
  /** Immutable user identifier from the Identity Provider (JWT `sub` claim). */
  userId: string;
  /** User email, if present in the JWT. */
  email?: string;
  /** Tenant identifier for multi-tenant expansion. */
  tenantId?: string;
}

/* ─── JWKS Cache ──────────────────────────────────────────────── */

/**
 * Cached JWKS fetcher. jose's createRemoteJWKSet handles internal caching
 * and rotation, so we only instantiate once per process lifetime.
 */
let jwksSet: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksSet) {
    const jwksUrl = process.env.AUTH_JWKS_URL;
    if (!jwksUrl) {
      throw Errors.configMissing('AUTH_JWKS_URL');
    }
    jwksSet = createRemoteJWKSet(new URL(jwksUrl));
  }
  return jwksSet;
}

/* ─── PEP Middleware ──────────────────────────────────────────── */

/**
 * Authenticates an incoming request by verifying its Bearer JWT.
 *
 * Flow:
 * 1. Check for dev bypass (BLOCKED in production).
 * 2. Extract Bearer token from Authorization header.
 * 3. Verify JWT signature against JWKS endpoint.
 * 4. Validate required claims (sub).
 * 5. Return verified AxiomClaims.
 *
 * @throws ApiError(401) if the token is missing, invalid, or expired.
 * @throws ApiError(500) if AUTH_JWKS_URL is not configured (and no bypass).
 * @returns Verified claims extracted from the JWT payload.
 */
export async function authenticateRequest(req: Request): Promise<AxiomClaims> {
  // ── Dev Bypass (STRUCTURALLY IMPOSSIBLE in production) ─────────
  // Gate order: NODE_ENV check → bypass flag. The flag is NEVER
  // evaluated when NODE_ENV is 'production'. This eliminates the
  // risk of a leaked AXIOM_AUTH_BYPASS env var in a production build.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.AXIOM_AUTH_BYPASS === 'true'
  ) {
    console.warn('[Auth] ⚠️  DEV BYPASS ACTIVE — No JWT verification. Never use in production.');
    return {
      userId: 'dev-user-001',
      email: 'dev@axiom.local',
    };
  }

  // ── Extract Bearer Token ───────────────────────────────────────
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw Errors.unauthorized('Missing or malformed Authorization header.');
  }

  const token = authHeader.slice(7);
  if (!token || token.length < 10) {
    throw Errors.unauthorized('Bearer token is empty or malformed.');
  }

  // ── Verify JWT via JWKS ────────────────────────────────────────
  try {
    const JWKS = getJWKS();

    // Build verification options — issuer and audience are optional
    // but STRONGLY recommended for production deployments.
    const verifyOptions: Parameters<typeof jwtVerify>[2] = {
      algorithms: ['RS256', 'ES256'],
    };

    if (process.env.AUTH_ISSUER) {
      verifyOptions.issuer = process.env.AUTH_ISSUER;
    }
    if (process.env.AUTH_AUDIENCE) {
      verifyOptions.audience = process.env.AUTH_AUDIENCE;
    }

    const { payload } = await jwtVerify(token, JWKS, verifyOptions);

    // ── Validate Required Claims ─────────────────────────────────
    const userId = payload.sub;
    if (!userId) {
      throw Errors.unauthorized('Token missing required subject (sub) claim.');
    }

    return {
      userId,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      tenantId: typeof payload.tenant_id === 'string'
        ? payload.tenant_id
        : undefined,
    };
  } catch (err: unknown) {
    // Re-throw known ApiErrors (e.g., from configMissing or unauthorized)
    if (err instanceof ApiError) throw err;

    // Log the real error server-side, return sanitized message to client.
    // NEVER leak JWT verification details to the caller.
    console.error(
      '[Auth] JWT verification failed:',
      err instanceof Error ? err.message : err
    );
    throw Errors.unauthorized('Invalid or expired authentication token.');
  }
}
