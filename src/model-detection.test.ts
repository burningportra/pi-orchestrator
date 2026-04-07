import { describe, it, expect } from "vitest";
import { detectAvailableModels, getDeepPlanModels, getRefinementModel, formatDetectedModels } from "./model-detection.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// Mock ExtensionContext with modelRegistry
function mockContext(models: Array<{ provider?: string; id: string }>): ExtensionContext {
  return {
    modelRegistry: {
      getAvailable: () => models,
    },
    model: undefined,
  } as unknown as ExtensionContext;
}

describe("model-detection", () => {
  describe("detectAvailableModels", () => {
    it("detects Anthropic provider", () => {
      const ctx = mockContext([
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "anthropic", id: "claude-sonnet-4-5" },
      ]);

      const detected = detectAvailableModels(ctx);

      expect(detected.hasAnthropic).toBe(true);
      expect(detected.hasOpenAI).toBe(false);
      expect(detected.hasGoogle).toBe(false);
    });

    it("detects OpenAI provider", () => {
      const ctx = mockContext([
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "openai", id: "gpt-4o" },
      ]);

      const detected = detectAvailableModels(ctx);

      expect(detected.hasOpenAI).toBe(true);
      expect(detected.hasAnthropic).toBe(false);
    });

    it("detects OpenCode provider", () => {
      const ctx = mockContext([
        { provider: "opencode", id: "gpt-5.4" },
        { provider: "opencode", id: "claude-opus-4-6" },
        { provider: "opencode", id: "gemini-3.1-pro" },
      ]);

      const detected = detectAvailableModels(ctx);

      expect(detected.hasOpenCode).toBe(true);
      // Note: OpenCode is a separate provider, not Google
      // Google detection requires google-antigravity or google provider
    });

    it("selects OpenCode Gemini for ergonomics when Google not available", () => {
      const ctx = mockContext([
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "opencode", id: "gemini-3.1-pro" },
      ]);

      const detected = detectAvailableModels(ctx);

      // Should use OpenCode's Gemini for ergonomics
      expect(detected.ergonomicsModel).toBe("opencode/gemini-3.1-pro");
    });

    it("detects multiple providers", () => {
      const ctx = mockContext([
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "google-antigravity", id: "gemini-3.1-pro-high" },
      ]);

      const detected = detectAvailableModels(ctx);

      expect(detected.hasAnthropic).toBe(true);
      expect(detected.hasOpenAI).toBe(true);
      expect(detected.hasGoogle).toBe(true);
    });

    it("selects best models for planning roles", () => {
      const ctx = mockContext([
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "google-antigravity", id: "gemini-3.1-pro-high" },
      ]);

      const detected = detectAvailableModels(ctx);

      // Correctness prefers OpenAI/Codex
      expect(detected.correctnessModel).toBe("openai-codex/gpt-5.4");
      // Robustness prefers Anthropic
      expect(detected.robustnessModel).toBe("anthropic/claude-opus-4-6");
      // Ergonomics prefers Google
      expect(detected.ergonomicsModel).toBe("google-antigravity/gemini-3.1-pro-high");
    });

    it("falls back when preferred provider is missing", () => {
      const ctx = mockContext([
        { provider: "anthropic", id: "claude-opus-4-6" },
      ]);

      const detected = detectAvailableModels(ctx);

      // Should fall back to Anthropic for all roles
      expect(detected.correctnessModel).toBe("anthropic/claude-opus-4-6");
      expect(detected.robustnessModel).toBe("anthropic/claude-opus-4-6");
      expect(detected.ergonomicsModel).toBe("anthropic/claude-opus-4-6");
    });

    it("builds refinement rotation from available providers", () => {
      const ctx = mockContext([
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "google-antigravity", id: "gemini-3.1-pro-high" },
      ]);

      const detected = detectAvailableModels(ctx);

      expect(detected.refinementModels.length).toBeGreaterThanOrEqual(3);
      expect(detected.refinementModels).toContain("anthropic/claude-opus-4-6");
      expect(detected.refinementModels).toContain("openai-codex/gpt-5.4");
      expect(detected.refinementModels).toContain("google-antigravity/gemini-3.1-pro-high");
    });

    it("handles empty model registry gracefully", () => {
      const ctx = mockContext([]);

      const detected = detectAvailableModels(ctx);

      // Should return fallback defaults
      expect(detected.correctnessModel).toBe("anthropic/claude-opus-4-6");
      expect(detected.robustnessModel).toBe("anthropic/claude-opus-4-6");
      expect(detected.refinementModels.length).toBeGreaterThan(0);
    });

    it("handles missing modelRegistry gracefully", () => {
      const ctx = {
        modelRegistry: undefined,
      } as unknown as ExtensionContext;

      const detected = detectAvailableModels(ctx);

      // Should return fallback defaults
      expect(detected.correctnessModel).toBe("anthropic/claude-opus-4-6");
    });
  });

  describe("getDeepPlanModels", () => {
    it("returns detected models when available", () => {
      const ctx = mockContext([
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "google-antigravity", id: "gemini-3.1-pro-high" },
      ]);

      const models = getDeepPlanModels(ctx);

      expect(models.correctness).toBe("openai-codex/gpt-5.4");
      expect(models.robustness).toBe("anthropic/claude-opus-4-6");
      expect(models.ergonomics).toBe("google-antigravity/gemini-3.1-pro-high");
    });

    it("returns fallback models on error", () => {
      const ctx = {} as ExtensionContext;

      const models = getDeepPlanModels(ctx);

      // Should return hardcoded fallbacks (Anthropic is most reliable)
      expect(models.correctness).toBe("anthropic/claude-opus-4-6");
      expect(models.robustness).toBe("anthropic/claude-opus-4-6");
    });
  });

  describe("getRefinementModel", () => {
    it("rotates through detected models", () => {
      const ctx = mockContext([
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "google-antigravity", id: "gemini-3.1-pro-high" },
      ]);

      const model0 = getRefinementModel(ctx, 0);
      const model1 = getRefinementModel(ctx, 1);
      const model2 = getRefinementModel(ctx, 2);
      const model3 = getRefinementModel(ctx, 3); // Should wrap

      expect(model0).not.toBe(model1);
      expect(model1).not.toBe(model2);
      expect(model3).toBe(model0); // Wraps around
    });
  });

  describe("formatDetectedModels", () => {
    it("formats detected models for display", () => {
      const ctx = mockContext([
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "openai-codex", id: "gpt-5.4" },
      ]);

      const detected = detectAvailableModels(ctx);
      const formatted = formatDetectedModels(detected);

      expect(formatted).toContain("Detected Model Providers");
      expect(formatted).toContain("Anthropic");
      expect(formatted).toContain("OpenAI");
      expect(formatted).toContain("Planning Model Selection");
      expect(formatted).toContain("Correctness");
      expect(formatted).toContain("Refinement Rotation");
    });
  });
});
