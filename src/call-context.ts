// Ambient per-call context. Under a gateway, one capability process serves
// every user, so "which user is this call for?" cannot live in module scope or
// in spawn-time env — it changes per request and two requests overlap freely.
//
// The gateway passes an opaque nonce with each tool call; the capability
// establishes it once (see the kit's server wrapper) and every brokered helper
// underneath picks it up automatically. Capabilities never handle an identity,
// only the nonce, so one cannot name another user even by mistake.

import { AsyncLocalStorage } from "node:async_hooks";

export interface CallContext {
  /** Opaque single-use token minted by the gateway; only it can resolve one. */
  callNonce?: string;
}

const storage = new AsyncLocalStorage<CallContext>();

/**
 * Runs `fn` with `context` ambient. Async work started inside inherits it;
 * work started outside does not, which is what keeps concurrent calls apart.
 */
export function withCallContext<T>(context: CallContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The ambient context, or undefined when running standalone. */
export function currentCallContext(): CallContext | undefined {
  return storage.getStore();
}
