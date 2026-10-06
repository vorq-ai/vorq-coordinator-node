import { configDefaults, defineConfig } from "vitest/config";

/**
 * Integration tests live in `test/devnet/`, one file per scenario group (R40).
 *
 * The unit project excludes that directory by path AND `*.integration.test.ts`
 * by name. The second is deliberate belt-and-braces: an integration file dropped
 * at a flat path such as `test/devnet.integration.test.ts` would otherwise be
 * swept into the unit run, which must reach neither the chain nor Postgres, and
 * would never be picked up by `test:devnet` — both halves failing silently.
 */
const INTEGRATION = ["test/devnet/**", "**/*.integration.test.ts"];

// Two suites, one config:
//   unit   — `npm test`, no chain and no network
//   devnet — `npm run test:devnet`, requires the fork stack up plus a local Postgres
export default defineConfig({
  test: {
    testTimeout: 15000,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...INTEGRATION],
          /**
           * Says out loud how much of this project skipped, and why (B-1, R25).
           * A gate nothing announces is a gate nobody closes.
           */
          globalSetup: ["test/support/db-gate.ts"],
          /** Every response checked against its route's published schema. */
          setupFiles: ["test/support/response-contract.ts"],
        },
      },
      {
        test: {
          name: "devnet",
          include: ["test/devnet/**/*.test.ts"],
          testTimeout: 120000,
          /**
           * **One file at a time.** These scenarios share one chain, and several
           * of them count what is on it: `cursor-gap` asserts that exactly one
           * job row appeared while its node was down, and `cold-start` compares a
           * projection against a snapshot of itself. Run in parallel, another
           * file's `post` lands inside that window and the count is wrong — a
           * failure that looks like an indexer defect and is not.
           *
           * It is also the honest configuration: the fork stack is a singleton —
           * only one of them can hold `:8545` on a host — so a suite that only
           * passed with the files interleaved a particular way would be measuring
           * the scheduler.
           */
          fileParallelism: false,
        },
      },
    ],
  },
});
