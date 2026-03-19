import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  if (isSupabaseConfigured()) {
    const supabase = createClient(await cookies());
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.url));
}
