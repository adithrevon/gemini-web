import type { ProviderName, BridgeUpdatePayload } from './types.js';

/**
 * Provider interface — the server delegates all instance operations through this.
 * Both GeminiBridge and ClaudeBridge implement this interface.
 */
export interface Provider {
  readonly name: ProviderName;
  start(): Promise<void>;
  submitMessage(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  confirm(
    callId: string,
    outcome: string,
    correlationId?: string,
  ): Promise<void>;
  destroy(): void;
  getSnapshot(): BridgeUpdatePayload;
}
