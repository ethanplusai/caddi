import type { EngineAdapter, EngineCapabilities, EngineRequest, DispatchFence, EngineTarget, TargetSelector } from './contract.mjs';

export interface FixtureElement {
  id: string;
  role: 'button' | 'link' | 'textbox' | 'text';
  text?: string;
  value?: string;
  sensitive?: boolean;
  /** A sign-in form field. A password field is always sensitive. */
  login?: 'username' | 'password';
}
export interface FixtureOptions {
  runtimeIncarnation?: string;
  capabilities?: Partial<EngineCapabilities>;
  /** Trusted pure synchronous provider, usually the access coordinator. */
  capturePrivacyEpochFor?: (workspaceId: string) => number;
  /** Deterministic race-test hook. No production browser implementation. */
  prepareDispatch?: (request: EngineRequest, context: { signal?: AbortSignal }) => void | Promise<void>;
  authorizeDispatch?: DispatchFence;
}
export interface FixtureEngine extends EngineAdapter {
  createWorkspace(input: { workspaceId: string; identityId: string; requiredIsolation?: 'full-profile' }): { workspaceId: string; identityId: string; simulated: true };
  createTab(input: { workspaceId: string; tabId: string; frameId?: string; url: string; elements?: FixtureElement[] }): EngineTarget;
  resizeViewport(input: { workspaceId: string; tabId: string; width: number; height: number }): EngineTarget;
  closeTab(selector: TargetSelector): void;
  closeWorkspace(workspaceId: string): void;
  restart(nextRuntimeIncarnation?: string): void;
}
export function createFixtureEngine(options?: FixtureOptions): Readonly<FixtureEngine>;
