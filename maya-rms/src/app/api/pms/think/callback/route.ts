import { handleOAuthCallback } from "@/lib/pms/oauth-flow";
import { cookies } from "next/headers";

export async function GET(req: Request) {
  const url = new URL(req.url);
  return handleOAuthCallback(await cookies(), "think", url.searchParams);
}
