// Peer capability calls: a consumer capability declares a pseudo-connection
// {provider: "capability", slot: "<producerId>"} whose `actions` enumerate the
// producer TOOLS it may invoke — the same grant machinery as profile, zero new
// authorization code. Like profile, omitted/empty actions declare NO tools
// (not the credential wildcard). Peer calls exist only under a broker: the
// gateway routes them to the mounted producer child; standalone there is no
// peer process to reach.

import { connectionId } from "./types.js";

export const CAPABILITY_PROVIDER = "capability";

/** connectionId for a peer-capability declaration: "capability:<producerId>". */
export function capabilityConnectionId(producerId: string): string {
  return connectionId(CAPABILITY_PROVIDER, producerId);
}
