import { ImageResponse } from "next/og";
import { LOCKUP_RATIO, LOCKUP_SVG, SHARE_IMAGE } from "@/lib/docs/share";

export const alt = SHARE_IMAGE.alt;
export const size = { width: SHARE_IMAGE.width, height: SHARE_IMAGE.height };
export const contentType = "image/png";

const LOCKUP_HEIGHT = 150;
const lockupSrc = `data:image/svg+xml;base64,${Buffer.from(LOCKUP_SVG).toString("base64")}`;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 90px",
          background: "#020618",
          position: "relative",
        }}
      >
        <div style={{ position: "absolute", right: 90, bottom: 0, display: "flex", alignItems: "flex-end", gap: 34 }}>
          {[180, 270, 370].map((h) => (
            <div key={h} style={{ width: 70, height: h, borderRadius: 35, background: "#00A6F4", opacity: 0.14 }} />
          ))}
        </div>
        <img src={lockupSrc} width={LOCKUP_HEIGHT * LOCKUP_RATIO} height={LOCKUP_HEIGHT} alt="" style={{ marginLeft: -26 }} />
        <div style={{ marginTop: 28, fontSize: 56, fontWeight: 700, color: "#F1F5F9" }}>Docs and support</div>
        <div style={{ marginTop: 18, fontSize: 30, color: "#94a3b8", maxWidth: 640, lineHeight: 1.3 }}>
          Rules-based revenue management for independent hotels
        </div>
      </div>
    ),
    size,
  );
}
