/**
 * The one way a person's "counts as a room" answer is written.
 *
 * Both the room-type settings PATCH and the onboarding review card land here,
 * so the two leave identical paperwork: the row carries who decided
 * (counts_as_room_set_by — the import heuristic leaves it null), and the
 * audit line carries before/after and the real actor, because the flag
 * lowers the bill and platform_log_event only sees auth.uid(), which is null
 * on the service role.
 *
 * Deploy order must not matter. Ahead of the whole migration the column is
 * not there and the caller hears "pre_migration"; ahead of only the re-run
 * that added counts_as_room_set_by, the flag is written without provenance
 * and the log says so.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "../../../../supabase/functions/_shared/onboarding/analysis";
import { isPreMigration } from "./reprice";

export type ClassifyVia = "settings" | "onboarding_review";

export type ClassifyOutcome =
  | { kind: "changed"; before: boolean | null; name: string }
  /** Same value, but it was the heuristic's guess and is now the owner's word: stamped and audited, no re-price. */
  | { kind: "confirmed"; before: boolean | null; name: string }
  | { kind: "unchanged"; before: boolean | null; name: string }
  | { kind: "not_found" }
  | { kind: "pre_migration" }
  | { kind: "error"; message: string };

export async function classifyRoomType(
  admin: SupabaseClient,
  args: {
    hotelId: string;
    roomTypeId: string;
    countsAsRoom: boolean;
    actorUserId: string;
    via: ClassifyVia;
  },
): Promise<ClassifyOutcome> {
  const { hotelId, roomTypeId, countsAsRoom, actorUserId, via } = args;

  type BeforeRow = { id: unknown; name?: unknown; display_name?: unknown; counts_as_room?: unknown; counts_as_room_set_by?: unknown };
  const read = (columns: string) =>
    admin.from("room_types").select(columns).eq("id", roomTypeId).eq("hotel_id", hotelId).maybeSingle();
  // Ahead of the re-run that added set_by, provenance simply is not known.
  let hasSetByColumn = true;
  let readRes = await read("id, name, display_name, counts_as_room, counts_as_room_set_by");
  if (readRes.error && isMissingColumnError(readRes.error, "counts_as_room_set_by")) {
    hasSetByColumn = false;
    readRes = await read("id, name, display_name, counts_as_room");
  }
  if (readRes.error) {
    if (isPreMigration(readRes.error)) return { kind: "pre_migration" };
    return { kind: "error", message: readRes.error.message };
  }
  const before = readRes.data as BeforeRow | null;
  if (!before) return { kind: "not_found" };

  const name = String(before.display_name || before.name || "");
  const previous = before.counts_as_room == null ? null : Boolean(before.counts_as_room);
  // The same value, already a person's: nothing to do. The same value as the
  // import's guess is different — the owner is standing behind it now, which
  // is what turns "we guessed" into "you marked" on the bill.
  const alreadyTheirs = previous === countsAsRoom && (!hasSetByColumn || before.counts_as_room_set_by != null);
  if (alreadyTheirs) return { kind: "unchanged", before: previous, name };
  const confirming = previous === countsAsRoom;

  const write = (patch: Record<string, unknown>) =>
    admin.from("room_types").update(patch).eq("id", roomTypeId).eq("hotel_id", hotelId);

  let { error: writeErr } = await write({ counts_as_room: countsAsRoom, counts_as_room_set_by: actorUserId });
  if (writeErr && isMissingColumnError(writeErr, "counts_as_room_set_by")) {
    console.warn(
      JSON.stringify({
        fn: "classifyRoomType",
        hotelId,
        warning:
          "room_types.counts_as_room_set_by is not in this database yet — re-run " +
          "99_supabase_migration_room_type_counts_as_room_v1.sql. The flag is written without who set it.",
      }),
    );
    ({ error: writeErr } = await write({ counts_as_room: countsAsRoom }));
  }
  if (writeErr) {
    if (isPreMigration(writeErr)) return { kind: "pre_migration" };
    return { kind: "error", message: writeErr.message };
  }

  const { error: logErr } = await admin.rpc("platform_log_event", {
    p_event_type: "room_type.classified",
    p_entity_type: "room_type",
    p_entity_id: roomTypeId,
    p_hotel_id: hotelId,
    p_detail: {
      room_type_id: roomTypeId,
      name,
      before: previous,
      after: countsAsRoom,
      via,
      actor_user_id: actorUserId,
      ...(confirming ? { confirmed_guess: true } : {}),
    },
  });
  if (logErr) {
    // The row already holds the answer; un-answering the owner over a missing
    // audit line would be the wrong trade. Logged so it is not lost.
    console.error(JSON.stringify({ fn: "classifyRoomType", step: "audit", hotelId, error: logErr.message }));
  }

  return { kind: confirming ? "confirmed" : "changed", before: previous, name };
}
