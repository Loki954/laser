# SculpFun Studio

A better phone app for SculpFun laser engravers. It runs in Chrome on Android, connects over Bluetooth, and updates itself.

**Open the app:** https://loki954.github.io/laser/ (then Chrome menu → *Add to Home screen*)

## What it does
- **Engrave or cut**: choose per object — Engrave (filled), Engrave lines (outline only), or Cut (follows the lines, several passes).
- **Cut around**: switch on for any text/image/shape to cut it out as a heart, circle, oval, rectangle, rounded rectangle, hexagon, star, shield — or a contour that follows the outline with a margin.
- **Draw cut lines**: tap points (Lines) or draw freehand (Draw). Shapes: rectangle, rounded rectangle, circle/oval, heart, star, polygon, triangle, shield, cross.
- **Text**: 21 built-in fonts with Cyrillic, multi-line, spacing, your own .ttf/.otf fonts.
- **Images**: Floyd–Steinberg, Atkinson, Jarvis, Stucki, Sierra, ordered, black & white or grayscale, with brightness/contrast/gamma/sharpen/invert.
- **SVG import** (as cut/line paths).
- **Machine control**: jog, set start point, weak laser dot, air assist, unlock, home, console.
- **Run**: preview path + time estimate, frame (box), trace outline, upload to the engraver and run (same method as the official app) or stream live, pause/resume/stop.
- **Material presets** and a **material test** grid generator; save your own presets.
- Works offline, saves your design automatically, projects can be saved/opened as files, G-code export.

## Connecting
1. Pair the engraver once in Android **Settings → Bluetooth** (name starts with `SculpFun`). Close the official app.
2. In the app: **Machine → Bluetooth** and pick the engraver. Needs Chrome 138+ on Android (Web Serial over Bluetooth).
3. If your model uses Bluetooth LE instead, use **Bluetooth LE**.
4. **Demo** lets you try everything without a laser.

## Automatic updates
Every push to `main` is deployed by GitHub Actions (`.github/workflows/deploy.yml`) to GitHub Pages and the version number goes up. The installed app checks for a new version on start, when you return to it, and every 15 minutes, and reloads itself (it waits while connected to the laser and shows an *Update now* bar instead).

One-time setup: repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. GitHub Pages on a private repository needs a paid plan; on the free plan make the repository public.

## Safety
Wear laser safety glasses, never leave the engraver unattended, keep a fire extinguisher nearby. Material presets are only starting points — run a material test first.

## Protocol notes (from the official app 1.3.43)
- Bluetooth Classic SPP (Feasycom module); BLE Nordic UART UUIDs also supported.
- Grbl_ESP32-style firmware, S range 0–1000, laser mode `M4`.
- Upload: `[ESP486]/name.nc` → `ok` → header `0A A0 <len u32 BE>` → `ok` → 4096-byte chunks each acked by `ok` → `A0 0A` → `ok`; run with `G92 X0 Y0` + `[ESP220]/name.nc`. Progress from `SD:<pct>,<file>` in status reports.
