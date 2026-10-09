---
created-by: ai
---
# Contributing to Quiet Car

Keep changes small and preserve the native reading experience. Read
[AGENTS.md](AGENTS.md) before changing implementation or verification tooling.

## Local checks

Use mise-managed Node 25.6.0 from the repository root:

```sh
mise install node@25.6.0
mise exec node@25.6.0 -- npm ci --ignore-scripts
mise exec node@25.6.0 -- npm test
mise exec node@25.6.0 -- npm run typecheck
mise exec node@25.6.0 -- npm run build
```

Direct checks are permitted for this project. Do not interrupt existing
processes. Documentation-only work does not require running tests or builds.

TypeScript and esbuild produce the plugin bundle. There are no runtime package
dependencies. The plugin ID, install folder, repository, and package name are
`quiet-car`. Version `0.1.0` is the first release; no legacy migration is needed.

## Design boundaries

- Native core Web Viewer extraction, rendering, and controls only.
- Desktop core 1.14.4 exactly, with version and private-capability guards.
- No runtime Node/Electron imports, custom extraction engine, or article copies.
- Persist only `enabled`; no URLs, article content, or browsing history.
- Do not automatically enable Web Viewer or adopt already-constructed views.
- Respect manual Original, future-visit enabling, and native behavior while OFF.
- Unsupported native Notices are allowed; do not intercept them globally.

## Verification scope

The earlier branded Quiet Car build passed **138 tests**, typecheck, and build without
errors or warnings. Model tests and unsafe characterization controls are not
substitutes for actual native content checks.

The earlier build identified below passed **22 native baseline groups** plus
targeted timing/control and full-restart checks on desktop core 1.14.4:

```text
Historical main.js SHA-256
ddbf9d1f46b0a7226a03d2ae6dc7875256ecb2fb721d75e4e0a6e15f2fe4f4c6
```

These are historical results, not validation of the current plugin-ID rename.
The renamed sandbox requires fresh ownership markers; do not adopt or rewrite
existing sandbox state to bypass its guards. No new native run is claimed.

Those checks covered visible background Reader content, actual Original guest
content, manual intent, settings cancellation, late-asset/no-flicker behavior,
matched microgap controls, and restored Reader content. The background blank
issue was fixed through owned view resize forwarding to the native renderer,
without extra extraction, custom rendering, or a focus workaround.

Exact branding bundle comparison found only three Notice-prefix string changes,
with no logic difference. Lockfile dependencies matched except for two root
package names. **No new native run was performed for branding.** Native results
remain tied to the historical SHA, not automatically to subsequent artifacts.

Outstanding acceptance limits:

- **SPA automatic reapplication: NOT MET**, not an approved waiver.
- **Native `-3` branch: NOT RUN**; only natural stop was exercised.
- No mobile support or future-core-version guarantee.

Report executed checks, controls, historical evidence, and pending cases
separately. Do not weaken body assertions to obtain a pass or equate mode flags
with visible content. These results do not establish full acceptance or release
readiness.

## Maintainer-only native tooling

The native scripts are **not portable setup commands or casual tests**, and are
not part of `npm test`. Inspect their scope before execution; do not run the
harness blindly.

- Use only explicitly authorized, dedicated sandbox vaults and profiles.
- Install/restore tooling replaces sandbox plugin artifacts.
- Profile tooling changes the isolated updater preference.
- Native cases mutate sandbox settings, tabs, and core-plugin state.
- Launch/stop/restart tooling starts processes and sends SIGTERM to recorded
  processes. Validate process ownership rather than trusting a stale PID.
- Honor all profile/vault, OS, PID, version, and loopback-port guards and required
  authorization flags. Never bypass a guard to reuse an unrelated session.
- Restore owned hooks, preferences, metadata, and fixtures after verification;
  preserve notes and user-open sessions.

These permissions never authorize accessing personal vaults or other projects
and profiles. Keep private data, credentials, and local runtime evidence out of
public changes.

Historical `test-layout-validation.mjs` intentionally pins the old `ddbf9d…`
36,617-byte bundle, its old manifest and source fingerprint, and port `19226`.
Do not update those pins merely for branding. Historical results make no claim
about current process state or port availability.

No license has been selected. Public availability alone is not a license grant.
