/**
 * The docs helper's count on the Command Center: the 30 day tile and the
 * weekly tables, in plain words, with the no-answer count up front.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { totalsFrom, weeklyFrom, weeksEndingAt } from "@/lib/admin/docs-tally";
import { DocsTallyTile, DocsTallyWeekly } from "./docs-tally-panels";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("DocsTallyTile", () => {
  it("shows questions asked, the share answered and the no answers, and links to the details", () => {
    const html = renderToStaticMarkup(
      <DocsTallyTile
        totals={totalsFrom([
          { outcome: "answered", n: 900 },
          { outcome: "canned", n: 200 },
          { outcome: "unsure", n: 100 },
          { outcome: "none", n: 34 },
        ])}
      />,
    );
    expect(html).toContain('href="/admin/docs-questions"');
    const t = text(html);
    expect(t).toContain("Docs helper, last 30 days");
    expect(t).toMatch(/Questions asked 1,234/);
    expect(t).toMatch(/Answered 89%/);
    expect(t).toMatch(/No answer 34 3%/);
    expect(t).not.toMatch(/[–—]/);
  });

  it("says what to run when the count cannot be read", () => {
    const t = text(renderToStaticMarkup(<DocsTallyTile totals={null} error="relation does not exist" />));
    expect(t).toContain("99_supabase_migration_docs_ask_tally_v1.sql");
  });

  it("reads - for shares before anything is asked", () => {
    expect(text(renderToStaticMarkup(<DocsTallyTile totals={totalsFrom([])} />))).toMatch(/Answered - No answer 0 -/);
  });
});

describe("DocsTallyWeekly", () => {
  const weeks = weeksEndingAt("2026-09-25", 12);
  const tally = weeklyFrom(
    [
      { week: "2026-09-21", outcome: "answered", signed_in: true, section: null, app_area: null, n: 5 },
      { week: "2026-09-21", outcome: "none", signed_in: false, section: null, app_area: null, n: 5 },
      { week: "2026-09-21", outcome: "answered", signed_in: null, section: "rules", app_area: null, n: 5 },
      { week: "2026-09-21", outcome: "none", signed_in: null, section: "home", app_area: null, n: 5 },
      { week: "2026-09-21", outcome: "none", signed_in: null, section: null, app_area: "calendar", n: 2 },
    ],
    weeks,
  );

  it("lists the 12 weeks newest first, by reply and by signed in or out, then where it was asked", () => {
    const html = renderToStaticMarkup(<DocsTallyWeekly tally={tally} />);
    const t = text(html);
    expect(t).toContain("Questions asked, last 12 weeks");
    expect(t.indexOf("Sep 21")).toBeLessThan(t.indexOf("Jul 6"));
    expect(t).toMatch(/Week of Asked From the docs Set reply Might help No answer No answer share Signed in Signed out/);
    expect(t).toMatch(/Sep 21 10 5 0 0 5 50% 5 5/);
    expect(t).toContain("Where it was asked");
    expect(t).toMatch(/Docs home( 0){11} 5 5 5 100%/);
    expect(t).toMatch(/Calendar( 0){11} 2 2 2 100%/);
    expect(t).toContain("never the question");
    expect(t).not.toMatch(/[–—]/);
  });

  it("says what to run when the weeks cannot be read", () => {
    expect(text(renderToStaticMarkup(<DocsTallyWeekly tally={null} error="boom" />))).toContain(
      "99_supabase_migration_docs_ask_tally_v1.sql",
    );
  });
});
