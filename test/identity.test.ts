import { describe, expect, it } from "vitest";

import {
  identitySlug,
  tenantForIdentity,
} from "../src/identity.js";

describe("identitySlug", () => {
  it("hashes emails collision-resistantly", () => {
    expect(identitySlug("Ana.B@Example.com")).toBe("i4248cc593102d6944c982776b98b8d40");
    expect(identitySlug("ana-b@example.com")).toBe("i8b5313038e8fbab2a34a2f8ae58801b3");
    expect(identitySlug("Ana.B@Example.com")).not.toBe(identitySlug("ana-b@example.com"));
  });

  it("passes bare owners through sanitised", () => {
    expect(identitySlug("dvd")).toBe("dvd");
    expect(identitySlug("../../etc/passwd")).toBe("etc_passwd");
    expect(identitySlug("a/../b")).toBe("a_b");
  });

  it("returns null when nothing usable survives", () => {
    expect(identitySlug("")).toBeNull();
    expect(identitySlug("   ")).toBeNull();
    expect(identitySlug("///")).toBeNull();
  });
});

describe("tenantForIdentity", () => {
  it("hashes by default and honours overrides", () => {
    expect(tenantForIdentity("Ana.B@Example.com")).toBe("i4248cc593102d6944c982776b98b8d40");
    expect(tenantForIdentity("owner@example.com", { "owner@example.com": "default" })).toBe(
      "default",
    );
    expect(tenantForIdentity("   ")).toBeNull();
  });

  it("keeps long emails distinct", () => {
    const long = `${"x".repeat(200)}@example.com`;
    const longer = `${"x".repeat(201)}@example.com`;
    expect(tenantForIdentity(long)).toMatch(/^i[0-9a-f]{32}$/u);
    expect(tenantForIdentity(long)).not.toBe(tenantForIdentity(longer));
  });
});
