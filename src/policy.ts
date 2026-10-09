export interface ViewSnapshot {
  readonly readiness: "loading" | "ready";
  readonly capability: "unknown" | "available" | "unsupported";
  readonly mode: "unknown" | "original" | "reader";
}

export interface ActivationTicket {
  readonly kind: "activate";
  readonly visit: number;
  readonly generation: number;
}

export type PolicyEvent =
  | { readonly type: "observe"; readonly generation: number; readonly snapshot: ViewSnapshot }
  | { readonly type: "manual-intent"; readonly mode: "original" | "reader" }
  | { readonly type: "setting"; readonly enabled: boolean }
  | { readonly type: "new-visit" }
  | { readonly type: "rebind" }
  | { readonly type: "navigation-begin" }
  | { readonly type: "navigation-abort" }
  | { readonly type: "ambiguous-replacement" }
  | { readonly type: "dispose" };

export interface PolicyState {
  readonly visit: number;
  readonly generation: number;
  readonly enabled: boolean;
  readonly armed: boolean;
  readonly attempted: boolean;
  readonly satisfied: boolean;
  readonly suppressed: boolean;
  readonly unsupported: boolean;
  readonly navigating: boolean;
  readonly suspended: boolean;
  readonly disposed: boolean;
}

/** One instance per live view, with no URL, timer, native API, or display actions.
 * Constructor creates the initial visit using the loaded persisted setting.
 * Feed only verified navigation/reload as new-visit (even for the same URL).
 * Hash, focus, layout and ordinary load notifications are NOT new visits.
 * Capture state.generation when binding observations; never relabel stale ones.
 * new-visit/rebind/navigation-begin/navigation-abort/ambiguous-replacement/dispose
 * advance generation; establish fresh observation bindings after those events.
 * Rebind preserves the visit; abort requires fresh observations of the old page.
 * manual-intent must be delivered synchronously for BOTH user on and user off.
 * Tickets are identity-bound controller guards, NOT native cancellation.
 * Before issuing async native effects, the adapter must independently prove
 * last-user-intent semantics; isCurrent cannot undo an already-issued effect.
 * A ticket authorizes one activation attempt, never a blind toggle or restore.
 */
export class Policy {
  private data: PolicyState;
  private pending: ActivationTicket | undefined;

  constructor(enabled: boolean) {
    this.data = {
      visit: 1, generation: 1, enabled, armed: enabled, attempted: false,
      satisfied: false, suppressed: false, unsupported: false,
      navigating: false, suspended: false, disposed: false,
    };
  }

  get state(): PolicyState { return Object.freeze({ ...this.data }); }

  isCurrent(ticket: ActivationTicket): boolean {
    return !this.data.disposed && this.pending === ticket;
  }

  dispatch(event: PolicyEvent): ActivationTicket | undefined {
    if (this.data.disposed) return undefined;
    switch (event.type) {
      case "dispose":
        this.invalidate(true);
        this.update({ disposed: true, armed: false });
        break;
      case "setting":
        this.update({ enabled: event.enabled });
        if (!event.enabled) {
          this.invalidate();
          this.update({ armed: false });
        }
        break;
      case "manual-intent":
        this.invalidate();
        this.update({ suppressed: true });
        break;
      case "new-visit":
        this.invalidate(true);
        this.update({
          visit: this.data.visit + 1, armed: this.data.enabled,
          attempted: false, satisfied: false, suppressed: false,
          unsupported: false, navigating: false, suspended: false,
        });
        break;
      case "rebind":
        this.invalidate(true);
        break;
      case "navigation-begin":
        this.invalidate(true);
        this.update({ navigating: true });
        break;
      case "navigation-abort":
        this.invalidate(true);
        this.update({ navigating: false });
        break;
      case "ambiguous-replacement":
        this.invalidate(true);
        this.update({ suspended: true });
        break;
      case "observe":
        return this.observe(event.generation, event.snapshot);
    }
    return undefined;
  }

  private update(patch: Partial<PolicyState>): void {
    this.data = { ...this.data, ...patch };
  }

  private invalidate(binding = false): void {
    this.pending = undefined;
    if (binding) this.update({ generation: this.data.generation + 1 });
  }

  private observe(generation: number, snapshot: ViewSnapshot): ActivationTicket | undefined {
    const s = this.data;
    if (generation !== s.generation || s.navigating || s.suspended) return undefined;
    if (snapshot.mode === "reader") {
      this.pending = undefined;
      this.update({ satisfied: true });
    }
    if (snapshot.capability === "unsupported") {
      this.pending = undefined;
      this.update({ unsupported: true });
    }
    const eligible = snapshot.readiness === "ready"
      && snapshot.capability === "available" && snapshot.mode === "original";
    if (!eligible) this.pending = undefined;
    if (!eligible || !s.enabled || !s.armed || s.attempted || s.suppressed
      || this.data.satisfied || this.data.unsupported) return undefined;
    // Consume the one shot BEFORE returning control to the caller.
    this.update({ attempted: true });
    this.pending = Object.freeze({ kind: "activate", visit: s.visit, generation });
    return this.pending;
  }
}
