import type { MetadataRoute } from "next";
import { docsPages } from "@/lib/docs/content";
import { APP_ORIGIN } from "@/lib/docs/site";

// The public pages: the docs and the support page. The app's own screens sit
// behind sign-in and are left out.
export default function sitemap(): MetadataRoute.Sitemap {
  const built = new Date();
  return [
    { url: `${APP_ORIGIN}/support`, lastModified: built, changeFrequency: "weekly", priority: 0.8 },
    { url: `${APP_ORIGIN}/docs`, lastModified: built, changeFrequency: "weekly", priority: 0.8 },
    ...docsPages.map((p) => ({
      url: `${APP_ORIGIN}${p.url}`,
      lastModified: p.updated ? new Date(`${p.updated}T00:00:00Z`) : built,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
