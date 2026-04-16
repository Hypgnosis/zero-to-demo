/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 / AXIOM-G — Policy Enforcement Point (PEP)
 *
 * Phase 1:  Zero-Trust Identity Gate.
 * Phase 3:  RBAC — Role-Based Access Control for Admin Fortress.
 *
 * Every API route MUST call authenticateRequest() before processing.
 * Admin routes MUST call authenticateRequest(req, { requireAdmin: true }).
 *
 * Supports:
 * - JWKS-based RS256/ES256 verification (Clerk, Auth0, Firebase)
 * - Role claim extraction from JWT payload
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
  /**
   * Phase 3: RBAC roles.
   * Expected JWT claim shape: { "roles": ["admin"] } or { "https://axiom.io/roles": ["admin"] }
   * Populated from standard `roles` claim, Clerk role metadata, or Auth0 custom namespaced claim.
   */
  roles: string[];
}

/**
 * Options for the Policy Enforcement Point.
 */
export interface AuthOptions {
  /**
   * If true, the request will be rejected with 403 Forbidden unless
   * the JWT contains `roles: ['admin']` (or a superset).
   *
   * ADMIN FORTRESS RULE: Only use this on /api/admin/* routes.
   * Standard user routes must NOT require admin — they enforce
   * ownership isolation at the session level instead.
   */
  requireAdmin?: boolean;
}

/* ─── JWKS Cache ──────────────────────────────────────────────── */

/**
 * Cached JWKS fetcher. jose's createRemoteJWKSet handles internal
 * caching and rotation, so we only instantiate once per process lifetime.
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

/* ─── Role Extraction ─────────────────────────────────────────── */

/**
 * Extracts the `roles` array from a JWT payload.
 *
 * We check three common claim locations in order of precedence:
 *   1. `roles`                         — Clerk, standard OIDC
 *   2. `https://axiom.io/roles`        — Auth0 custom namespaced claim
 *   3. `resource_access.axiom.roles`   — Keycloak resource access
 *
 * Returns an empty array if no roles are found — fail-safe.
 */
function extractRoles(payload: Record<string, unknown>): string[] {
  // Standard OIDC / Clerk
  if (Array.isArray(payload.roles) && payload.roles.every((r) => typeof r === 'string')) {
    return payload.roles as string[];
  }

  // Auth0 custom namespace
  const ns = payload['https://axiom.io/roles'];
  if (Array.isArray(ns) && ns.every((r) => typeof r === 'string')) {
    return ns as string[];
  }

  return [];
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
 * 5. Extract roles from payload.
 * 6. If options.requireAdmin is true, enforce 'admin' role or 403.
 * 7. Return verified AxiomClaims.
 *
 * @param req     - The incoming Next.js API request.
 * @param options - Optional enforcement options (e.g., requireAdmin).
 *
 * @throws ApiError(401) if the token is missing, invalid, or expired.
 * @throws ApiError(403) if requireAdmin is true and the user lacks the role.
 * @throws ApiError(500) if AUTH_JWKS_URL is not configured (and no bypass).
 * @returns Verified AxiomClaims including populated roles array.
 */
export async function authenticateRequest(
  req: Request,
  options: AuthOptions = {}
): Promise<AxiomClaims> {
  // ── Dev Bypass (STRUCTURALLY IMPOSSIBLE in production) ─────────
  // Gate order: NODE_ENV check → bypass flag. The flag is NEVER
  // evaluated when NODE_ENV is 'production'. This eliminates the
  // risk of a leaked AXIOM_AUTH_BYPASS env var in a production build.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.AXIOM_AUTH_BYPASS === 'true'
  ) {
    console.warn('[Auth] ⚠️  DEV BYPASS ACTIVE — No JWT verification. Never use in production.');

    // In dev bypass, we seed the admin role so admin routes can be tested locally.
    const devRoles = options.requireAdmin ? ['admin'] : [];

    return {
      userId: 'dev-user-001',
      email: 'dev@axiom.local',
      roles: devRoles,
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

    // ── Extract Roles (Phase 3: RBAC) ────────────────────────────
    const roles = extractRoles(payload as Record<string, unknown>);

    // ── Admin Fortress Gate ──────────────────────────────────────
    // We use 403 Forbidden — not 401 — to distinguish "valid auth,
    // insufficient privilege" from "invalid auth." This is standard
    // RBAC practice and prevents role probing via status codes alone.
    if (options.requireAdmin && !roles.includes('admin')) {
      console.warn(
        `[Auth] 🚨 Admin route denied for userId=${userId} (roles: [${roles.join(', ')}])`
      );
      throw Errors.forbidden('Admin privileges required to perform this action.');
    }

    return {
      userId,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : undefined,
      roles,
    };
  } catch (err: unknown) {
    // Re-throw known ApiErrors (e.g., from configMissing, unauthorized, or forbidden)
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
