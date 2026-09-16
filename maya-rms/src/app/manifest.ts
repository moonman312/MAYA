import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MAYA",
    short_name: "MAYA",
    description: "Machine Assisted Yield Automation — revenue management for hotels",
    start_url: "/",
    display: "standalone",
    background_color: "#020618",
    theme_color: "#020618",
    // Neither tile is marked maskable. The mark fills 80% of the tile, which
    // puts its six vertices about 7 px inside the 40% safe-zone circle a
    // launcher is allowed to crop to, and the brand guide wants a full bar
    // width (~37 px at this size) clear around the mark. The tile's own dark
    // ground is the intended framing; a circular crop would crowd it.
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
