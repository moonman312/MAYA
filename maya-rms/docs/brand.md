# The MAYA mark

An isometric wireframe box seen from the front, with three rounded sky bars
standing on its floor. The Y is the far corner. The wordmark is Archivo
ExtraBold, already outlined to paths, so nothing here needs a font installed.

Colours are the app's own tokens:

| | |
|---|---|
| lines and wordmark | `#F1F5F9` |
| bars | `#00A6F4` |
| ground | `#020618` |

## Where things live

`logos/` is the source of truth and the only place the files are edited.
Everything the app serves is a byte copy of it; never hand-edit a copy or
re-export it through another tool.

| Path | What |
|---|---|
| `src/app/icon.svg`, `apple-icon.png` | Picked up by Next's metadata file conventions and linked into `<head>` automatically. Both are the dark tile, not the bare mark: the mark's near-white edges vanish against a light tab strip |
| `public/favicon.ico` | The fallback for browsers that ignore the linked SVG; they fetch `/favicon.ico` on their own. It cannot live in `src/app/`: Turbopack decodes app icons at build time and its ICO reader rejects PNG-in-ICO entries that are RGB rather than RGBA |
| `src/app/manifest.ts` | The web manifest; its tiles are `public/brand/icon-192.png` and `icon-512.png` |
| `public/brand/*.svg` | Every SVG variant, served at `/brand/<file>` |
| `public/brand/maya-lockup-email.png` | The 2x transparent lockup (1392 x 450) that heads every email |
| `src/components/brand/logo.tsx` | `MayaMark` and `MayaLockup`, the inline versions for the UI |

## Which file on which background

| Background | Mark alone | With wordmark |
|---|---|---|
| Dark (`#020618`, slate-950) | `maya-icon.svg` | `maya-lockup.svg` (carries its own dark ground) or `maya-lockup-transparent.svg` |
| White | `maya-icon-on-light.svg` | `maya-lockup-on-light.svg` |
| Anything, one colour | `maya-icon-mono.svg` | |
| App tiles and favicons | `maya-app-icon.svg` (dark tile), `maya-app-icon-sky.svg` (sky tile, dark mark), `maya-app-icon-square.svg` (square, the favicon source) | |
| Vertical layouts | | `maya-stacked.svg` |

The app is dark-only, so in practice the UI reaches for the dark variants and
the on-light files exist for decks, documents and partners.

## Two rules

**Clear space.** Keep at least one bar width clear around the mark on every
side. That is about 9% of the mark's height: 2 px on a 24 px mark, 4 px on
a 40 px mark. Nothing else, including text, sits inside that band.

**Minimum size.** The bare mark holds down to 24 px. Below that the thin box
edges fall apart, so switch to the app-icon tile, which stays legible to
16 px. The lockup's own floor is 32 px: its mark is 64% of the lockup height,
and rendering the set at 1x showed the box edges fusing into a grey blob at
22 and 24 px and only coming clean at 32. The wordmark stays legible well
below that, so trust the mark, not the letters, when judging a size.

The manifest tiles are deliberately not marked `maskable`. The mark fills 80%
of the tile, which leaves about 7 px between its vertices and the circle a
launcher may crop to, where the clear-space rule wants roughly 37 px. The
tile's own dark ground is the framing.

## In the UI

```tsx
import { MayaMark, MayaLockup } from "@/components/brand/logo";

<MayaMark />                              // 24 px, the minimum
<MayaMark size={32} className="shrink-0" />
<MayaLockup />                            // 32 px high, the floor; width follows
<MayaLockup height={40} title="MAYA home" />
```

Both are plain inline SVG with `role="img"` and an `aria-label` (default
`MAYA`; a `<title>` would paint a tooltip on every hover),
so they work in server and client components alike and read correctly to a
screen reader. `MayaLockup` takes a `height`; its width comes from the source
aspect ratio (about 3.09 : 1). Colours are baked in as the hex values above,
not `currentColor`, so a hover or text-colour utility on a parent will not
recolour them, which is the point.

Two or more on one page are fine: each instance mints its own mask id, so the
cut-outs behind the bars never bleed between copies.

`MayaLockup` renders the `maya-lockup-transparent.svg` geometry and paints no
ground of its own, so it sits on slate-950 pages and slate-900 cards alike.
`maya-lockup.svg`, with its `#020618` ground baked in, is for places that need
a self-contained image (decks, partner kits), not the UI.

## In email

Email clients strip inline SVG, so templates use the PNG:

```
${baseUrl}/brand/maya-lockup-email.png
```

rendered at 140 x 45 with explicit `width` and `height` attributes (Outlook
sizes from those, not CSS). `src/lib/email/brand.ts` builds the header cell
and falls back to a text wordmark when there is no absolute origin to serve
the image from.
