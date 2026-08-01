import { createSignupCode, parseSignupCodeInput } from "@/lib/admin/signup-codes";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** POST — mint a code. Body mirrors the signup_codes columns. */
export async function POST(req: Request) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Checked here so a half-filled code comes back as a sentence instead of
  // chk_signup_code_shape.
  const parsed = parseSignupCodeInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    // The admin's own session, not service-role: the signup_codes RLS policy is
    // then a second lock on who can mint one.
    const created = await createSignupCode(ctx.ssr, parsed.row, {
      id: ctx.user.id,
      email: ctx.user.email ?? null,
    });
    return NextResponse.json({ ok: true, ...created });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create the code" },
      { status: 400 },
    );
  }
}
