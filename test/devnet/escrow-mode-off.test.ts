import { afterAll, describe, expect, it } from "vitest";
import {
  jsonBody,
  startNodeProcess,
  waitForSocket,
  type NodeProcess,
} from "./support/harness.js";
import type { ErrorEnvelope } from "./support/escrow.js";
import { escrowDoors } from "../support/escrow-doors.js";

/**
 * Escrow scenario **7** — the same binary, with the escrow compiled off.
 *
 * `ESCROW_MODE` defaults to `off`, and that default is the security property
 * rather than a convenience: a node that defaulted to `mock` would serve forgeable
 * evidence and hand its whole key set to any caller the first time somebody
 * deployed one without reading the documentation.
 *
 * What this asserts, beyond "it says no":
 *
 *   * **every door, not one — and the doors are enumerated from the router.** A
 *     guard fixed on one door and not its siblings is this project's recurring
 *     defect, and `/handover` is the one that would matter, since it is the door
 *     that hands over key material. This test used to name the three doors in a
 *     literal, which is the same defect one layer up: a fourth route joined the
 *     list only if its author remembered to add it. The list now comes from
 *     Fastify's own `onRoute` hook while {@link escrowRoutes} registers, so it
 *     covers a door the day it exists (S7).
 *   * **`403`, never `404`.** A `404` says *this node has no such door*, which is
 *     a false statement about a build that simply holds no keys, and a client
 *     cannot branch on it (I2/P14).
 *   * **before readiness.** The refusal is taken as soon as the socket answers,
 *     while the index is still catching up — so it is the mode gate talking and
 *     not the readiness gate, which the escrow routes sit outside of (P26).
 *   * **before the body is parsed.** Both write doors are sent an empty object,
 *     which no ladder rung would accept, and the answer is still the mode gate's.
 */

const SCHEMA = "vorq_devnet_escrow_off";

let node: NodeProcess;

afterAll(async () => {
  await node?.stop();
}, 120_000);

describe("escrow mode off", () => {
  it("refuses every escrow door the router reports with escrow_unavailable, and does not 404", async () => {
    // Spelled out rather than left to the default, so this test still says what
    // it is about if the default ever moves.
    node = await startNodeProcess({ schema: SCHEMA, env: { ESCROW_MODE: "off" } });

    // The socket, not readiness: the escrow doors are outside the gate, so this
    // is the earliest moment they can answer and the one that proves the refusal
    // is the mode's and not the indexer's.
    await waitForSocket(node);

    const doors = await escrowDoors();
    // Three today. A floor, not the list — the loop runs over the router's own
    // answer, whatever that has grown to.
    expect(doors.length).toBeGreaterThanOrEqual(3);

    for (const door of doors) {
      const path = `${door.method} ${door.url}`;
      // A write door is sent an empty object, which no ladder rung would accept:
      // the refusal below is therefore the mode gate's and not a parser's.
      const init =
        door.method === "GET" || door.method === "HEAD"
          ? undefined
          : { ...jsonBody({}), method: door.method };
      const response = await node.request(door.url, init);
      if (door.method === "HEAD") {
        expect(response.status, path).toBe(403);
        continue;
      }
      const body = (await response.json()) as ErrorEnvelope;

      expect(response.status, `${path} -> ${JSON.stringify(body)}`).toBe(403);
      expect(body.error.code, path).toBe("escrow_unavailable");
      expect(body.error.type, path).toBe("invalid_request_error");
      // Not retryable, and honestly so: an identical request cannot start working
      // against a node that is never going to hold a key.
      expect(response.headers.get("x-vorq-retryable"), path).toBe("false");
      // P13: one envelope. No bare top-level `code`.
      expect(body, path).not.toHaveProperty("code");
    }

    // The doors exist. `/readyz` is a route on the same app and answers on the
    // same socket, so a 404 above would have meant a missing route rather than a
    // dead node.
    const readyz = await node.request("/readyz");
    expect([200, 503]).toContain(readyz.status);
    await readyz.text();
  }, 120_000);
});
