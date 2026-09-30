// @vitest-environment jsdom
/**
 * Settings: the property's calendar (only a role that can manage the
 * property changes it; everyone else sees it read-only) and the person's own
 * text size. Every change saves at once; a save that fails puts the choice
 * back. Opened from the gear in the dashboard header, or by a link.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CALENDAR_DISPLAY, type CalendarDisplay } from "@/lib/calendar-display";
import { TEXT_SIZE_COOKIE } from "@/lib/text-size";
import { Dashboard } from "../dashboard";
import { SettingsDialog, type SettingsPayload } from "./settings-dialog";

const HOTEL = "99999999-9999-4999-8999-999999999999";
const STANDARD = "11111111-1111-4111-8111-111111111111";
const COURT = "22222222-2222-4222-8222-222222222222";
const ROOM_TYPES = [
  { id: COURT, name: "Court", counts_as_room: false },
  { id: STANDARD, name: "Standard", counts_as_room: true },
];

type Call = { url: string; method: string; body: unknown };

let calls: Call[] = [];
let payload: SettingsPayload;
let calendarAnswer: (body: CalendarDisplay) => Response;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  payload = { property: { canEdit: true, readOnly: null }, calendar: DEFAULT_CALENDAR_DISPLAY, textSize: "standard" };
  calendarAnswer = (body) => json({ calendar: body });
  document.cookie = `${TEXT_SIZE_COOKIE}=; Path=/; Max-Age=0`;
  document.documentElement.removeAttribute("data-text-size");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === "/api/settings") return json(payload);
      if (url === "/api/settings/calendar" && method === "PUT") return calendarAnswer(body as CalendarDisplay);
      if (url === "/api/settings/display" && method === "PUT") return json({ textSize: (body as { textSize: string }).textSize });
      // What the dashboard around it reads when it opens.
      if (url === "/api/rules" || url === "/api/rules/stops" || url === "/api/room-types") return json([]);
      if (url === "/api/rules/fire-counts") return json({});
      if (url === "/api/hotels") return json({ hotels: [], activeHotelId: null });
      if (url.startsWith("/api/calendar/")) return json({ error: "not in this test" }, 404);
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-text-size");
  window.history.replaceState(null, "", "/");
});

function open(overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onCalendarSaved = vi.fn();
  render(
    <SettingsDialog
      onClose={onClose}
      hotelId={HOTEL}
      propertyName="Harbour Inn"
      roomTypes={ROOM_TYPES}
      calendar={DEFAULT_CALENDAR_DISPLAY}
      onCalendarSaved={onCalendarSaved}
      {...overrides}
    />,
  );
  return { onClose, onCalendarSaved };
}

const saves = () => calls.filter((c) => c.method === "PUT");
const loaded = () => waitFor(() => expect(calls.some((c) => c.url === "/api/settings")).toBe(true));

describe("the Calendar section", () => {
  it("says who it is for and shows the property's choices", async () => {
    open();
    const section = screen.getByRole("region", { name: "Calendar" });
    expect(section.textContent).toContain("For everyone on Harbour Inn");
    await loaded();
    await waitFor(() => expect((screen.getByLabelText("Big number") as HTMLSelectElement).disabled).toBe(false));
    expect((screen.getByLabelText("Big number") as HTMLSelectElement).value).toBe("occupancy");
    expect((screen.getByLabelText("First small line") as HTMLSelectElement).value).toBe("rooms_booked");
    expect((screen.getByLabelText("Second small line") as HTMLSelectElement).value).toBe("room_revenue");
    expect(within(section).getByRole("radio", { name: "Standard" }).getAttribute("aria-checked")).toBe("true");
    // No price, so no room type to pick.
    expect(screen.queryByLabelText("Price for")).toBeNull();
  });

  it("is read-only, with the reason, for someone who cannot manage the property", async () => {
    payload = { ...payload, property: { canEdit: false, readOnly: "Only a Revenue Manager or above can change these." } };
    open();
    expect(await screen.findByText("Only a Revenue Manager or above can change these.")).toBeTruthy();
    for (const label of ["Big number", "First small line", "Second small line"]) {
      expect((screen.getByLabelText(label) as HTMLSelectElement).disabled).toBe(true);
    }
    const section = screen.getByRole("region", { name: "Calendar" });
    expect((within(section).getByRole("radio", { name: "Reversed" }) as HTMLButtonElement).disabled).toBe(true);
    // Their own text size is still theirs to change.
    const display = screen.getByRole("region", { name: "Display" });
    expect((within(display).getByRole("radio", { name: "Larger" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays read-only until it knows the person may change it", () => {
    open();
    expect((screen.getByLabelText("Big number") as HTMLSelectElement).disabled).toBe(true);
  });

  it("saves a new big number at once, swaps the old one into its line, and shows it on the calendar", async () => {
    const { onCalendarSaved } = open();
    await loaded();
    await waitFor(() => expect((screen.getByLabelText("Big number") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Big number"), { target: { value: "rooms_booked" } });
    await waitFor(() => expect(onCalendarSaved).toHaveBeenCalled());
    expect(saves()).toEqual([
      {
        url: "/api/settings/calendar",
        method: "PUT",
        body: { big: "rooms_booked", small: ["occupancy", "room_revenue"], price_room_type_id: null, colors: "standard" },
      },
    ]);
    expect(onCalendarSaved).toHaveBeenCalledWith({ big: "rooms_booked", small: ["occupancy", "room_revenue"], price_room_type_id: null, colors: "standard" });
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("asks for a room type once a price shows, starting on the first type that counts as a room", async () => {
    open();
    await loaded();
    await waitFor(() => expect((screen.getByLabelText("Big number") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Second small line"), { target: { value: "price" } });
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].body).toMatchObject({ small: ["rooms_booked", "price"], price_room_type_id: STANDARD });
    const picker = (await screen.findByLabelText("Price for")) as HTMLSelectElement;
    expect(picker.value).toBe(STANDARD);
    fireEvent.change(picker, { target: { value: COURT } });
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1].body).toMatchObject({ price_room_type_id: COURT });
  });

  it("clears a small line with None, and the second moves up", async () => {
    open();
    await loaded();
    await waitFor(() => expect((screen.getByLabelText("Big number") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("First small line"), { target: { value: "" } });
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].body).toMatchObject({ small: ["room_revenue"] });
  });

  it("reverses the colours, and it is never the default", async () => {
    const { onCalendarSaved } = open();
    await loaded();
    const section = screen.getByRole("region", { name: "Calendar" });
    await waitFor(() => expect((within(section).getByRole("radio", { name: "Reversed" }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(section).getByRole("radio", { name: "Standard" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(section).getByRole("radio", { name: "Reversed" }));
    await waitFor(() => expect(onCalendarSaved).toHaveBeenCalled());
    expect(saves()[0].body).toMatchObject({ colors: "reversed" });
    expect(within(section).getByRole("radio", { name: "Reversed" }).getAttribute("aria-checked")).toBe("true");
  });

  it("puts the choice back and says why when a save is refused", async () => {
    calendarAnswer = () => json({ error: "Only a Revenue Manager or above can change these." }, 403);
    const { onCalendarSaved } = open();
    await loaded();
    await waitFor(() => expect((screen.getByLabelText("Big number") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Big number"), { target: { value: "adr" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Only a Revenue Manager or above can change these.");
    expect((screen.getByLabelText("Big number") as HTMLSelectElement).value).toBe("occupancy");
    expect(onCalendarSaved).not.toHaveBeenCalled();
  });

  it("starts from what is saved when that differs from what the calendar last loaded", async () => {
    payload = { ...payload, calendar: { big: "adr", small: [], price_room_type_id: null, colors: "reversed" } };
    open();
    await waitFor(() => expect((screen.getByLabelText("Big number") as HTMLSelectElement).value).toBe("adr"));
    expect((screen.getByLabelText("Second small line") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("the Display section", () => {
  it("is just for the person, and shows a new text size at once, remembers it here and saves it to their profile", async () => {
    open();
    const display = screen.getByRole("region", { name: "Display" });
    expect(display.textContent).toContain("Just for you");
    expect(within(display).getByRole("radio", { name: "Standard" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(display).getByRole("radio", { name: "Larger" }));
    expect(document.documentElement.getAttribute("data-text-size")).toBe("larger");
    expect(document.cookie).toContain(`${TEXT_SIZE_COOKIE}=larger`);
    await waitFor(() => expect(saves()).toEqual([{ url: "/api/settings/display", method: "PUT", body: { textSize: "larger" } }]));
    expect(await within(display).findByText("Saved")).toBeTruthy();
    fireEvent.click(within(display).getByRole("radio", { name: "Standard" }));
    expect(document.documentElement.hasAttribute("data-text-size")).toBe(false);
    expect(document.cookie).not.toContain(`${TEXT_SIZE_COOKIE}=`);
  });

  it("says so when the size could not be saved with the person's login, and keeps showing it on this page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/settings") return json(payload);
        if (url === "/api/settings/display" && init?.method === "PUT") return json({ error: "Something on our side isn't ready yet." }, 503);
        return new Response(null, { status: 204 });
      }),
    );
    open();
    const display = screen.getByRole("region", { name: "Display" });
    fireEvent.click(within(display).getByRole("radio", { name: "Large" }));
    expect((await within(display).findByRole("alert")).textContent).toBe("Couldn't save your text size. Try again.");
    expect(document.documentElement.getAttribute("data-text-size")).toBe("large");
  });

  it("opens on the size the page is showing", () => {
    document.documentElement.setAttribute("data-text-size", "large");
    open();
    const display = screen.getByRole("region", { name: "Display" });
    expect(within(display).getByRole("radio", { name: "Large" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("opening and closing", () => {
  it("closes on Escape and on Close", () => {
    const { onClose } = open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("opens from the gear in the dashboard header, and from a link", async () => {
    render(<Dashboard initialSearch="" />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    cleanup();

    window.history.replaceState(null, "", "/?dl=settings");
    await act(async () => {
      render(<Dashboard initialSearch={window.location.search} />);
    });
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
    // The link is read once: the address keeps only the place.
    expect(window.location.search).toBe("");
  });
});
