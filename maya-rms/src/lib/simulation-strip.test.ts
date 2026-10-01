import { describe, expect, it } from "vitest";
import { liveHelp, liveTitle, pickConnection, propertyMode, sendingSwitchOn, simulationHelp, simulationStripText, WHO_CAN_GO_LIVE } from "./simulation-strip";

const cloudbeds = [{ pms_type: "cloudbeds", status: "connected" }];
const mode = (o: Partial<Parameters<typeof propertyMode>[0]> = {}) =>
  propertyMode({ simulationMode: true, connections: cloudbeds, memberRole: "general_manager", windowDays: 396, ...o });

describe("who is offered Go live", () => {
  it("a General Manager or Hotel Admin of a simulating property", () => {
    expect(mode({ memberRole: "general_manager" }).canGoLive).toBe(true);
    expect(mode({ memberRole: "hotel_admin" }).canGoLive).toBe(true);
  });

  it("nobody below General Manager, and no one looking without a membership of their own", () => {
    expect(mode({ memberRole: "revenue_manager" }).canGoLive).toBe(false);
    expect(mode({ memberRole: "viewer" }).canGoLive).toBe(false);
    // A platform admin's support view (God Mode or not), and a developer or sales login: no membership here.
    expect(mode({ memberRole: null }).canGoLive).toBe(false);
  });

  it("not on a system MAYA doesn't send prices to, and not once live", () => {
    expect(mode({ connections: [{ pms_type: "mews", status: "connected" }] })).toMatchObject({ pmsType: "mews", sendsPrices: false, canGoLive: false });
    expect(mode({ connections: [{ pms_type: "think", status: "connected" }] })).toMatchObject({ sendsPrices: true, canGoLive: true });
    expect(mode({ simulationMode: false })).toMatchObject({ mode: "live", canGoLive: false });
  });

  it("with no connection at all, as the confirm then says nothing is sent until one is", () => {
    expect(mode({ connections: [] })).toMatchObject({ pmsType: null, connected: false, canGoLive: true });
    expect(mode({ connections: [{ pms_type: "cloudbeds", status: "disconnected" }] })).toMatchObject({ connected: false, canGoLive: true });
  });

  it("reads a missing settings row as simulation, as the push does", () => {
    expect(mode({ simulationMode: null }).mode).toBe("simulation");
    expect(mode({ simulationMode: undefined }).mode).toBe("simulation");
  });
});

describe("the words", () => {
  it("say plainly that nothing is sent, naming the system", () => {
    expect(simulationStripText(mode())).toBe("Simulation · MAYA works out prices but sends nothing to Cloudbeds");
    expect(simulationStripText(mode({ connections: [] }))).toBe("Simulation · MAYA works out prices but sends nothing to your property system");
  });

  it("tell everyone else who can switch it", () => {
    expect(simulationHelp(mode({ memberRole: "viewer" })).lines).toContain(WHO_CAN_GO_LIVE);
    expect(WHO_CAN_GO_LIVE).toBe("A General Manager or Hotel Admin can switch this property to live.");
    expect(simulationHelp(mode()).lines).not.toContain(WHO_CAN_GO_LIVE);
    expect(simulationHelp(mode({ connections: [{ pms_type: "mews", status: "connected" }] })).lines).toContain(
      "MAYA doesn't send prices to Mews yet, so there is nothing to switch on here.",
    );
  });

  it("say what live means only where nothing is sent", () => {
    expect(liveHelp(mode({ simulationMode: false }))).toBeNull();
    expect(liveTitle(mode({ simulationMode: false }))).toBe("MAYA sends its prices to Cloudbeds.");
    expect(liveHelp(mode({ simulationMode: false, connections: [{ pms_type: "mews", status: "connected" }] }))?.lines).toEqual([
      "MAYA doesn't send prices to Mews yet, so nothing goes to it, live or not.",
    ]);
  });

  it("use no em dash", () => {
    const all = [simulationStripText(mode()), WHO_CAN_GO_LIVE, ...simulationHelp(mode()).lines, ...simulationHelp(mode({ memberRole: null })).lines];
    for (const s of all) expect(s).not.toMatch(/—/);
  });
});

describe("pickConnection", () => {
  it("takes a working connection over a stale one", () => {
    expect(
      pickConnection([
        { pms_type: "mews", status: "disconnected" },
        { pms_type: "cloudbeds", status: "connected" },
      ])?.pms_type,
    ).toBe("cloudbeds");
    expect(pickConnection([])).toBeNull();
  });
});

describe("a system whose sending is switched off (audit A25)", () => {
  const think = (sendingSwitch: boolean | null | undefined) =>
    propertyMode({
      simulationMode: true,
      connections: [{ pms_type: "think", status: "connected" }],
      memberRole: "general_manager",
      windowDays: 60,
      sendingSwitch,
    });

  it("reads ThinkReservations as off until its sync says it is on, and Cloudbeds as on until it says off", () => {
    expect(sendingSwitchOn("think", null)).toBe(false);
    expect(sendingSwitchOn("think", true)).toBe(true);
    expect(sendingSwitchOn("cloudbeds", null)).toBe(true);
    expect(sendingSwitchOn("cloudbeds", false)).toBe(false);
    expect(sendingSwitchOn("mews", true)).toBe(false);
    expect(sendingSwitchOn(null, true)).toBe(false);
    expect(think(null)).toMatchObject({ sendsPrices: true, sendingOn: false, canGoLive: true });
    expect(think(true)).toMatchObject({ sendingOn: true });
  });

  it("says so in the strip's ?, on the Live tag and in its ?", () => {
    const off = think(null);
    expect(simulationHelp(off).lines[1]).toBe(
      "Sending to Think Reservations isn't on yet, so going live sends nothing until MAYA switches it on. To go back to simulation, email us.",
    );
    expect(simulationHelp(think(true)).lines[1]).toBe("Go live starts sending on the next cycle, about 5 minutes later. To go back to simulation, email us.");
    const live = { ...off, mode: "live" as const };
    expect(liveTitle(live)).toBe("Sending to Think Reservations isn't on yet.");
    expect(liveHelp(live)?.lines).toEqual(["Sending to Think Reservations isn't on yet, so nothing goes to it. Your prices wait until MAYA switches it on."]);
    const liveOn = { ...think(true), mode: "live" as const };
    expect(liveHelp(liveOn)).toBeNull();
  });
});
