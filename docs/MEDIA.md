# README media provenance

`media/trailer.gif` is the existing 480×270, approximately 8.3 MiB Chrome showcase.
Git last changed it at `c1e427cff6b5a4b61716695de8fe482eb6d2794e` on 2026-09-24.
It shows the historical brick-ring/joints/columns demonstrations; it is not a capture of
`review-20261106-1` or the current dirty source. Original render device/settings and full
capture chain were not independently reverified in this documentation pass. Original upstream
project media is retained; no generated mockup, repainted branding or new asset is substituted.

The README labels this historical footage. A current exact-build screenshot/short capture and
visible-interface check remain release-page acceptance work under STE-3003, subject to actual
hardware/device and capture authorization. That gap does not prevent accurate setup instructions.
Hosted demos are linked for discovery; deployment/source parity has not been checked here.


## November 7 baseline identity

`public/favicon.svg` is the existing editable SVG stacked-body mark, reused without raster
embedding. `public/brand-banner.svg` reuses its shapes and colors with a high-contrast product
name/subtitle; this is code-native vector branding, not image-model output or a product screenshot.
The README and 3D/2D/SDF/example-index boundaries use the same name and mark. The standalone
consumer remains a minimal developer-owned scene rather than acquiring an app shell.


## Current basic example — captured 2026-11-07 18:31 UTC

`media/basic-20261107.png`: actual local `/examples/basic.html`, base main61a0f710 plus
initialization/timing and baseline-identity overlay. Vite8.3.6 serves this canonical source;
1124×800 capture, browser WebGPU adapter vendor apple/Metal-3/non-fallback (model withheld).
The example initialized157live bodies at observation with native hull capability and async
World readback. Random sphere/rock setup is illustrative, not deterministic fixture output.
No private inputs or generated assets. The only console warning observed was Three.Clock's
existing deprecation; no console errors. This is a bounded real render, not a throughput,
large-scene stability or cross-platform qualification. The examples-index identity/loaded
SVG was also inspected locally. Historical GIF remains preserved above, no longer loaded
as the primary README preview.
