import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseEnv } from "@/utils/supabase/shared";

export async function updateSession(request: NextRequest) {
  const { supabaseUrl, supabasePublishableKey } = getSupabaseEnv();
  if (!supabaseUrl || !supabasePublishableKey) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Refreshes an expired session and writes the new cookies; nothing here
  // decides who may see what (every page and route checks for itself).
  // getClaims verifies the token against the project's published keys instead
  // of asking the Auth server on every request and every client navigation;
  // with a shared-secret project it asks the server, as getUser did.
  await supabase.auth.getClaims();
  return response;
}
