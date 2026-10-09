#!/usr/bin/env node
import { readPlan, json } from './test-sandbox.mjs';
import { connect } from './test-cdp.mjs';
import { runNative } from './test-native-run.mjs';

export const cases = [
  'Negative control: create a native Web Viewer before loading the plugin; record identity/mode/content and prove getSession(view) remains absent after load, discovery, and layout/focus changes. Plugin must not close/reopen or otherwise manage it.',
  'Tester explicitly closes the negative-control tab and creates a fresh native Web Viewer AFTER plugin load. Prove guarded-factory construction and managed getSession(view), not merely new discovery; assert native article A enters Reader with visible article content.',
  'Use existing native toggle to Original; tab focus and layout changes preserve manual choice.',
  'Same native view navigates to article B: a new visit enters Reader; already-Reader never toggles off.',
  'Supported article versus nonarticle/unsupported paths: native Notices permitted; bounded requests/actions, no retry loops or unhandled errors.',
  'Required criterion 5 fallback: article A already visible in native Reader -> same-view navigation to unsupported fixture B (/empty, truly empty HTML, distinct from supported /article-b). Native getter failure/undefined alone is NOT success: assert actual Original B native mode, original webview visibility and current URL, with stale Reader A hidden. Native Notice allowed; bounded extraction/fallback counts and no retry loop.',
  'Injected stale-failure timing: hold unsupported B extraction/failure after Reader A, make a newer manual Original/Reader choice or navigate to a newer page, then release the old failure. Repeat for manual and page supersession; assert newer mode, visible content, and URL remain unchanged. Old fallback must not revert newer state; native Notice allowed, no repeated fallback/retry or unhandled error.',
  'True webview same-URL reload, back, forward, and hash navigation: observe real navigation signals and assert the approved policy, not synthetic event substitutes.',
  'Two native views (one background): independent visits, tickets, manual choices, and modes.',
  'Global OFF cancels pending/future auto actions without changing current native mode; ON waits for next visit. Native manual Reader remains usable, including OFF republish during a held manual request.',
  'SPA path/query ambiguity is LIMITED Original+suspend behavior, not universal AC2; manual Reader must still work. Real aborted -3/stop-only navigation must not disable manual Reader.',
  'Reader A -> unsupported B refresh -> OFF must still show Original B, not leave stale A visible.',
  'Unload during idle and pending extraction: retain current native mode, restore owned factory/instance wrappers and listeners, and forbid late renderer/mode mutation. After reload, surviving constructed views remain unmanaged until the tester manually closes/recreates them; plugin never forces recreation.',
  'Injected timing: hold native extraction during a managed Reader navigation refresh, use the existing native toggle to Original, release result; mode/content must remain Original.',
  'Injected timing: prepare native getter result, insert existing-toggle Original in the microtask gap before the actual native generator continuation; prove the atomic then carrier drops the stale continuation, not just an earlier result check.',
  'Injected save delay: use the actual native Setting toggle to request ON while saveData is held. Requested UI stays ON while effective automation stays OFF; use that same visible toggle to cancel OFF, then release stale ON save. UI/effective automation remain OFF; restore saveData in finally.',
  'Native popout realm gate: create a fresh factory-managed view in a native popout after load and verify construction-before-onOpen, realm-compatible continuation guarding, manual Original races, and cleanup. Record unsupported/unverified behavior as a blocker, not a pass.',
];
export async function plan() {
  const launch = await readPlan();
  return { status: 'PREPARED_NOT_RUN', launch: { executable: launch.executable,
    args: [`--user-data-dir=${launch.profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${launch.port}`],
    vaultViaProfileRegistry: launch.vault },
    prerequisites: [
      'Main explicitly authorizes build, sandbox install, and final native launch after source safety review.',
      'Review stabilized adapter and actual native methods before writing scenario actions; do not guess internals or add production debug exports. No production private-API patch/application until main authorizes the built candidate and all identity guards pass.',
      'Load/enable plugin before creating every positive scenario Web Viewer. Only the explicit unmanaged negative control is constructed before load. Management is guarded-factory provenance, never discovery time; keep native core-plugin enablement a separately approved/manual prerequisite.',
      'Verify build hashes; install only known plugin artifacts into marked sandbox, create-only first; replacements need backups and restoration.',
      'Immediately recheck CDP port and profile process absence. Spawn exact executable with explicit profile flags; record PID, ps lstart, port, executable, profile, vault in .sandbox/native-session.json.',
      'OS PID/start-time/executable/profile/CDP-listener checks precede read-only renderer identity probe. Probe exact vault and runtime require("electron").ipcRenderer.sendSync("version") === "1.14.4" (approved exact apiVersion initializer); corroborate loaded host coreVersion imported from apiVersion (neither installer nor declaration-package version) separately from bundle version.',
      'Recheck OS and in-evaluation vault identity before each action. No generic obsidian CLI, save-to-vault calls, personal state, or foreign PID termination.',
      'Capture native UI/mode/content, navigation identities, Notices, extraction/action counts, unhandled errors, and installed SHA256 hashes; restore injected wrappers in finally.',
    ],
    bridgeContractForPlanning: {
      install: 'installNativeReaderBridge(app, coreVersion1.14.4, enabled)',
      bridge: ['getSession(view): managed-only lookup', 'setEnabled(enabled)', 'refreshFactories(): boolean', 'dispose()'],
      session: ['setEnabled', 'refreshBinding', 'dispose'],
      factories: ['app.internalPlugins.getPluginById("webviewer").views.webviewer', 'app.viewRegistry.viewByType.webviewer'],
      construction: 'Original constructor runs, then instance is guarded BEFORE onOpen. Assert both factory routes against the stabilized implementation.',
      hostLookup: 'Inspected src/main.ts private bridge field and settingsTab; getSession(view) checks managed-only provenance. No production debug export.',
      asyncBoundary: 'Atomic then carrier guards actual native generator continuation; getter-result-only checks are insufficient.',
    },
    cases, blockers: [
      'Executable scenario tooling authored against actual candidate source; final source fixes, independent review, reviewed build hashes, and runtime authorization still required.',
      'Native manual-Original refresh and pre-continuation microtask races remain acceptance gates.',
      'Criterion 5 requires visible Original unsupported B after Reader A, not merely undefined extraction; stale failure fallback must preserve newer choices/pages. No scope waiver.',
      'Native popout cross-realm behavior remains an explicit pending gate.',
      'Installer/launcher and --authorized-run require explicit main approval; no launch/install/run has occurred.',
      'Precise pre-continuation microtask timing remains UNCOVERED by host fetch delays; never count helper characterizations as native acceptance.',
    ],
    evidence: { native: 'NOT RUN', injectedTiming: 'NOT RUN; must be labeled injected timing, not hardware evidence',
      characterization: '15 native-safety characterization cases are not working-adapter proof; 11 preferences model cases are not native Setting UI proof.',
      popout: 'NOT RUN; pending realm gate', physicalIOS: 'NOT RUN; no mobile support claim' } };
}
const args = process.argv.slice(2);
if (!args.length || (args.length === 1 && args[0] === '--plan')) console.log(json(await plan()));
else if (args.length === 2 && args[0] === '--identity' && args[1] === '--authorized-runtime') {
  // Identity-only, not acceptance: deliberately does not launch/install/mutate app state.
  const session = await connect();
  try { console.log(json({ status: 'IDENTITY_ONLY', runtime: session.runtime, acceptance: 'NOT RUN' })); }
  finally { session.close(); }
} else if (args.length === 3 && args[0] === '--authorized-run') {
  await runNative({ 'main.js': args[1], 'manifest.json': args[2] });
} else throw Error('Use --plan; after explicit main authorization: --identity --authorized-runtime OR --authorized-run MAIN_SHA256 MANIFEST_SHA256');
