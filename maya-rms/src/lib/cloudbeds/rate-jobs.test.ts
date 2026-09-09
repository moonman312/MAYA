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
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsGetRateJobs: getRateJobs,
  cloudbedsGetRatePlans: vi.fn(),
  cloudbedsPatchRate: vi.fn(),
}));

const { createCloudbedsRateAdapter } = await import(
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
