import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (isSupabaseConfigured()) {
    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-950">
      <header className="px-6 py-5">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <span className="text-lg font-semibold text-slate-100">MAYA</span>
          <form action="/auth/logout" method="post">
            <button
              type="submit"
              className="cursor-pointer text-xs text-slate-500 hover:text-slate-300"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pb-16">
        {children}
      </main>
    </div>
  );
}
