import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { brokeredProfile, currentCallContext, withCallContext } from "../src/index.js";
import { withCallScope } from "../src/kit.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Echoes the received X-Vault-Call back as a profile field, after a delay. */
async function echoNonceServer(delayMs = 0): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const seen = request.headers["x-vault-call"];
      const send = (): void => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ fields: { seen: typeof seen === "string" ? seen : "none" } }));
      };
      if (delayMs > 0) {
        setTimeout(send, delayMs);
      } else {
        send();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe("brokered calls carry the ambient nonce", () => {
  it("sends X-Vault-Call when a context is active", async () => {
    const url = await echoNonceServer();
    const fields = await withCallContext({ callNonce: "nonce-a" }, async () =>
      brokeredProfile({ url, token: "t" }, { fields: ["seen"] }),
    );
    expect(fields["seen"]).toBe("nonce-a");
  });

  it("omits the header when running standalone", async () => {
    const url = await echoNonceServer();
    const fields = await brokeredProfile({ url, token: "t" }, { fields: ["seen"] });
    expect(fields["seen"]).toBe("none");
  });

  // The failure mode shared processes introduce: overlapping calls for
  // different users must not observe each other's context.
  it("keeps concurrent calls apart", async () => {
    const url = await echoNonceServer(15);
    const [first, second] = await Promise.all([
      withCallContext({ callNonce: "user-one" }, async () =>
        brokeredProfile({ url, token: "t" }, { fields: ["seen"] }),
      ),
      withCallContext({ callNonce: "user-two" }, async () =>
        brokeredProfile({ url, token: "t" }, { fields: ["seen"] }),
      ),
    ]);
    expect(first["seen"]).toBe("user-one");
    expect(second["seen"]).toBe("user-two");
  });
});

interface Registered {
  handler: (...args: unknown[]) => unknown;
}

function fakeServer(): { registerTool: (n: string, c: unknown, h: Registered["handler"]) => void; last: Registered } {
  const last: Registered = { handler: () => undefined };
  return {
    registerTool: (_n: string, _c: unknown, h: Registered["handler"]): void => {
      last.handler = h;
    },
    last,
  };
}

describe("withCallScope", () => {
  it("establishes the context from _meta for the handler", async () => {
    const server = withCallScope(fakeServer());
    server.registerTool("t", {}, () => currentCallContext()?.callNonce);
    const seen = await server.last.handler({}, { _meta: { callNonce: "from-meta" } });
    expect(seen).toBe("from-meta");
  });

  it("runs unwrapped when there is no _meta (standalone)", async () => {
    const server = withCallScope(fakeServer());
    server.registerTool("t", {}, () => currentCallContext()?.callNonce);
    expect(await server.last.handler({}, {})).toBeUndefined();
    expect(await server.last.handler({})).toBeUndefined();
  });

  it("reads extra when the tool takes no arguments object", async () => {
    const server = withCallScope(fakeServer());
    server.registerTool("t", {}, () => currentCallContext()?.callNonce);
    expect(await server.last.handler({ _meta: { callNonce: "solo" } })).toBe("solo");
  });

  it("rejects anything that is not an MCP server", () => {
    expect(() => withCallScope({} as never)).toThrow(TypeError);
  });
});
