import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { profileRepo } from "./profiler.js";
import type {
  RepoProfile,
  ScanCodebaseAnalysis,
  ScanErrorInfo,
  ScanProvider,
  ScanResult,
  ScanSource,
} from "./types.js";

/**
 * Placeholder provider for the legacy built-in repository profiler.
 *
 * Step 1 establishes a first-class scan contract and routes the orchestrator
 * through it without changing behavior. Step 2 will add a ccc-backed provider
 * ahead of this fallback path.
 */
const builtinScanProvider: ScanProvider = {
  id: "builtin",
  label: "Built-in profiler",
  async scan(pi, cwd, signal) {
    const profile = await profileRepo(pi, cwd, signal);
    return createBuiltinScanResult(profile);
  },
};

/**
 * Scan the repository through the normalized scan contract.
 *
 * Downstream consumers should keep using `result.profile` when they need the
 * legacy `RepoProfile` fields, and optionally inspect `source`, `codebaseAnalysis`,
 * and `fallback` when richer scan context is available.
 */
export async function scanRepo(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal
): Promise<ScanResult> {
  return builtinScanProvider.scan(pi, cwd, signal);
}

export function createBuiltinScanResult(profile: RepoProfile): ScanResult {
  return {
    source: "builtin",
    provider: builtinScanProvider.id,
    profile,
    codebaseAnalysis: createEmptyCodebaseAnalysis(),
  };
}

export function createFallbackScanResult(
  profile: RepoProfile,
  source: ScanSource,
  error?: ScanErrorInfo
): ScanResult {
  return {
    source,
    provider: source,
    profile,
    codebaseAnalysis: createEmptyCodebaseAnalysis(),
    fallback: {
      used: true,
      from: source,
      to: "builtin",
      reason: error?.message ?? "fallback requested",
      error,
    },
  };
}

export function createEmptyCodebaseAnalysis(): ScanCodebaseAnalysis {
  return {
    summary: undefined,
    recommendations: [],
    structuralInsights: [],
    qualitySignals: [],
  };
}
