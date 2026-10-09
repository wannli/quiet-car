---
created-by: ai
---
# Quiet Car

## Scope and ownership
- This is a standalone experimental desktop plugin. TypeScript + esbuild are approved.
- Public brand: Quiet Car; repository/package/plugin ID and install folder: quiet-car.
  Version 0.1.0 is the first release; no legacy-name compatibility is required.
  Do not rename the active checkout or adopt existing sandbox state automatically.
- Work only on assigned files; coordinate shared contracts rather than overwriting other agents.
- Preserve unknown files. Do not commit, push, publish, deploy, package, or install unless asked.
- Work in this existing project checkout; do not create a competing worktree during coordinated work.
- Project-specific guidance belongs here; do not modify unrelated project or machine-wide guidance.
- New Markdown requires created-by: ai frontmatter and fewer than 200 lines.

## Runtime constraints
- Native core Web Viewer and native Reader only. No duplicated article UI, extraction engine,
  reading commands, runtime Node/Electron imports, or forced external-link routing.
- Never enable the core Web Viewer plugin automatically.
- Private integration must be exact-version gated: only core 1.14.4 is an inspected candidate.
- Unsupported versions leave native UI untouched and explain unavailable automation in settings.
- Desktop only. The native feature does not currently support physical mobile devices.
- Native unsupported-page Notices are an explicitly approved fallback caveat.
- Native timing safety requires identified-build runtime evidence and matched controls.
  Host functionality or a passing build alone is not proof of native safety.
- SPA automatic reapplication remains NOT MET, not an approved waiver. The native -3 branch
  remains NOT RUN. Never fold these gaps into the approved existing-tabs limitation.
- Discover/dispose via layout readiness, layout changes, and active-leaf changes only;
  these are not navigation signals. No permanent polling.
- User approved the existing-tabs limitation: already-constructed Web Viewer tabs stay UNMANAGED
  until manually closed/reopened after plugin enable/reload. Never auto-close/reopen/reload tabs.
- Install the webviewer-only private factory bridge immediately after preferences load and desktop/version
  gating, before layout-ready. Provision new views before onOpen/callback binding/native extraction,
  even while OFF. Never late-attach to existing views or unregister/re-register core factories.
- Bridge getSession is lookup-only. Public workspace scans refreshFactories and discover live views;
  null installation can retry on workspace events, never interval polling. Unknown factory owners fail closed.
- Bridge setEnabled owns all managed sessions and future defaults; host must not double-apply updates.
- Key publicly discovered sessions by live view and dispose when removed. Do not dispose unseen pre-open
  sessions based on workspace absence; the bridge owns pre-open tracking and synchronous close invalidation.
- Bridge disposal owns factories and all sessions; per-session disposal must be idempotent.
- Settings and a once-per-enable/reload Notice explain manual reopening; do not spam layout/focus Notices.
- Unload invalidates queued work, removes subscriptions, and never resets native Reader/original mode.
- Persist only {enabled: boolean}. No source URLs, article data, or personal-data logs.
- Missing data defaults ON; malformed/unreadable data fails OFF without automatic overwrite.
- OFF stops automation without exiting Reader. ON applies to subsequent visits, respecting manual intent.
- Serialize saves; failed saves must not silently enable automation or imply persistence succeeded.
- Keep requestedEnabled (toggle display during saves) separate from enabled (effective automation).
  Pending ON can be cancelled with OFF; stale completions cannot override newer intent.

## Verification
- Direct build/test commands are authorized for this project only. Do not restart or interrupt
  existing sessions or servers. Documentation-only owners do not run verification.
- Use mise-managed Node 25.6.0 / npm 11.8; installed TypeScript 5.9.3, esbuild 0.28.2,
  Obsidian declarations 1.13.1, and @types/node 22.20.5 are the agreed toolchain.
- The assigned verifier owns final verification. Branding changes create a new artifact; prior
  hashes/results are historical until an explicit comparison and current checks establish scope.
- Do not read or write other projects, personal vaults, or unrelated application profiles.
- Runtime verification uses only a dedicated isolated .sandbox test profile and test vault here.
  The verifier determines a unique loopback port; do not borrow existing profiles or ports.
- Keep credentials, private keys, environment secrets, logs, archives, and local runtime evidence
  out of public changes. Ignore rules are not proof that tracked files are secret-free.
- No license is selected. Do not invent a license grant or copyright attribution.
- Report actual executed checks separately from authored tests and pending runtime validation.
- Do not mark the prototype complete or claim mobile support from desktop/synthetic results.
