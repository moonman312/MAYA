import type { MetadataRoute } from "next";
import { APP_ORIGIN } from "@/lib/docs/site";

// The docs and support pages are public and worth finding. Links into the
// app (/go), its API and Command Center are not.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/go/", "/admin"] },
    sitemap: `${APP_ORIGIN}/sitemap.xml`,
  };
}
