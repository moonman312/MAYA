import Link from "next/link";
import { Fragment, type ReactNode } from "react";

// Renders a docs passage as the helper stores it: paragraphs, "- " and "1."
// lists, "| a | b |" tables, **bold** and [links](/docs/...). Nothing else,
// so a passage can never carry markup of its own.

const SAFE_LINK = /^(\/docs(\/|#|$)|\/support(#|$)|https:\/\/www\.get-maya\.com\/(privacy|terms)(#|$)|mailto:)/;

function inline(text: string, pageUrl: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <strong key={`${key}-b${i++}`} className="font-semibold text-foreground">
          {m[1]}
        </strong>,
      );
    } else {
      let href = m[3];
      if (href.startsWith("#")) href = `${pageUrl}${href}`;
      if (SAFE_LINK.test(href)) {
        const cls = "font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary";
        out.push(
          href.startsWith("mailto:") ? (
            <a key={`${key}-l${i++}`} href={href} className={cls}>
              {m[2]}
            </a>
          ) : (
            <Link key={`${key}-l${i++}`} href={href} className={cls}>
              {m[2]}
            </Link>
          ),
        );
      } else {
        out.push(m[2]);
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ text, pageUrl }: { text: string; pageUrl: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-3 text-[0.9375rem] leading-relaxed">
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter((l) => l.trim() !== "");
        if (!lines.length) return null;
        if (lines.every((l) => l.trim().startsWith("|"))) {
          const rows = lines
            .filter((l) => !/^\|?\s*-{3,}/.test(l.trim()))
            .map((l) =>
              l
                .trim()
                .replace(/^\||\|$/g, "")
                .split("|")
                .map((c) => c.trim()),
            );
          const [head, ...body] = rows;
          return (
            <div key={bi} className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {head.map((c, ci) => (
                      <th key={ci} className="border-b border-border bg-muted/60 px-2.5 py-1.5 font-semibold">
                        {inline(c, pageUrl, `h${bi}${ci}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) => (
                        <td key={ci} className="border-b border-border/60 px-2.5 py-1.5 align-top">
                          {inline(c, pageUrl, `c${bi}${ri}${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        const isList = lines.every((l) => /^\s*(-|\d+\.)\s/.test(l));
        if (isList) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const items = lines.map((l) => l.replace(/^\s*(-|\d+\.)\s+/, ""));
          const List = ordered ? "ol" : "ul";
          return (
            <List key={bi} className={ordered ? "list-decimal space-y-1.5 pl-5" : "list-disc space-y-1.5 pl-5 marker:text-primary/60"}>
              {items.map((it, ii) => (
                <li key={ii}>{inline(it, pageUrl, `i${bi}${ii}`)}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 ? " " : null}
                {inline(l.replace(/^\s*(-|\d+\.)\s+/, ""), pageUrl, `p${bi}${li}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
