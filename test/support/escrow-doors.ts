import fastify, { type HTTPMethods } from "fastify";
import type { WireTypeProvider } from "../../src/api/deps.js";
import { escrowRoutes } from "../../src/api/escrow.js";
import { compileSchema } from "../../src/api/schemas/ajv.js";
import type { Config } from "../../src/config.js";

/** One route the escrow plugin registers, as Fastify's router reports it. */
export interface EscrowDoor {
  method: HTTPMethods;
  url: string;
}

/**
 * Every route {@link escrowRoutes} registers, read off **Fastify's own router**.
 *
 * Shared by the unit mode-gate test and the devnet mode-off scenario, because
 * both used to name the doors in a literal and a literal is a list a fourth
 * route joins only if its author remembers to add it (S7). This asks the code.
 *
 * A bare instance, the same registration function `buildApp` calls, and an
 * `onRoute` hook on the **root** — which sees routes registered in nested scopes
 * as well as on the instance itself, so a door written outside the escrow
 * plugin's gated scope by mistake still appears here and is still asserted.
 *
 * Nothing is served from this instance: it is closed before it returns, and the
 * config below exists only because `escrowRoutes` takes one. The caller injects
 * against a real app.
 */
export async function escrowDoors(): Promise<EscrowDoor[]> {
  // The app's own validator: the doors' schemas carry keywords only it knows.
  const probe = fastify().withTypeProvider<WireTypeProvider>();
  probe.setValidatorCompiler(compileSchema);
  const doors: EscrowDoor[] = [];
  probe.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) doors.push({ method, url: route.url });
  });

  escrowRoutes(probe, {
    config: { escrow: { mode: "off" } } as unknown as Config,
    keys: null,
  });
  await probe.ready();
  await probe.close();

  return doors;
}
