---
created-by: ai
---
# Quiet Car

A quieter seat for the web.

Quiet Car opens full-document web pages in Obsidian's native Reader mode,
using the core Web Viewer you already know. No separate reader, extraction
engine, or saved article copies.

**Experimental. Desktop only. Exactly Obsidian core 1.14.4.**
Other versions leave automation unavailable. This is not a completed release
or a promise of mobile support.

## Reading

- Automatically requests native Reader on fresh pages, full reloads, and
  full-document history navigation.
- Keeps native Reader and Original controls. Choosing Original is respected
  for the current visit; anchor changes do not reset that choice.
- Stores only the automatic-mode preference, not articles or browsing history.

**SPA route changes are not automated.** Path/query changes return to Original
and suspend automation; use the native Reader button when needed.
Hash-routed automation is not guaranteed.

Unsupported pages may remain in Original and show a native Notice.

## A few boundaries

Automatic mode starts **ON**. After enabling or reloading Quiet Car, manually
close and reopen existing Web Viewer tabs; already-open tabs are unmanaged.

Turning **ON** applies to future full-document visits, not the current page.
Turning **OFF** stops automatic requests but does not exit native Reader or
cancel native/manual requests. Choose Original to leave native Reader;
Obsidian's own sticky Reader behavior may otherwise continue.

## Build

Use [mise](https://mise.jdx.dev/) with Node 25.6.0:

```sh
git clone https://github.com/wannli/quiet-car.git
cd quiet-car
mise install node@25.6.0
mise exec node@25.6.0 -- npm ci --ignore-scripts
mise exec node@25.6.0 -- npm run build
```

## Try it in an isolated vault

1. Copy root `main.js` and `manifest.json` into
   `<vault>/.obsidian/plugins/auto-web-reader/`.
2. Enable Obsidian's core **Web Viewer**, then the **Quiet Car** community plugin.
3. Manually close and reopen any existing Web Viewer tabs.

The internal folder ID remains `auto-web-reader` for compatibility.
Use a dedicated test vault, not a personal vault. No marketplace publication
or release readiness is claimed.

## Development

See [Contributing](CONTRIBUTING.md) for checks, verification limits, and the
maintainer-only native tooling precautions. SPA automation remains incomplete;
the native `-3` branch has not been exercised.
