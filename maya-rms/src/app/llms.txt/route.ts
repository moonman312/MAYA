import { sectionsWithPages } from "@/lib/docs/content";
import { APP_ORIGIN, MARKETING_URL } from "@/lib/docs/site";

export const dynamic = "force-static";

// The docs index for AI assistants and answer engines (llmstxt.org), built
// from the same page list as the docs nav, so it can't drift from the pages.
function build(): string {
  const sections = sectionsWithPages()
    .map((s) => {
      const lines = s.pages.map((p) => `- [${p.title}](${APP_ORIGIN}${p.url}): ${p.summary}`);
      return `## ${s.label}\n\n${lines.join("\n")}`;
    })
    .join("\n\n");

  return `# MAYA docs

> Documentation for MAYA (Machine Assisted Yield Automation), rules-based revenue management software for independent hotels. The owner or revenue manager builds pricing rules from dropdowns, and MAYA applies them around the clock and sends the new prices to the hotel's property system. Made by Modern Hospitality Solutions LLC.

Product overview and pricing: ${MARKETING_URL} (summary for AI tools at ${MARKETING_URL}/llms.txt). Support: ${APP_ORIGIN}/support.

${sections}
`;
}

export function GET() {
  return new Response(build(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
