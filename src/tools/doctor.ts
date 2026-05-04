import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OrchestratorContext } from "../types.js";
import { readCheckpoint } from "../checkpoint.js";
import { AGENT_MAIL_URL, agentMailRPC } from "../agent-mail.js";
import { brExec } from "../cli-exec.js";

export type DoctorSeverity = "green" | "yellow" | "red";

export interface DoctorCheck {
  name: string;
  severity: DoctorSeverity;
  message: string;
  hint?: string;
  durationMs?: number;
}

export interface DoctorReport {
  version: 1;
  cwd: string;
  overall: DoctorSeverity;
  checks: DoctorCheck[];
  elapsedMs: number;
  timestamp: string;
}

function severityRank(severity: DoctorSeverity): number {
  return severity === "red" ? 2 : severity === "yellow" ? 1 : 0;
}

function overallSeverity(checks: DoctorCheck[]): DoctorSeverity {
  return checks.reduce<DoctorSeverity>((worst, check) =>
    severityRank(check.severity) > severityRank(worst) ? check.severity : worst,
  "green");
}

async function timedCheck(name: string, fn: () => Promise<Omit<DoctorCheck, "name" | "durationMs">>): Promise<DoctorCheck> {
  const start = Date.now();
  try {
    const result = await fn();
    return { name, ...result, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      severity: "red",
      message: err instanceof Error ? err.message : String(err),
      hint: "Re-run /flywheel-doctor with the failing command manually to inspect stderr.",
      durationMs: Date.now() - start,
    };
  }
}

async function execCheck(
  pi: ExtensionAPI,
  cwd: string,
  name: string,
  cmd: string,
  args: string[],
  hint: string,
  opts: { required?: boolean; timeout?: number; okMessage?: string } = {},
): Promise<DoctorCheck> {
  return timedCheck(name, async () => {
    try {
      const result = await pi.exec(cmd, args, { cwd, timeout: opts.timeout ?? 2500 });
      if (result.code === 0) {
        const firstLine = result.stdout.trim().split(/\r?\n/)[0];
        return { severity: "green", message: opts.okMessage ?? (firstLine || `${cmd} available`) };
      }
      return {
        severity: opts.required ? "red" : "yellow",
        message: `${cmd} exited ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 160)}` : ""}`,
        hint,
      };
    } catch (err) {
      return {
        severity: opts.required ? "red" : "yellow",
        message: `${cmd} unavailable${err instanceof Error ? `: ${err.message}` : ""}`,
        hint,
      };
    }
  });
}

export async function runDoctorChecks(pi: ExtensionAPI, cwd: string): Promise<DoctorReport> {
  const start = Date.now();
  const checks = await Promise.all([
    timedCheck("pi_extension", async () => ({
      severity: "green",
      message: "pi-orchestrator extension is loaded",
    })),
    execCheck(pi, cwd, "git_status", "git", ["status", "--porcelain"], "Initialize git or fix the repository before running a flywheel.", { required: true, okMessage: "git repository accessible" }),
    execCheck(pi, cwd, "node_version", "node", ["--version"], "Install Node.js >= 18 and ensure node is on PATH.", { required: true }),
    execCheck(pi, cwd, "br_binary", "br", ["--help"], "Install br and run `br init` in the project when you want bead tracking.", { required: true, okMessage: "br available" }),
    execCheck(pi, cwd, "bv_binary", "bv", ["--help"], "Install bv for graph-theoretic next-bead routing.", { okMessage: "bv available" }),
    execCheck(pi, cwd, "ntm_binary", "ntm", ["--help"], "Install ntm for Claude-style persistent swarm panes; pi can still fall back to subagents.", { okMessage: "ntm available" }),
    execCheck(pi, cwd, "cm_binary", "cm", ["--version"], "Install cm for CASS procedural memory.", { okMessage: "cm available" }),
    timedCheck("agent_mail_liveness", async () => {
      try {
        const payload = await agentMailRPC(pi.exec.bind(pi), "ensure_project", { human_key: cwd });
        if (payload) {
          return { severity: "green", message: "agent-mail reachable" };
        }
        return {
          severity: "yellow",
          message: "agent-mail responded without a structured payload",
          hint: `Check ${AGENT_MAIL_URL}/api and restart agent-mail if needed.`,
        };
      } catch (err) {
        return {
          severity: "yellow",
          message: `agent-mail unreachable${err instanceof Error ? `: ${err.message}` : ""}`,
          hint: `Start agent-mail and confirm it is listening at ${AGENT_MAIL_URL}.`,
        };
      }
    }),
    timedCheck("beads_initialized", async () => {
      const result = await brExec(pi, ["list", "--json"], { cwd, timeout: 3000, maxRetries: 0, logWarnings: false });
      if (result.ok) return { severity: "green", message: "br list --json works" };
      return {
        severity: "yellow",
        message: result.error.brError?.message ?? (result.error.stderr || `${result.error.command} failed`),
        hint: "Run `br init` if this project should use beads, or continue with direct/worktree mode.",
      };
    }),
    timedCheck("checkpoint_validity", async () => {
      const checkpoint = readCheckpoint(cwd);
      if (!checkpoint) return { severity: "green", message: "no active checkpoint" };
      if (checkpoint.warnings.length === 0) {
        return { severity: "green", message: `checkpoint valid (${checkpoint.envelope.state.phase})` };
      }
      return {
        severity: "yellow",
        message: `checkpoint valid with warning(s): ${checkpoint.warnings.join("; ")}`,
        hint: "Run /orchestrate to resume or /flywheel-stop to clear stale state.",
      };
    }),
    timedCheck("orphaned_worktrees", async () => {
      const { findOrphanedWorktrees } = await import("../worktree.js");
      const orphans = await findOrphanedWorktrees(pi, cwd, []);
      if (orphans.length === 0) return { severity: "green", message: "no orphaned pi worktrees" };
      const dirty = orphans.filter((w) => w.isDirty).length;
      return {
        severity: dirty > 0 ? "red" : "yellow",
        message: `${orphans.length} orphaned worktree(s)${dirty ? `, ${dirty} dirty` : ""}`,
        hint: "Run /flywheel-cleanup (alias of /orchestrate-cleanup) to remove orphaned worktrees safely.",
      };
    }),
  ]);

  return {
    version: 1,
    cwd,
    checks,
    overall: overallSeverity(checks),
    elapsedMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon = (severity: DoctorSeverity) => severity === "green" ? "✅" : severity === "yellow" ? "⚠️" : "❌";
  const lines = [
    `# Flywheel doctor — ${icon(report.overall)} ${report.overall.toUpperCase()}`,
    `cwd: ${report.cwd}`,
    `elapsed: ${report.elapsedMs}ms`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`${icon(check.severity)} **${check.name}** — ${check.message}${check.durationMs !== undefined ? ` (${check.durationMs}ms)` : ""}`);
    if (check.hint && check.severity !== "green") lines.push(`   → ${check.hint}`);
  }
  return lines.join("\n");
}

export function registerDoctorTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: "flywheel_doctor",
    label: "Flywheel Doctor",
    description: "Read-only diagnostic for flywheel prerequisites and session health (git, br/bv, ntm, agent-mail, checkpoint, orphaned worktrees).",
    promptSnippet: "Run a read-only flywheel health diagnostic",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const report = await runDoctorChecks(oc.pi, ctx.cwd);
      return {
        content: [{ type: "text", text: formatDoctorReport(report) }],
        details: { report },
      };
    },

    renderResult(result, _options, theme) {
      const report = (result.details as any)?.report as DoctorReport | undefined;
      if (!report) return new Text("Flywheel doctor completed", 0, 0);
      const color = report.overall === "green" ? "success" : report.overall === "yellow" ? "warning" : "error";
      return new Text(theme.fg(color, `Flywheel doctor: ${report.overall} (${report.elapsedMs}ms)`), 0, 0);
    },
  });
}
