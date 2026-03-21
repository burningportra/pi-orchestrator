import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { OrchestratorContext, CandidateIdea } from "../types.js";

export function registerDiscoverTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: "orch_discover",
    label: "Discover Ideas",
    description:
      "Generate 3–7 concrete project ideas based on the repo profile. Call orch_profile first. Returns structured ideas. After generating, call orch_select for user selection.",
    promptSnippet: "Generate project ideas from the repo profile",
    parameters: Type.Object({
      ideas: Type.Array(
        Type.Object({
          id: Type.String({ description: "unique kebab-case identifier" }),
          title: Type.String({ description: "short title" }),
          description: Type.String({ description: "2-3 sentence description" }),
          category: StringEnum([
            "feature", "refactor", "docs", "dx",
            "performance", "reliability", "security", "testing",
          ] as const),
          effort: StringEnum(["low", "medium", "high"] as const),
          impact: StringEnum(["low", "medium", "high"] as const),
          rationale: Type.Optional(Type.String({ description: "why this idea beat other candidates — cite specific repo evidence" })),
          tier: Type.Optional(StringEnum(["top", "honorable"] as const)),
          sourceEvidence: Type.Optional(Type.Array(Type.String(), { description: "repo signals that prompted this idea" })),
          scores: Type.Optional(Type.Object({
            useful: Type.Number({ description: "1-5: solves a real, frequent pain" }),
            pragmatic: Type.Number({ description: "1-5: realistic to build in hours/days" }),
            accretive: Type.Number({ description: "1-5: clearly adds value beyond what exists" }),
            robust: Type.Number({ description: "1-5: handles edge cases, works reliably" }),
            ergonomic: Type.Number({ description: "1-5: reduces friction or cognitive load" }),
          })),
          risks: Type.Optional(Type.Array(Type.String(), { description: "known downsides" })),
          synergies: Type.Optional(Type.Array(Type.String(), { description: "ids of complementary ideas" })),
        }),
        { description: "3-15 project ideas based on the repo profile", minItems: 3, maxItems: 15 }
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!oc.state.repoProfile) {
        throw new Error("No repo profile. Call orch_profile first.");
      }

      oc.state.candidateIdeas = params.ideas as CandidateIdea[];
      oc.setPhase("awaiting_selection", ctx);
      oc.persistState();

      // Write full ideation results as a session artifact
      const topIdeas = oc.state.candidateIdeas.filter((i) => i.tier === "top");
      const honorableIdeas = oc.state.candidateIdeas.filter((i) => i.tier === "honorable" || !i.tier);
      const artifactLines: string[] = [
        `# Discovery Ideas — ${new Date().toISOString().slice(0, 10)}`,
        "",
      ];
      if (topIdeas.length > 0) {
        artifactLines.push("## Top Picks", "");
        for (const idea of topIdeas) {
          artifactLines.push(`### ${idea.title}`, `**Category:** ${idea.category} | **Effort:** ${idea.effort} | **Impact:** ${idea.impact}`);
          artifactLines.push(`\n${idea.description}`);
          if (idea.rationale) artifactLines.push(`\n**Rationale:** ${idea.rationale}`);
          if (idea.sourceEvidence?.length) artifactLines.push(`\n**Evidence:** ${idea.sourceEvidence.join("; ")}`);
          if (idea.scores) artifactLines.push(`\n**Scores:** useful=${idea.scores.useful} pragmatic=${idea.scores.pragmatic} accretive=${idea.scores.accretive} robust=${idea.scores.robust} ergonomic=${idea.scores.ergonomic}`);
          if (idea.risks?.length) artifactLines.push(`\n**Risks:** ${idea.risks.join("; ")}`);
          if (idea.synergies?.length) artifactLines.push(`\n**Synergies:** ${idea.synergies.join(", ")}`);
          artifactLines.push("");
        }
      }
      if (honorableIdeas.length > 0) {
        artifactLines.push("## Honorable Mentions", "");
        for (const idea of honorableIdeas) {
          artifactLines.push(`### ${idea.title}`, `**Category:** ${idea.category} | **Effort:** ${idea.effort} | **Impact:** ${idea.impact}`);
          artifactLines.push(`\n${idea.description}`);
          if (idea.rationale) artifactLines.push(`\n**Rationale:** ${idea.rationale}`);
          if (idea.sourceEvidence?.length) artifactLines.push(`\n**Evidence:** ${idea.sourceEvidence.join("; ")}`);
          artifactLines.push("");
        }
      }
      try {
        const artifactDir = join(tmpdir(), `pi-orchestrator-discovery`);
        mkdirSync(artifactDir, { recursive: true });
        const artifactPath = join(artifactDir, `ideas-${Date.now()}.md`);
        writeFileSync(artifactPath, artifactLines.join("\n"), "utf8");
      } catch { /* best-effort */ }

      const ideaList = oc.state.candidateIdeas
        .map(
          (idea, i) => {
            let line = `${i + 1}. **[${idea.category}] ${idea.title}** (effort: ${idea.effort}, impact: ${idea.impact})${idea.tier === "honorable" ? " _(honorable mention)_" : ""}`;
            line += `\n   ${idea.description}`;
            if (idea.scores) {
              const s = idea.scores;
              const weighted = s.useful * 2 + s.pragmatic * 2 + s.accretive * 1.5 + s.robust + s.ergonomic;
              line += `\n   📊 **Score: ${weighted.toFixed(1)}/37.5** — useful=${s.useful} pragmatic=${s.pragmatic} accretive=${s.accretive} robust=${s.robust} ergonomic=${s.ergonomic}`;
            }
            if (idea.rationale) line += `\n   _${idea.rationale}_`;
            return line;
          }
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Call \`orch_select\` NOW to present these to the user.**\n\n---\n\nGenerated ${oc.state.candidateIdeas.length} project ideas (${topIdeas.length} top, ${honorableIdeas.length} honorable):\n\n${ideaList}`,
          },
        ],
        details: { ideas: oc.state.candidateIdeas },
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_discover ")) +
          theme.fg("dim", `${(args as any).ideas?.length ?? "?"} ideas`),
        0, 0
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "💡 Generating ideas..."), 0, 0);
      const d = result.details as any;
      const ideas: any[] = d?.ideas ?? [];
      const topCount = ideas.filter((i: any) => i.tier === "top").length;
      const honorableCount = ideas.length - topCount;
      const tierInfo = honorableCount > 0 ? ` (${topCount} top, ${honorableCount} honorable)` : "";
      let text = theme.fg("success", `💡 ${ideas.length} ideas generated${tierInfo}`);
      if (expanded && ideas.length > 0) {
        for (const idea of ideas) {
          const scoreStr = idea.scores
            ? (() => {
                const avg = (idea.scores.useful * 2 + idea.scores.pragmatic * 2 + idea.scores.accretive * 1.5 + idea.scores.robust + idea.scores.ergonomic) / 7.5;
                const stars = "★".repeat(Math.round(avg)) + "☆".repeat(5 - Math.round(avg));
                return ` ${stars}`;
              })()
            : "";
          const tierMark = idea.tier === "honorable" ? theme.fg("dim", " (honorable)") : "";
          text += `\n  [${idea.category}] ${idea.title}${scoreStr}${tierMark}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });
}
