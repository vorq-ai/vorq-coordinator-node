import { describe, expect, it } from "vitest";
import { askRegistryAbi } from "../src/abi/askRegistry.js";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { providerRegistryAbi } from "../src/abi/providerRegistry.js";

/**
 * The vendored ABIs are generated, and the generator can be pointed at the wrong
 * artifact: `out/JobRegistry.sol/` holds IERC20.json beside JobRegistry.json, so
 * a substitution produces a valid-looking module whose every decode fails at
 * runtime. scripts/gen-abi.sh asserts these counts at generation time; this
 * asserts them for every commit, including hand edits and bad merges.
 */
const EXPECTED_ENTRIES = {
  jobRegistry: 69,
  providerRegistry: 55,
  askRegistry: 14,
} as const;

const names = (abi: readonly { type: string; name?: string }[], type: string) =>
  abi.filter((entry) => entry.type === type).map((entry) => entry.name);

describe("vendored ABIs", () => {
  it("have the pinned entry counts", () => {
    expect(jobRegistryAbi.length).toBe(EXPECTED_ENTRIES.jobRegistry);
    expect(providerRegistryAbi.length).toBe(EXPECTED_ENTRIES.providerRegistry);
    expect(askRegistryAbi.length).toBe(EXPECTED_ENTRIES.askRegistry);
  });

  it("expose the JobRegistry surface the indexer and relayer depend on", () => {
    expect(names(jobRegistryAbi, "event")).toEqual(
      // `PostSkipped` is the batch worker's whole receipt for a line that never
      // became a job: `postMany` skips rather than reverting, so a missing decode
      // here is a line silently lost rather than a decode that fails loudly.
      expect.arrayContaining(["Posted", "Claimed", "Settled", "Ended", "PostSkipped"]),
    );
    expect(names(jobRegistryAbi, "function")).toEqual(
      expect.arrayContaining([
        "getJob",
        "post",
        "postMany",
        "cancel",
        "claim",
        "submitAndSettle",
        "fail",
      ]),
    );
  });

  it("expose the ProviderRegistry surface", () => {
    expect(names(providerRegistryAbi, "event")).toEqual(
      expect.arrayContaining([
        "ProviderRegistered",
        "OperatorChanged",
        "ListedChanged",
        "CapacityChanged",
        "ReputationChanged",
        "ModelRegistered",
        "ModelEnabledChanged",
        "AllowedModelsChanged",
        "AllowlistEntrySet",
        "IdentityUpdated",
      ]),
    );
    expect(names(providerRegistryAbi, "function")).toEqual(
      expect.arrayContaining([
        "setIdentity",
        "requestCapacity",
        "lastIdentityAt",
        "lastCapacityAt",
      ]),
    );
  });

  it("expose the AskRegistry surface", () => {
    expect(names(askRegistryAbi, "event")).toEqual(expect.arrayContaining(["AsksPublished"]));
    expect(names(askRegistryAbi, "function")).toEqual(expect.arrayContaining(["setAsks"]));
  });
});
