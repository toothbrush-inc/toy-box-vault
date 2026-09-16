import { describe, expect, it } from "vitest";

import { LoopbackServer } from "../src/loopback.js";

async function hit(server: LoopbackServer, query: string): Promise<Response> {
  const base = server.redirectUri.replace(/\/callback$/u, "");
  return await fetch(`${base}/callback${query}`);
}

describe("LoopbackServer", () => {
  it("settles on the first callback when no state is expected", async () => {
    const server = await LoopbackServer.start();
    try {
      const response = await hit(server, "?code=abc");
      expect(response.status).toBe(200);
      expect((await server.waitForParams()).get("code")).toBe("abc");
    } finally {
      server.close();
    }
  });

  it("ignores callbacks that do not carry the expected state", async () => {
    const server = await LoopbackServer.start({ expectedState: "s3cret-state" });
    try {
      let settled = false;
      void server.waitForParams().then(() => {
        settled = true;
      });
      // A stranger (or a stale tab) cannot abort or hijack the pending flow.
      expect((await hit(server, "?code=evil&state=nope")).status).toBe(400);
      expect((await hit(server, "?code=evil")).status).toBe(400);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);

      const real = await hit(server, "?code=real&state=s3cret-state");
      expect(real.status).toBe(200);
      const params = await server.waitForParams();
      expect(params.get("code")).toBe("real");
    } finally {
      server.close();
    }
  });
});
