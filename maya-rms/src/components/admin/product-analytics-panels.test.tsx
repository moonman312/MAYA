import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WalkedAwayRow, WalkedAwaySummaryRow } from "@/lib/admin/product-analytics";
import { PushProblemsPanel, WalkedAwayCard } from "./product-analytics-panels";

const summary: WalkedAwaySummaryRow[] = [
  { sort: 0, stage: "connected", properties: 4, deferred: 1, in_groups: 0 },
  { sort: 1, stage: "walked_away", properties: 2, deferred: 1, in_groups: 0 },
  { sort: 2, stage: "connected_never_claimed", properties: 1, deferred: 0, in_groups: 0 },
  { sort: 3, stage: "claimed_never_checkout", properties: 1, deferred: 1, in_groups: 0 },
  { sort: 4, stage: "checkout_never_subscribed", properties: 0, deferred: 0, in_groups: 0 },
  { sort: 5, stage: "trialed_never_paid", properties: 0, deferred: 0, in_groups: 0 },
  { sort: 6, stage: "paid_then_left", properties: 0, deferred: 0, in_groups: 0 },
  { sort: 7, stage: "in_flight", properties: 1, deferred: 0, in_groups: 0 },
  { sort: 8, stage: "converted", properties: 1, deferred: 0, in_groups: 0 },
];

const base: WalkedAwayRow = {
  property_key: "cloudbeds:1001",
  hotel_id: "10000000-0000-0000-0000-000000000001",
  hotel_exists: true,
  property_name: "Seaview Inn",
  pms_type: "cloudbeds",
  pms_property_id: "1001",
  connected_at: "2026-09-14T09:00:00Z",
  connects: 1,
  furthest_stage: "connected",
  outcome: "walked_away",
  walked_away_stage: "connected_never_claimed",
  deferred: false,
  subscription_status: null,
  group_key: null,
  group_size: null,
  owner_user_id: null,
  owner_email: null,
  last_activity_at: "2026-09-14T09:00:00Z",
};

describe("WalkedAwayCard", () => {
  it("leads with walked away of connected, and lists only the ones to follow up", () => {
    const html = renderToStaticMarkup(
      <WalkedAwayCard
        summary={summary}
        from="2026-09-14"
        to="2026-09-20"
        rows={[
          base,
          {
            ...base,
            property_key: "cloudbeds:3001",
            hotel_id: "10000000-0000-0000-0000-000000000003",
            property_name: "Harbour Lodge",
            furthest_stage: "claimed",
            walked_away_stage: "claimed_never_checkout",
            deferred: true,
            owner_email: "owner@example.com",
          },
          { ...base, property_key: "cloudbeds:7001", property_name: "Still Deciding", outcome: "in_flight", walked_away_stage: null },
        ]}
      />,
    );
    expect(html).toContain("Connected and walked away");
    expect(html).toMatch(/2 <span[^>]*>of 4<\/span>/);
    expect(html).toContain("Follow up (2)");
    expect(html).toContain("Harbour Lodge");
    expect(html).toContain("(not now)");
    expect(html).toContain("owner@example.com");
    expect(html).not.toContain("Still Deciding");
  });

  it("does not link to a property the sweep has removed", () => {
    const html = renderToStaticMarkup(
      <WalkedAwayCard summary={summary} from="2026-09-14" to="2026-09-20" rows={[{ ...base, hotel_exists: false }]} />,
    );
    expect(html).toContain("Seaview Inn");
    expect(html).not.toContain("/admin/hotels/10000000-0000-0000-0000-000000000001");
  });
});

describe("PushProblemsPanel", () => {
  it("flags each cause known or unknown, shows unknown wording, and lists open hotels", () => {
    const html = renderToStaticMarkup(
      <PushProblemsPanel
        data={{
          available: true,
          causes: [
            {
              cause: "unknown",
              known: false,
              guardrail: false,
              mayaBug: false,
              description: "Vendor wording the classifier does not recognise.",
              incidents: 2,
              attempts: 30,
              hotels: 1,
              resolvedByRetry: 1,
              escalated: 1,
              open: 1,
              medianHoursToLand: 0.5,
              sampleMessages: ["Cloudbeds patchRate failed (400): Odd thing"],
            },
            {
              cause: "guardrail_stale_price",
              known: true,
              guardrail: true,
              mayaBug: true,
              description: "Guardrail.",
              incidents: 1,
              attempts: 60,
              hotels: 1,
              resolvedByRetry: 0,
              escalated: 0,
              open: 0,
              medianHoursToLand: null,
              sampleMessages: [],
            },
          ],
          open: [
            {
              incidentId: "inc-1",
              hotelId: "10000000-0000-0000-0000-000000000001",
              hotelName: "Seaview Inn",
              pms: "Cloudbeds",
              cause: "unknown",
              known: false,
              openedAt: "2026-09-14T09:00:00Z",
              attempts: 30,
              shownToOwner: true,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Rate push problems");
    expect(html).toContain("Unknown");
    expect(html).toContain("MAYA bug");
    expect(html).toContain("guardrail stale price");
    expect(html).toContain("Cloudbeds patchRate failed (400): Odd thing");
    expect(html).toContain("Open now (1)");
    expect(html).toContain('href="/admin/hotels/10000000-0000-0000-0000-000000000001"');
    expect(html).toContain("30m");
  });

  it("says what is missing when the tables are not there yet", () => {
    const html = renderToStaticMarkup(<PushProblemsPanel data={{ available: false, reason: "Run the migration." }} />);
    expect(html).toContain("Run the migration.");
  });
});
