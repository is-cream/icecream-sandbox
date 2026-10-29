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
