const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function getSupabaseEnv() {
  return {
    supabaseUrl,
    supabasePublishableKey,
  };
}

export function isSupabaseConfigured(): boolean {
  // Reject placeholder / example values from .env.example
  const urlOk =
    typeof supabaseUrl === "string" &&
    supabaseUrl.startsWith("https://") &&
    supabaseUrl.includes(".supabase.co") &&
    !supabaseUrl.includes("your-project");
  const keyOk =
    typeof supabasePublishableKey === "string" &&
    supabasePublishableKey.length > 20 &&
    supabasePublishableKey !== "eyJ...";
  return urlOk && keyOk;
}
