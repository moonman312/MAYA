# MAYA logo — final (I2e)

Mark: isometric wireframe box seen into from the front — hexagon silhouette, the Y is the far corner (floor + two back
walls) — with three rounded sky bars standing on the floor in front of it. Back edges stop with a clean gap behind each bar.
Wordmark: Archivo ExtraBold, +20 tracking, outlined to paths.

Colours (app tokens)   lines & wordmark #F1F5F9 · bars #00A6F4 · background #020618 · sky tile: mark in #020618
Fonts                   Archivo (SIL OFL) — wordmark is outlined, no font needed to use these files

Files
  maya-icon.svg                mark for dark backgrounds (transparent)
  maya-icon-mono.svg           one colour, #F1F5F9
  maya-icon-on-light.svg       for white backgrounds (lines #020618)
  maya-app-icon.svg            #020618 rounded tile        maya-app-icon-sky.svg   #00A6F4 tile, dark mark
  maya-app-icon-square.svg     square tile (favicon source)
  maya-lockup.svg / -transparent / -on-light   horizontal lockups
  maya-stacked.svg             icon above wordmark
  favicon.ico (16/32/48)  favicon-16/32/48/180/192/512.png
  every SVG also as PNG @2x and @6x
  nextjs-app/                  drop into app/: icon.svg, apple-icon.png, favicon.ico; icon-192/512 for manifest.ts

Clear space: keep at least the bar width (≈ 9% of icon height) clear around the mark.
Minimum size: 24 px for the full mark; below that use the app-icon tile, which holds up to 16 px.
