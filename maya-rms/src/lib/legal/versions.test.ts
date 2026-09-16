/**
 * The signup form and the database trigger never meet: the form writes a
 * metadata object, and SQL in a hand-run migration reads it back. A renamed key
 * or a new context on one side would silently record nothing, so these pin the
 * two halves to each other.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAcceptanceExemptPath,
  metadataAcceptsCurrent,
  PRIVACY_VERSION,
  SIGNUP_ACCEPTANCE_KEY,
  signupAcceptanceMetadata,
  TERMS_VERSION,
  TERMS_URL,
  PRIVACY_URL,
} from "./versions";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../../../99_supabase_migration_terms_acceptance_v1.sql"),
  "utf8",
);

describe("signup metadata", () => {
  it("carries the current versions under the key the trigger reads", () => {
    const meta = signupAcceptanceMetadata("claim", "Mozilla/5.0");
    expect(meta).toEqual({
      maya_terms: {
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        context: "claim",
        user_agent: "Mozilla/5.0",
      },
    });
    expect(MIGRATION).toContain(`raw_user_meta_data -> '${SIGNUP_ACCEPTANCE_KEY}'`);
    for (const field of ["terms_version", "privacy_version", "context", "user_agent"]) {
      expect(MIGRATION).toContain(`p_meta ->> '${field}'`);
    }
  });

  it("caps a user agent at what the column accepts", () => {
    const meta = signupAcceptanceMetadata("signup", "x".repeat(2000));
    expect(meta.maya_terms.user_agent).toHaveLength(512);
    expect(MIGRATION).toContain("char_length(user_agent) <= 512");
  });

  it("recognises only the versions in force now", () => {
    expect(metadataAcceptsCurrent(signupAcceptanceMetadata("signup"))).toBe(true);
    expect(
      metadataAcceptsCurrent({ maya_terms: { terms_version: "0", privacy_version: PRIVACY_VERSION } }),
    ).toBe(false);
    expect(metadataAcceptsCurrent({ full_name: "Ana" })).toBe(false);
    expect(metadataAcceptsCurrent(null)).toBe(false);
  });

  it("uses only contexts the table accepts", () => {
    expect(MIGRATION).toMatch(/context in \('signup', 'claim', 'invite', 'reaccept'\)/);
  });
});

describe("the accept screen stays off the pages that carry their own checkbox", () => {
  it.each(["/login", "/auth/accept-invite", "/auth/logout", null])("exempts %s", (path) => {
    expect(isAcceptanceExemptPath(path)).toBe(true);
  });

  it.each(["/", "/onboarding", "/onboarding/review", "/account/billing", "/admin", "/loginx"])(
    "covers %s",
    (path) => {
      expect(isAcceptanceExemptPath(path)).toBe(false);
    },
  );
});

it("links the published documents", () => {
  expect(TERMS_URL).toBe("https://www.get-maya.com/terms");
  expect(PRIVACY_URL).toBe("https://www.get-maya.com/privacy");
});
