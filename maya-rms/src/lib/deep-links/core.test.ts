import { describe, expect, it } from "vitest";
import { BOOKING_SPEED_LEVELS } from "@/lib/observations/booking-speed";
import { BOOKING_SPEED_WAIT_OPTIONS, newConditionRow } from "@/lib/rule-form";
import { HOTEL_ROLES } from "@/lib/roles";
import { links, registry, safeNext, docsHref } from "@/lib/deep-links";
import pagesJson from "@/lib/docs/generated/pages.json";

describe("the registry", () => {
  it("runs every destination's own examples through the parser", () => {
    let count = 0;
    for (const [id, d] of Object.entries(registry.destinations)) {
      for (const ex of d.examples ?? []) {
        const got = links.parseLink(id, ex.q);
        expect(got.query, `${id}?${ex.q}`).toBe(ex.out);
        expect(got.dest, `${id}?${ex.q}`).toBe(ex.dest ?? id);
        if (ex.docsProblems) {
          const docs = links.parseLink(id, ex.q, { source: "docs" });
          for (const p of ex.docsProblems) expect(docs.problems.some((x) => x.startsWith(p)), `${id}?${ex.q} flags ${p}`).toBe(true);
        }
        count++;
      }
    }
    for (const ex of registry.unknownDestinationExamples) {
      const got = links.parseLink(ex.dest, ex.q);
      expect(got.dest).toBe(ex.resolves);
      expect(got.query).toBe(ex.out);
      count++;
    }
    expect(count).toBeGreaterThan(30);
  });

  it("only ever sends people to its own list of paths, none of which does anything on GET", () => {
    expect(registry.paths).toEqual(["/", "/account/team", "/account/billing", "/onboarding/review", "/onboarding/questions"]);
    for (const d of Object.values(registry.destinations)) expect(registry.paths).toContain(d.target.path);
  });

  it("is internally consistent", () => {
    const ids = Object.keys(registry.destinations);
    for (const [id, d] of Object.entries(registry.destinations)) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/);
      for (const k of d.params) {
        expect(registry.params[k], `${id} param ${k}`).toBeDefined();
        expect(registry.params[k].go, `${id} lists internal key ${k}`).not.toBe(false);
      }
      for (const [k, values] of Object.entries(d.narrow ?? {})) {
        for (const v of values) expect(registry.params[k].values ?? []).toContain(v);
      }
      for (const [k, v] of Object.entries(d.target.set ?? {})) {
        expect(links.checkValue(k, v), `${id} sets ${k}=${v}`).toBe(v);
      }
      if (d.fallback) expect(ids).toContain(d.fallback);
      if (d.belowRole && d.belowRole !== "page") {
        expect(ids).toContain(d.belowRole.to);
        expect(registry.params.note.values).toContain(d.belowRole.note);
      }
      for (const w of Object.values(d.when ?? {})) expect(ids).toContain(w.to);
      if (d.role) expect(registry.roles).toContain(d.role);
      if (d.docsLinkable) for (const r of d.required ?? []) expect(registry.params[r].docs, `${id} needs ${r}`).not.toBe(false);
    }
  });

  it("points every Help link, Learn more and destination at a docs page and heading that exist", () => {
    const pages = new Map((pagesJson as { path: string; headings: { id: string }[] }[]).map((p) => [p.path, p]));
    const refs = [
      ...Object.values(registry.destinations).map((d) => d.docs),
      ...Object.values(registry.help.screens),
      ...Object.values(registry.help.panels),
    ].filter((r): r is string => Boolean(r));
    expect(refs.length).toBeGreaterThan(40);
    for (const ref of refs) {
      const [page, anchor] = ref.split("#");
      const p = pages.get(page);
      expect(p, ref).toBeDefined();
      if (anchor) expect(p!.headings.map((h) => h.id), ref).toContain(anchor);
    }
  });

  it("promises only values the forms really have", () => {
    expect(registry.params.speed.values).toEqual(BOOKING_SPEED_LEVELS.map((l) => l.key));
    expect(registry.params.night_speed.values).toEqual(["none", ...BOOKING_SPEED_LEVELS.map((l) => l.key)]);
    expect(registry.params.wait.values).toEqual(BOOKING_SPEED_WAIT_OPTIONS.map((o) => String(o.days)));
    expect(registry.params.over.values).toEqual(["1", "7", "30"]);
    expect(registry.params.lookback.values).toEqual(["1", "3", "7"]);
    expect([...(registry.params.role.values ?? [])].sort()).toEqual(HOTEL_ROLES.map((r) => r.key).sort());
    expect(registry.params.tab.values).toEqual(["calendar", "rules", "simulator", "changelog", "pms"]);
    const row = newConditionRow("pickup");
    for (const spec of Object.values(registry.params)) {
      if (spec.field) expect(Object.keys(row), spec.field).toContain(spec.field);
    }
  });
});

describe("parseLink", () => {
  it("drops bad values one at a time and keeps the rest", () => {
    const got = links.parseLink("rules.new", "name=Busy+nights&occupancy=gt101&direction=increase&percent=10");
    expect(got.params).toEqual({ name: "Busy nights", direction: "increase", percent: "10" });
    expect(got.problems).toEqual(["occupancy"]);
  });

  it("reads only the first of a repeated key and ignores a query that is far too long", () => {
    expect(links.parseLink("changelog", "view=all&view=changes").params).toEqual({ view: "all" });
    expect(links.parseLink("changelog", `view=all&x=${"a".repeat(2000)}`).params).toEqual({});
  });

  it("stops reading after the key limit", () => {
    const junk = Array.from({ length: 30 }, (_, i) => `k${i}=1`).join("&");
    expect(links.parseLink("changelog", `${junk}&view=all`).params).toEqual({});
  });

  it("never takes the internal keys from a link", () => {
    const got = links.parseLink("calendar", "tab=pms&panel=builder&dl=rules.new&note=role-rules&month=2026-12");
    expect(got.params).toEqual({ month: "2026-12" });
    expect(got.problems.sort()).toEqual(["dl", "note", "panel", "tab"]);
  });

  it("keeps the property only as a gate, and a malformed one is dropped", () => {
    const id = "0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f";
    expect(links.parseLink("calendar", `hotel=${id.toUpperCase()}`).gate).toEqual({ hotel: id });
    expect(links.parseLink("calendar", "hotel=not-a-uuid").gate).toEqual({});
  });

  it("checks the manual price range and falls back without a night", () => {
    expect(links.parseLink("calendar.manual-price", "date=2026-10-03&through=2027-10-04").params).toEqual({ date: "2026-10-03" });
    expect(links.parseLink("calendar.manual-price", "date=2026-10-03&through=2027-10-03").params).toEqual({
      date: "2026-10-03",
      through: "2027-10-03",
    });
    const fb = links.parseLink("calendar.day", "roomType=0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f");
    expect(fb.dest).toBe("calendar");
    expect(fb.params).toEqual({});
    expect(fb.fellBack).toBe(true);
  });

  it("refuses names that could carry markup, addresses or links", () => {
    for (const bad of ["<b>x</b>", "a/b", "http://x", "me@x.co", "a:b", "#x", "?x", "a\u0000b"]) {
      expect(links.parseLink("rules.new", { name: bad }).params.name, bad).toBeUndefined();
    }
    expect(links.parseLink("rules.new", { name: "Slow-date rescue, not full" }).params.name).toBe("Slow-date rescue, not full");
    expect(links.parseLink("rules.new", { name: "Sommer (Juli) & Août 10%" }).params.name).toBe("Sommer (Juli) & Août 10%");
    expect(links.parseLink("rules.new", { name: "x".repeat(61) }).params.name).toBeUndefined();
  });

  it("reports everything the docs may not write", () => {
    const got = links.parseLink("rules.new", { percent: "10.0", direction: "up", over: "7", hotel: "0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f" }, { source: "docs" });
    expect(got.problems).toEqual(expect.arrayContaining(['percent (would read as "10")', "direction", "over", "hotel"]));
    expect(links.parseLink("rules.edit", {}, { source: "docs" }).problems).toContain('destination "rules.edit"');
    expect(links.parseLink("calendar.day", {}, { source: "docs" }).problems).toContain("missing date");
  });
});

describe("hrefs", () => {
  it("writes /go links in the destination's own order", () => {
    expect(links.goHref("rules.new", { percent: "10", direction: "increase", name: "Nearly full", occupancy: "gt85" })).toBe(
      "/go/rules.new?name=Nearly+full&occupancy=gt85&direction=increase&percent=10",
    );
    expect(links.goHref("nope")).toBe("/go/home");
    expect(links.goHref("team.invite", { role: "viewer" }, { hotel: "0B0C8A6E-3C1D-4D8E-9F2A-6A1B2C3D4E5F" })).toBe(
      "/go/team.invite?role=viewer&hotel=0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f",
    );
  });

  it("sends a parsed link to its registry path with its fixed keys first", () => {
    const parsed = links.parseLink("rules.new", "name=Nearly+full&occupancy=gt85&direction=increase&percent=10");
    expect(links.internalHref(parsed)).toBe("/?tab=rules&panel=builder&dl=rules.new&name=Nearly+full&occupancy=gt85&direction=increase&percent=10");
    expect(links.internalHref({ dest: "suggestions", params: {} }, { note: "role-suggestions" })).toBe(
      "/?tab=rules&focus=suggestions&dl=suggestions&note=role-suggestions",
    );
    expect(links.internalHref({ dest: "team.invite", params: { role: "viewer" } })).toBe("/account/team?focus=invite&dl=team.invite&role=viewer");
    expect(links.internalHref({ dest: "home", params: {} }, { note: "made-up" })).toBe("/?dl=home");
  });

  it("points at the docs", () => {
    expect(docsHref("rules/the-rate-simulator#build-a-test-rule")).toBe("/docs/rules/the-rate-simulator#build-a-test-rule");
    expect(docsHref("")).toBe("/docs");
  });
});

describe("readArrival", () => {
  it("re-reads everything and keeps only the place in the address", () => {
    const a = links.readArrival("?tab=rules&panel=builder&dl=rules.new&name=Nearly+full&occupancy=gt85&percent=90&filter=enabled");
    expect(a.dest).toBe("rules.new");
    expect(a.params).toEqual({ name: "Nearly full", occupancy: "gt85" });
    expect(a.keep).toBe("tab=rules&panel=builder&filter=enabled");
  });

  it("fills nothing without a valid dl", () => {
    const a = links.readArrival("?tab=rules&panel=builder&name=Nearly+full&percent=10");
    expect(a.dest).toBeNull();
    expect(a.params).toEqual({});
    expect(a.keep).toBe("tab=rules&panel=builder");
  });

  it("takes the highlight from the registry, not the address", () => {
    expect(links.readArrival("?tab=rules&focus=suggestions&dl=suggestions").focus).toBe("suggestions");
    expect(links.readArrival("?tab=rules&focus=guardrails&dl=suggestions").focus).toBe("suggestions");
    expect(links.readArrival("?tab=pms&focus=room-types&dl=room-types&note=role-price").note).toBe("role-price");
    expect(links.readArrival("?dl=home&note=<script>").note).toBeNull();
  });
});

describe("safeNext", () => {
  const cases: [string, string | null][] = [
    ["/go/rules.new?name=Nearly+full&percent=10", "/go/rules.new?name=Nearly+full&percent=10"],
    ["/go/rules.new", "/go/rules.new"],
    ["/go/rules.new#frag", "/go/rules.new"],
    ["/go/rules.new?next=//evil.example", "/go/rules.new?next=%2F%2Fevil.example"],
    ["/go/calendar?hotel=0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f&month=2026-12", "/go/calendar?month=2026-12"],
    ["//evil.example/go/rules.new", null],
    ["/go//evil.example", null],
    ["/go/\\evil.example", null],
    ["/\\evil.example", null],
    ["/go/../admin", null],
    ["/go/%2e%2e/admin", null],
    ["/go/rules.new/../../admin", null],
    ["https://evil.example/go/rules.new", null],
    ["/go/rules.new@evil.example", null],
    ["/go/rules.new\n", null],
    ["/go/ rules.new", null],
    ["/admin", null],
    ["/", null],
    ["/go/RULES.NEW", null],
  ];
  it.each(cases)("%s", (raw, want) => {
    expect(safeNext(raw)).toBe(want);
  });
  it("caps the length", () => {
    expect(safeNext(`/go/rules.new?name=${"a".repeat(1600)}`)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
  });
});
