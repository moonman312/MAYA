import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    supabase_configured: isSupabaseConfigured(),
    mode: isSupabaseConfigured() ? "supabase_rls_session_mode" : "in_memory",
  });
}
