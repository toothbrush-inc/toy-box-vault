// Stable opaque ids for verified identities.
//
// Shared by calsync (tenant ids / broker slots) and the capability-gateway
// (per-user profile directories). Emails hash; bare owners stay path-safe.
// Do not invent a parallel slug in an app — import from here.

import { createHash } from "node:crypto";

/**
 * Stable opaque id for a verified identity.
 *
 * - Emails → `i` + first 32 hex chars of SHA-256 of the lowercased address
 *   (collision-resistant; punctuation and length no longer collide).
 * - Bare ids (no `@`, e.g. pinned-view owners) → path-safe sanitised slug.
 * - Empty / nothing usable → null.
 */
export function identitySlug(identity: string): string | null {
  const normalized = identity.trim().toLowerCase();
  if (normalized === "") {
    return null;
  }
  if (normalized.includes("@")) {
    const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
    return `i${digest.slice(0, 32)}`;
  }
  const slug = normalized
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 96);
  return slug === "" ? null : slug;
}

/**
 * Tenant a signed-in email lands on: an explicit override, else
 * {@link identitySlug}. Null when the email is empty.
 *
 * Overrides are keyed by lowercased email.
 */
export function tenantForIdentity(
  email: string,
  overrides: Record<string, string> = {},
): string | null {
  const normalized = email.trim().toLowerCase();
  if (normalized === "") {
    return null;
  }
  const override = overrides[normalized];
  if (override !== undefined) {
    return override;
  }
  return identitySlug(normalized);
}
