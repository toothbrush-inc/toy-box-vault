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
 * Overrides are keyed by lowercased email. Existing deployments that already
 * stored punctuation-slug tenants should keep those people on their old ids
 * via overrides (or rename state and broker slots) until migration completes.
 * Use {@link legacyTenantSlug} to compute the former calsync mapping.
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

/**
 * Former calsync punctuation-slug tenant (`ana.b@example.com` → `ana-b-example-com`).
 * For migration overrides only.
 */
export function legacyTenantSlug(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  let slug = normalized.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (slug === "") {
    return null;
  }
  if (!/^[a-z]/u.test(slug)) {
    slug = `u-${slug}`;
  }
  slug = slug.slice(0, 63).replace(/-+$/u, "");
  return slug === "" ? null : slug;
}

/**
 * Former gateway profile-dir slug (`owner@example.com` → `owner_at_example_com`).
 * For migration lookups only.
 */
export function legacyUserSlug(identity: string): string | null {
  const slug = identity
    .trim()
    .toLowerCase()
    .replace(/@/gu, "_at_")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 96);
  return slug === "" ? null : slug;
}
