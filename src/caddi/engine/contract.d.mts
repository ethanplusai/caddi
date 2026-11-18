/** Runtime validators enforce identifier, payload and generation bounds. */
export interface EngineTarget {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly frameId: string;
  readonly runtimeIncarnation: string;
  readonly documentGeneration: number;
  readonly observationId: string;
  readonly viewportRevision: number;
  readonly capturePrivacyEpoch: number;
}
export interface TargetSelector { workspaceId: string; tabId: string; frameId?: string }
export interface EngineCapabilities {
  implementation: 'fixture' | 'development' | 'production';
  isolation: 'full-profile' | 'storage-partition' | 'shared-session';
  isolationEvidence: 'simulated' | 'qualified' | 'unqualified';
  persistentStorage: boolean;
  input: 'target-scoped' | 'focus-required';
  capture: 'synthetic' | 'engine' | 'none';
  extensions: boolean;
  passwordManagers: boolean;
  passkeys: boolean;
}
export type EngineRequest =
  | { operation: 'page:navigate'; target: EngineTarget; payload: { url: string } }
  | { operation: 'page:click'; target: EngineTarget; payload: { elementId: string } | { x: number; y: number } }
  | { operation: 'page:fill'; target: EngineTarget; payload: { elementId: string; value: string } }
  | { operation: 'page:scroll'; target: EngineTarget; payload: { x: number; y: number } }
  | { operation: 'page:observe'; target: EngineTarget; payload: { scope?: 'viewport' | 'page'; role?: string; query?: string; interactiveOnly?: boolean; offset?: number; limit?: number } }
  | { operation: 'page:hover'; target: EngineTarget; payload: { elementId: string } | { x: number; y: number } }
  | { operation: 'page:key'; target: EngineTarget; payload: { key: string; elementId?: string } }
  | { operation: 'page:type'; target: EngineTarget; payload: { text: string; elementId?: string } }
  | { operation: 'page:select'; target: EngineTarget; payload: { elementId: string; value?: string; label?: string } }
  | { operation: 'page:drag'; target: EngineTarget; payload: { fromElementId?: string; fromX?: number; fromY?: number; toElementId?: string; toX?: number; toY?: number } }
  | { operation: 'page:scroll-by'; target: EngineTarget; payload: { dx: number; dy: number; elementId?: string } }
  | { operation: 'page:scroll-into-view'; target: EngineTarget; payload: { elementId: string } }
  | { operation: 'page:wait'; target: EngineTarget; payload: { until: 'load' | 'text' | 'element'; text?: string; role?: string; timeoutMs?: number } }
  | { operation: 'page:screenshot'; target: EngineTarget; payload: { format?: 'jpeg' | 'png' } }
  | { operation: 'page:read'; target: EngineTarget; payload: { mode?: 'main' | 'full'; elementId?: string; offset?: number; maxChars?: number } }
  | { operation: 'page:extract'; target: EngineTarget; payload: { kind: 'links' | 'tables' | 'headings' | 'meta' | 'forms'; mode?: 'main' | 'full'; elementId?: string; query?: string; offset?: number; limit?: number; rowOffset?: number } };
export type DispatchFence = (request: EngineRequest) => boolean | void;
export interface DispatchOptions {
  signal?: AbortSignal;
  /** Must synchronously check authenticated access incarnation, grant and lease. */
  beforeDispatch: DispatchFence;
  /** The same checks without entering the request, for presentation steps before the final fence. */
  checkCurrent?: () => true;
  /** Display name of the agent acting, for the visible cursor label. Unverified client text. */
  actor?: { name: string } | null;
}
export interface ObservedElement {
  id: string;
  role: 'button' | 'link' | 'textbox' | 'text';
  sensitive: boolean;
  /** Absent when sensitive is true. */
  text?: string;
  value?: string;
  clicks?: number;
}
export interface ObservationResult {
  url: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  elements: ObservedElement[];
}
export interface EngineResult {
  readonly ok: true;
  readonly simulated: boolean;
  readonly operation: EngineRequest['operation'];
  readonly target: EngineTarget;
  readonly result: ObservationResult | Record<string, never>;
}
export interface EngineAdapter {
  readonly capabilities: Readonly<EngineCapabilities>;
  /** Trusted discovery. Caller must authorize and filter per-page origins. */
  listTargets(workspaceId: string): ReadonlyArray<EngineTarget>;
  getTarget(selector: TargetSelector): EngineTarget;
  getPageInfo(selector: TargetSelector): { target: EngineTarget; origin: string | null; url: string };
  assertCurrentTarget(target: EngineTarget): true;
  execute(request: EngineRequest, options: DispatchOptions): Promise<EngineResult>;
  /** A new access authority must invalidate targets from previous authority. */
  bindAccessRuntime(incarnation: string): string;
  assertAccessRuntime(incarnation: string): true;
}
export const ENGINE_TARGET_FIELDS: ReadonlyArray<keyof EngineTarget>;
export const FIXTURE_CAPABILITIES: Readonly<EngineCapabilities>;
export function assertEngineTarget(value: unknown): EngineTarget;
export function validateEngineCapabilities(value: unknown): Readonly<EngineCapabilities>;
export function validateEngineOperation(value: unknown): EngineRequest;
