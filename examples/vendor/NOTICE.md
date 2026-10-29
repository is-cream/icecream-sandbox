# Vendored third-party code

`d3-format.mjs` is the real published build of
[d3-format](https://github.com/d3/d3-format) version 3.1.2, downloaded
byte-identical from the jsDelivr ESM bundle
(`https://cdn.jsdelivr.net/npm/d3-format@3.1.2/+esm`). It is vendored
here — not retyped, not modified — so the import tests and the
import-package example run without internet access.

- Author: Mike Bostock and the D3 contributors.
- License: BSD 3-Clause License. Full text:
  https://github.com/d3/d3-format/blob/main/LICENSE
- Purpose: the import downloader's tests and example import this real
  package (its `format` function) and assert on real computed output,
  proving module downloads execute genuine third-party code — not a
  toy stub.

In production use, an app would point its import map at a CDN instead
of a vendored file. The download mechanism is identical either way:
the host fetches through the connection gate, with one approval per
origin and caching after the first import.

## chart.js.mjs — Chart.js 4.6.1

Byte-identical ESM bundle downloaded from
https://cdn.jsdelivr.net/npm/chart.js@4.6.1/+esm on 2026-10-28.
Chart.js is (c) Chart.js Contributors, MIT License
(https://github.com/chartjs/Chart.js/blob/master/LICENSE.md).

## kurkle-color.mjs — @kurkle/color 0.3.4

Byte-identical ESM bundle downloaded from
https://cdn.jsdelivr.net/npm/@kurkle/color@0.3.4/+esm on 2026-10-28.
It is the color dependency jsDelivr's Chart.js bundle imports.
@kurkle/color is (c) Evert Timberg, MIT License.

## uplot.mjs — uPlot 1.6.32

Byte-identical ESM bundle downloaded from
https://cdn.jsdelivr.net/npm/uplot@1.6.32/+esm on 2026-10-28.
uPlot is (c) Leon Sorokin, MIT License
(https://github.com/leeoniya/uPlot/blob/master/LICENSE).

## chartist.mjs — Chartist 1.3.1

Byte-identical ESM bundle downloaded from
https://cdn.jsdelivr.net/npm/chartist@1.3.1/+esm on 2026-10-28.
Chartist.js is (c) Gion Kunz, MIT License
(https://github.com/gionkunz/chartist-js/blob/main/LICENSE).
