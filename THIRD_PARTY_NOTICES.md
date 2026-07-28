# Third-party notices

This repository vendors one third-party library, unmodified except for
stripping a dangling `sourceMappingURL` comment (no `.map` file is shipped
alongside it).

## mpegts.js

- **Path:** `www/reolink-hub-playback-bridge/mpegts.js`
- **Project:** [xqq/mpegts.js](https://github.com/xqq/mpegts.js)
- **Version:** 1.8.0
- **License:** Apache License 2.0, full text in
  [`www/reolink-hub-playback-bridge/LICENSE-mpegts.js.txt`](www/reolink-hub-playback-bridge/LICENSE-mpegts.js.txt)

mpegts.js also bundles `es6-promise` (MIT license, © 2014 Yehuda Katz, Tom
Dale, Stefan Penner and contributors), whose own notice is preserved inside
the minified bundle.
