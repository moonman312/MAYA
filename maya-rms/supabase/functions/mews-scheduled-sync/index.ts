import { createClient } from "npm:@supabase/supabase-js@2.99.3";
import { runMewsSyncForHotel } from "../_shared/mews/sync-hotel.ts";

function getEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v !== "" ? v : undefined;
}

function unauthorized(msg: string): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const cronSecret = getEnv("MEWS_CRON_SECRET");
  if (cronSecret) {
    const header = req.headers.get("x-mews-cron-secret");
    if (header !== cronSecret) {
      return unauthorized("Invalid or missing x-mews-cron-secret.");
    }
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: connRows, error: listErr } = await supabase
    .from("pms_connections")
    .select("hotel_id")
    .eq("pms_type", "mews");

  if (listErr) {
    return new Response(JSON.stringify({ ok: false, error: listErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const hotelIds = [...new Set((connRows ?? []).map((r) => r.hotel_id).filter(Boolean))] as string[];

  const results: {
    hotelId: string;
    result: Awaited<ReturnType<typeof runMewsSyncForHotel>>;
  }[] = [];

  for (const hotelId of hotelIds) {
    const result = await runMewsSyncForHotel(supabase, hotelId);
    results.push({ hotelId, result });
  }

  const failed = results.filter((r) => r.result.ok === false);

  return new Response(
    JSON.stringify({
      ok: failed.length === 0,
      hotels: hotelIds.length,
      failedHotels: failed.length,
      results,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
