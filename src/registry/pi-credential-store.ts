/**
 * Bridges Pi's `AuthStorage` (reached at runtime via `ctx.modelRegistry.authStorage`) to Crossbar's
 * framework-free {@link CredentialStore} boundary. This is the ONLY place keys cross into Pi's store —
 * they land in `auth.json` (mode 0600) keyed by the Crossbar provider id, exactly like Pi's own creds.
 *
 * Keeping the adapter here (not in persistence.ts) preserves the rule that the persistence/registry
 * core never imports Pi runtime, so they stay unit-testable with a fake store.
 */

import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "./persistence.ts";

/** Wrap a Pi `AuthStorage` as a Crossbar `CredentialStore` (api-key credentials only). */
export function createPiCredentialStore(authStorage: AuthStorage): CredentialStore {
  return {
    get(id: string): string | undefined {
      const cred = authStorage.get(id);
      return cred?.type === "api_key" ? cred.key : undefined;
    },
    set(id: string, key: string): void {
      authStorage.set(id, { type: "api_key", key });
    },
    remove(id: string): void {
      authStorage.remove(id);
    },
  };
}
