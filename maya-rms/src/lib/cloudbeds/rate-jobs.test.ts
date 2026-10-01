/**
 * patchRate is asynchronous: a 200 means the job was QUEUED. Cloudbeds names
 * validating those jobs mandatory for RMS integrations, and the reason is
 * sharp — MAYA's idempotency ledger treats a "sent" row as the last price the
 * PMS accepted, so a job that failed after acceptance would both report a rate
 * as live and suppress every future retry of that cell.
 *
 * Verified live 2026-09-08: getRateJobs returns
 * { jobReferenceID, dateCreated, status: "completed", updates: [{ ..., message }] }
 * within about four seconds of the push.
 */
import { describe, expect, it, vi } from "vitest";

const getRateJobs = vi.hoisted(() => vi.fn());
const patchRate = vi.hoisted(() => vi.fn());
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsGetRateJobs: getRateJobs,
  cloudbedsGetRatePlans: vi.fn(),
  cloudbedsPatchRate: patchRate,
}));

const { createCloudbedsRateAdapter, rateIntervalRuns, jobOutcome, JOB_LOOKUPS_PER_CALL, JOB_LOOKUPS_PER_TICK } = await import(
  "../../../supabase/functions/_shared/cloudbeds/rate-push"
);
const CREDS = { accessToken: "t", tokenType: "Bearer", baseUrl: "https://api.test", propertyId: "P1" } as never;

describe("cloudbeds fetchJobOutcomes", () => {
  it("confirms a completed job with no per-update message", async () => {
    getRateJobs.mockResolvedValue([
      { jobReferenceID: "J1", status: "completed", dateCreated: null, updates: [{ rateID: "R", message: "" }] },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchJobOutcomes!(["J1"])).toEqual({ J1: { done: true, ok: true } });
  });

  it("treats a completed job carrying an update message as a REJECTION", async () => {
    // The envelope says completed while an individual rate inside it failed —
    // trusting the envelope alone is exactly how a bad rate looks live forever.
    getRateJobs.mockResolvedValue([
      {
        jobReferenceID: "J1",
        status: "completed",
        dateCreated: null,
        updates: [{ rateID: "R", message: "Rate plan is closed for this date" }],
      },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchJobOutcomes!(["J1"])).toEqual({
      J1: { done: true, ok: false, message: "Rate plan is closed for this date" },
    });
  });

  it("marks an explicitly failed job as rejected", async () => {
    getRateJobs.mockResolvedValue([
      { jobReferenceID: "J1", status: "failed", dateCreated: null, updates: [] },
    ]);
    const out = await createCloudbedsRateAdapter(CREDS).fetchJobOutcomes!(["J1"]);
    expect(out.J1).toMatchObject({ done: true, ok: false });
  });

  it("leaves a still-running job undecided rather than guessing", async () => {
    getRateJobs.mockResolvedValue([
      { jobReferenceID: "J1", status: "processing", dateCreated: null, updates: [] },
    ]);
    expect(await createCloudbedsRateAdapter(CREDS).fetchJobOutcomes!(["J1"])).toEqual({
      J1: { done: false, ok: false },
    });
  });

  it("ignores other properties' jobs in the same list", async () => {
    getRateJobs.mockResolvedValue([
      { jobReferenceID: "SOMEONE_ELSE", status: "completed", dateCreated: null, updates: [] },
    ]);
    expect(await createCloudbedsRateAdapter(CREDS).fetchJobOutcomes!(["J1"])).toEqual({});
  });
});

/**
 * What Cloudbeds documents for getRateJobs: status in_progress, completed or
 * error ("an error with 1 or more updates requested in this job"), and per
 * update an action (in_progress, updated, created, error) with the reason in
 * message. A job with one bad night reports that night only (audit A18).
 */
describe("jobOutcome, night by night", () => {
  const update = (startDate: string, endDate: string, action: string, message: string | null = null) => ({
    rateID: "R1",
    action,
    startDate,
    endDate,
    rate: 210,
    message,
  });

  it("reports each stretch of an error job, so only the rejected nights fail", () => {
    const out = jobOutcome({
      jobReferenceID: "J1",
      status: "error",
      dateCreated: null,
      updates: [
        update("2026-10-01", "2026-10-01", "updated"),
        update("2026-10-02", "2026-10-02", "error", "Rate is closed for this date"),
        update("2026-10-03", "2026-10-03", "created"),
      ],
    });
    expect(out).toEqual({
      done: true,
      ok: false,
      message: "Rate is closed for this date",
      intervals: [
        { startDate: "2026-10-01", endDate: "2026-10-01", ok: true },
        { startDate: "2026-10-02", endDate: "2026-10-02", ok: false, message: "Rate is closed for this date" },
        { startDate: "2026-10-03", endDate: "2026-10-03", ok: true },
      ],
    });
  });

  it("does the same for a completed envelope carrying a failed update", () => {
    const out = jobOutcome({
      jobReferenceID: "J1",
      status: "completed",
      dateCreated: null,
      updates: [update("2026-10-01", "2026-10-04", "updated"), update("2026-10-05", "2026-10-05", "updated", "Past the loaded rates")],
    });
    expect(out.ok).toBe(false);
    expect(out.intervals?.map((i) => i.ok)).toEqual([true, false]);
  });

  it("never counts an update still in progress, or an error without words, as applied", () => {
    const out = jobOutcome({
      jobReferenceID: "J1",
      status: "error",
      dateCreated: null,
      updates: [update("2026-10-01", "2026-10-01", "in_progress"), update("2026-10-02", "2026-10-02", "error")],
    });
    expect(out.intervals).toEqual([
      { startDate: "2026-10-01", endDate: "2026-10-01", ok: false, message: "job error" },
      { startDate: "2026-10-02", endDate: "2026-10-02", ok: false, message: "job error" },
    ]);
  });

  it("fails the whole job when an update names no nights, or there are no updates", () => {
    expect(
      jobOutcome({ jobReferenceID: "J1", status: "error", dateCreated: null, updates: [{ rateID: "R1", action: "error", message: "bad" }] }),
    ).toEqual({ done: true, ok: false, message: "bad" });
    expect(jobOutcome({ jobReferenceID: "J1", status: "error", dateCreated: null, updates: [] })).toEqual({
      done: true,
      ok: false,
      message: "job error",
    });
  });

  it("confirms a completed job whose updates all applied", () => {
    expect(
      jobOutcome({ jobReferenceID: "J1", status: "completed", dateCreated: null, updates: [update("2026-10-01", "2026-10-01", "updated", "")] }),
    ).toEqual({ done: true, ok: true });
  });
});

describe("a job missing from the recent list (audit A17)", () => {
  it("is asked about by its reference", async () => {
    getRateJobs.mockReset();
    getRateJobs.mockImplementation(async (_creds: unknown, opts?: { jobReferenceID?: string }) =>
      opts?.jobReferenceID === "J2"
        ? [{ jobReferenceID: "J2", status: "completed", dateCreated: null, updates: [] }]
        : [{ jobReferenceID: "J1", status: "completed", dateCreated: null, updates: [] }],
    );
    const out = await createCloudbedsRateAdapter(CREDS).fetchJobOutcomes!(["J1", "J2", "J3"]);
    expect(out).toEqual({ J1: { done: true, ok: true }, J2: { done: true, ok: true } });
    expect(getRateJobs.mock.calls.map((c) => c[1]?.jobReferenceID ?? null)).toEqual([null, "J2", "J3"]);
  });

  it("asks about only a few per call, and a bounded number per tick", async () => {
    getRateJobs.mockReset();
    getRateJobs.mockResolvedValue([]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    const refs = Array.from({ length: 50 }, (_, i) => `J${i}`);
    await adapter.fetchJobOutcomes!(refs);
    expect(getRateJobs).toHaveBeenCalledTimes(1 + JOB_LOOKUPS_PER_CALL);
    for (let i = 0; i < 5; i++) await adapter.fetchJobOutcomes!(refs);
    const lookups = getRateJobs.mock.calls.filter((c) => c[1]?.jobReferenceID).length;
    expect(lookups).toBe(JOB_LOOKUPS_PER_TICK);
    // A fresh tick (a new adapter) may ask again.
    getRateJobs.mockClear();
    await createCloudbedsRateAdapter(CREDS).fetchJobOutcomes!(refs);
    expect(getRateJobs).toHaveBeenCalledTimes(1 + JOB_LOOKUPS_PER_CALL);
  });
});

describe("rateIntervalRuns", () => {
  const cell = (stayDate: string, price: number) => ({ stayDate, roomTypeId: "rt", externalRoomTypeId: "X", price });

  it("unmerged, sends one night per interval, as before", () => {
    const cells = [cell("2026-08-01", 100), cell("2026-08-02", 100)];
    expect(rateIntervalRuns(cells, false).map((r) => r.interval)).toEqual([
      { startDate: "2026-08-01", endDate: "2026-08-01", rate: 100 },
      { startDate: "2026-08-02", endDate: "2026-08-02", rate: 100 },
    ]);
  });

  it("merged, expands back to exactly the cells it was given, price for price", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const cells = [];
    for (let d = 0; d < 400; d++) {
      if (rnd() < 0.2) continue; // gaps break a run
      const day = new Date(Date.UTC(2026, 7, 1) + d * 86_400_000).toISOString().slice(0, 10);
      cells.push(cell(day, rnd() < 0.7 ? 150 : 150 + Math.floor(rnd() * 3)));
    }
    const shuffled = [...cells].sort(() => rnd() - 0.5);
    const runs = rateIntervalRuns(shuffled, true);
    const expanded: { stayDate: string; price: number }[] = [];
    for (const run of runs) {
      let d = run.interval.startDate;
      for (;;) {
        expanded.push({ stayDate: d, price: run.interval.rate });
        if (d === run.interval.endDate) break;
        d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      }
      expect(run.cells.map((c) => c.stayDate)).toEqual(expanded.slice(-run.cells.length).map((e) => e.stayDate));
    }
    expect(expanded).toEqual(cells.map((c) => ({ stayDate: c.stayDate, price: c.price })));
    expect(runs.length).toBeLessThan(cells.length);
  });
});

describe("cloudbeds pushCells against a deadline", () => {
  it("checks the deadline before every patchRate call, and hands back the cells it never started as deferred", async () => {
    // 45 nights on one rate: two calls of up to 30 intervals.
    const cells = Array.from({ length: 45 }, (_, i) => ({
      stayDate: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10),
      roomTypeId: "rt-1",
      externalRoomTypeId: "RT1",
      price: 200 + i,
      externalRateId: "R1",
    }));
    let clock = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    patchRate.mockReset();
    patchRate.mockImplementation(async () => {
      clock += 5_000; // a slow call, past the deadline once it returns
      return { ok: true, jobReferenceID: "J1" };
    });

    const results = await createCloudbedsRateAdapter(CREDS, false).pushCells(cells, { deadlineAt: 3_000 });
    now.mockRestore();

    expect(patchRate).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(45);
    expect(results.filter((r) => r.ok && r.jobReference === "J1")).toHaveLength(30);
    const deferred = results.filter((r) => r.deferred);
    expect(deferred).toHaveLength(15);
    expect(deferred.every((r) => !r.ok && r.error === undefined)).toBe(true);
    expect(deferred[0].cell.stayDate).toBe("2026-10-31");
  });

  it("makes every call when there is no deadline", async () => {
    patchRate.mockReset();
    patchRate.mockResolvedValue({ ok: true, jobReferenceID: "J2" });
    const cells = [
      { stayDate: "2026-10-01", roomTypeId: "a", externalRoomTypeId: "RT1", price: 100, externalRateId: "R1" },
      { stayDate: "2026-10-01", roomTypeId: "b", externalRoomTypeId: "RT2", price: 120, externalRateId: "R2" },
    ];
    const results = await createCloudbedsRateAdapter(CREDS, false).pushCells(cells);
    expect(patchRate).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.ok && !r.deferred)).toBe(true);
  });
});
