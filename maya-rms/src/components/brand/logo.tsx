import { useId } from "react";

/**
 * The MAYA mark and lockup as inline SVG, geometry lifted straight from
 * logos/maya-icon.svg and logos/maya-lockup-transparent.svg. Both are drawn
 * for dark backgrounds; the on-light and mono variants live under
 * public/brand/ as plain files because nothing in the app renders on white.
 *
 * The lockup paints no ground of its own. It sits on slate-950 pages and on
 * slate-900 cards (login, accept-invite), and the #020618 rect the non-
 * transparent file carries would show as a darker slab inside those cards.
 *
 * The name rides on aria-label rather than a <title> child: a <title> is what
 * paints a browser tooltip, and a tooltip reading "MAYA" on every hover of the
 * header logo is noise. Screen readers take the label from role="img" either way.
 *
 * The mark's three back edges are cut short behind the bars with a <mask>.
 * A mask is referenced by id, and the same id twice on one page makes every
 * copy after the first share whichever mask the browser found first, so the
 * id is minted per instance. No "use client": useId works in both worlds.
 */

const LINE = "#F1F5F9";
const BAR = "#00A6F4";

type Bar = { x: string; y: string; width: string; height: string; rx: string };

/* logos/maya-icon.svg: 200-unit mark scaled 2.56x into a 512 box. */
const MARK_VIEWBOX = "0 0 512 512";
const MARK_HEX = "M100.00 8.00 L179.67 54.00 L179.67 146.00 L100.00 192.00 L20.33 146.00 L20.33 54.00 Z";
const MARK_SPOKES = ["M100.00 100.00 L100.00 8.00", "M100.00 100.00 L179.67 146.00", "M100.00 100.00 L20.33 146.00"];
const MARK_BARS: Bar[] = [
  { x: "63.80", y: "109.20", width: "18.00", height: "36.80", rx: "9.00" },
  { x: "91.00", y: "90.80", width: "18.00", height: "55.20", rx: "9.00" },
  { x: "118.20", y: "70.56", width: "18.00", height: "75.44", rx: "9.00" },
];

/* logos/maya-lockup-transparent.svg: 145-unit mark at (40,40), wordmark at (211,62.5). */
const LOCKUP_WIDTH = 695.31;
const LOCKUP_HEIGHT = 225.0;
const LOCKUP_VIEWBOX = "0 0 695.31 225.0";
const LOCKUP_HEX = "M72.50 5.80 L130.26 39.15 L130.26 105.85 L72.50 139.20 L14.74 105.85 L14.74 39.15 Z";
const LOCKUP_SPOKES = ["M72.50 72.50 L72.50 5.80", "M72.50 72.50 L130.26 105.85", "M72.50 72.50 L14.74 105.85"];
const LOCKUP_BARS: Bar[] = [
  { x: "46.26", y: "79.17", width: "13.05", height: "26.68", rx: "6.52" },
  { x: "65.97", y: "65.83", width: "13.05", height: "40.02", rx: "6.52" },
  { x: "85.69", y: "51.16", width: "13.05", height: "54.69", rx: "6.52" },
];
const WORDMARK =
  "M10.932944606413995 100.0V-0.14577259475218796H48.9795918367347L61.078717201166185 44.46064139941691Q61.80758017492712 46.79300291545189 62.82798833819243 50.80174927113703Q63.84839650145773 54.81049562682215 64.86880466472303 59.183673469387756Q65.88921282798835 63.55685131195335 66.61807580174927 67.05539358600583H67.78425655976676Q68.36734693877551 64.28571428571428 69.24198250728864 60.42274052478133Q70.11661807580175 56.559766763848394 71.13702623906707 52.25947521865889Q72.15743440233237 47.95918367346938 73.03206997084548 44.31486880466472L85.27696793002916 -0.14577259475218796H122.30320699708456V100.0H96.93877551020408V57.28862973760933Q96.93877551020408 51.0204081632653 97.01166180758017 44.60641399416909Q97.08454810495627 38.19241982507288 97.23032069970846 32.944606413994165Q97.37609329446065 27.69679300291544 97.37609329446065 25.364431486880463H96.20991253644316Q95.77259475218659 27.551020408163268 94.82507288629738 31.705539358600582Q93.87755102040816 35.860058309037896 92.78425655976676 40.30612244897959Q91.69096209912537 44.75218658892128 90.81632653061224 47.95918367346938L76.23906705539359 100.0H55.24781341107872L40.524781341107875 47.95918367346938L38.775510204081634 40.96209912536443Q37.755102040816325 36.880466472303205 36.80758017492711 32.65306122448979Q35.8600583090379 28.42565597667638 35.13119533527697 25.51020408163265H33.965014577259474Q34.11078717201166 29.300291545189495 34.25655976676385 34.766763848396494Q34.40233236151604 40.23323615160349 34.54810495626822 46.137026239067055Q34.69387755102041 52.04081632653061 34.69387755102041 57.28862973760933V100.0ZM137.31778425655978 100.0 174.9271137026239 -0.14577259475218796H206.268221574344L243.87755102040816 100.0H216.03498542274053L210.05830903790087 82.65306122448979H170.11661807580174L164.1399416909621 100.0ZM176.38483965014578 63.11953352769679H203.64431486880466L196.50145772594752 41.98250728862973Q195.9183673469388 40.37900874635568 195.11661807580177 37.9737609329446Q194.31486880466474 35.56851311953352 193.5131195335277 32.87172011661807Q192.7113702623907 30.174927113702623 191.98250728862973 27.405247813411073Q191.2536443148688 24.635568513119523 190.52478134110788 22.59475218658892H189.50437317784258Q188.92128279883383 25.364431486880463 187.90087463556853 28.862973760932945L185.71428571428572 35.860058309037896Q184.54810495626822 39.35860058309038 183.67346938775512 41.98250728862973ZM275.80174927113706 100.0V60.349854227405245L236.58892128279885 -0.14577259475218796H266.7638483965015L289.2128279883382 37.31778425655976H289.94169096209913L312.2448979591837 -0.14577259475218796H340.8163265306123L302.0408163265306 60.349854227405245V100.0ZM333.8192419825073 100.0 371.42857142857144 -0.14577259475218796H402.76967930029156L440.3790087463557 100.0H412.5364431486881L406.5597667638484 82.65306122448979H366.6180758017493L360.6413994169096 100.0ZM372.8862973760933 63.11953352769679H400.1457725947522L393.0029154518951 41.98250728862973Q392.41982507288634 40.37900874635568 391.61807580174934 37.9737609329446Q390.8163265306123 35.56851311953352 390.01457725947523 32.87172011661807Q389.21282798833823 30.174927113702623 388.4839650145773 27.405247813411073Q387.7551020408164 24.635568513119523 387.0262390670554 22.59475218658892H386.0058309037901Q385.4227405247814 25.364431486880463 384.4023323615161 28.862973760932945L382.21574344023327 35.860058309037896Q381.04956268221576 39.35860058309038 380.17492711370267 41.98250728862973Z";

type MarkGeometry = {
  hex: string;
  spokes: string[];
  bars: Bar[];
  /** Stroke of the box edges. */
  stroke: string;
  /** Stroke on the mask rects: bar width plus the gap either side of it. */
  gap: string;
  /** Mask extent (the mark's own unit box). */
  extent: string;
};

const MARK_GEOMETRY: MarkGeometry = {
  hex: MARK_HEX,
  spokes: MARK_SPOKES,
  bars: MARK_BARS,
  stroke: "9.00",
  gap: "16.20",
  extent: "200",
};

const LOCKUP_GEOMETRY: MarkGeometry = {
  hex: LOCKUP_HEX,
  spokes: LOCKUP_SPOKES,
  bars: LOCKUP_BARS,
  stroke: "6.52",
  gap: "11.74",
  extent: "145.0",
};

/** Box outline, masked back edges, then the bars on top. Shared by both marks. */
function MarkBody({ maskId, g }: { maskId: string; g: MarkGeometry }) {
  return (
    <>
      <path d={g.hex} fill="none" stroke={LINE} strokeWidth={g.stroke} strokeLinejoin="round" />
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={g.extent} height={g.extent}>
        <rect width={g.extent} height={g.extent} fill="#fff" />
        {g.bars.map((b) => (
          <rect key={b.x} {...b} fill="#000" stroke="#000" strokeWidth={g.gap} />
        ))}
      </mask>
      <g mask={`url(#${maskId})`}>
        {g.spokes.map((d) => (
          <path key={d} d={d} stroke={LINE} strokeWidth={g.stroke} strokeLinecap="round" />
        ))}
      </g>
      {g.bars.map((b) => (
        <rect key={b.x} {...b} fill={BAR} />
      ))}
    </>
  );
}

export function MayaMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  const id = useId();
  const maskId = `maya-mark-${id}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={MARK_VIEWBOX}
      width={size}
      height={size}
      role="img"
      aria-label={title ?? "MAYA"}
      className={className}
    >
      <g transform="scale(2.56)">
        <MarkBody maskId={maskId} g={MARK_GEOMETRY} />
      </g>
    </svg>
  );
}

export function MayaLockup({
  height = 32,
  className,
  title,
}: {
  height?: number;
  className?: string;
  title?: string;
}) {
  const id = useId();
  const maskId = `maya-lockup-${id}`;
  const width = Math.round((height * LOCKUP_WIDTH * 100) / LOCKUP_HEIGHT) / 100;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={LOCKUP_VIEWBOX}
      width={width}
      height={height}
      role="img"
      aria-label={title ?? "MAYA"}
      className={className}
    >
      <g transform="translate(40,40)">
        <MarkBody maskId={maskId} g={LOCKUP_GEOMETRY} />
      </g>
      <g transform="translate(211.00,62.50)">
        <path d={WORDMARK} fill={LINE} />
      </g>
    </svg>
  );
}
