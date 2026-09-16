import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WalkedAwayRow, WalkedAwaySummaryRow } from "@/lib/admin/product-analytics";
import { WalkedAwayCard } from "./product-analytics-panels";

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
