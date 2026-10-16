/**
 * Regression test for #4232
 *
 * codebuddy-intl was missing from OAUTH_TEST_CONFIG. The test route handler
 * returned {"valid":false,"error":"Provider test not supported"} for every
 * codebuddy-intl account, regardless of token validity.
 *
 * Fix: add "codebuddy-intl": { tokenExists: true } alongside "codebuddy-cn".
 * Both providers use the same JWT token structure (eyJ…, ~1-year expiry,
 * access + refresh token pair) so the same test strategy applies.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Read the source file and verify the config entry is present.
// testUtils.js is a Next.js server file so we inspect the source text
// rather than importing it (avoids next/server bootstrap requirements).

const src = fs.readFileSync(
  path.resolve("../src/app/api/providers/[id]/test/testUtils.js"),
  "utf-8"
);

describe("OAUTH_TEST_CONFIG — codebuddy-intl (#4232)", () => {
  it('contains "codebuddy-intl" entry', () => {
    expect(src).toContain('"codebuddy-intl"');
  });

  it('"codebuddy-intl" probes the Keycloak userinfo endpoint (MIBP fork §4)', () => {
    // MIBP fork guard (AGENTS.md §4): codebuddy-intl access tokens are Keycloak
    // JWTs, so this entry uses a buildUrl userinfo probe rather than upstream's
    // `tokenExists: true` shape (a bare tokenExists check would pass for a
    // revoked/expired token). Do NOT "fix" this back to the upstream shape —
    // the guard is covered by tests/unit/codebuddy-intl-connection.test.js.
    const entry = src.match(/"codebuddy-intl"\s*:\s*\{[\s\S]*?\n  \}/);
    expect(entry).toBeTruthy();
    expect(entry[0]).toContain("buildUrl");
    expect(entry[0]).toContain("openid-connect/userinfo");
  });

  it('"codebuddy-cn" still has tokenExists: true (regression guard)', () => {
    expect(src).toMatch(/"codebuddy-cn"\s*:\s*\{\s*tokenExists\s*:\s*true\s*\}/);
  });
});