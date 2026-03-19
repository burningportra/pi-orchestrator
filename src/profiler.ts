import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RepoProfile, TodoItem, CommitSummary, DirectoryNode } from "./types.js";

/**
 * Collect raw repo signals using pi.exec for shell commands.
 */
export async function collectRepoSignals(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal
) {
  // File tree (depth-limited)
  const treeResult = await pi.exec(
    "find",
    [".", "-maxdepth", "4", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/dist/*", "-not", "-path", "*/__pycache__/*"],
    { signal, timeout: 10000, cwd }
  );
  const fileTree = treeResult.stdout.trim();

  // Recent commits
  const commitsResult = await pi.exec(
    "git",
    ["log", "--oneline", "--no-decorate", "-n", "20", "--format=%H|%s|%ai|%an"],
    { signal, timeout: 5000, cwd }
  );
  const recentCommits = parseCommits(commitsResult.stdout);

  // Key files - attempt to read common important files
  const keyFilePaths = [
    "README.md",
    "README",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "Gemfile",
    "Makefile",
    "Dockerfile",
    ".github/workflows/ci.yml",
    ".github/workflows/ci.yaml",
    ".gitlab-ci.yml",
    "tsconfig.json",
  ];

  const keyFiles: Record<string, string> = {};
  for (const filePath of keyFilePaths) {
    try {
      const result = await pi.exec("head", ["-c", "4096", filePath], {
        signal,
        timeout: 2000,
        cwd,
      });
      if (result.code === 0 && result.stdout.trim()) {
        keyFiles[filePath] = result.stdout.trim();
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  // TODOs/FIXMEs
  const todoResult = await pi.exec(
    "grep",
    ["-rn", "--include=*.ts", "--include=*.js", "--include=*.py", "--include=*.rs", "--include=*.go", "--include=*.rb",
     "-E", "(TODO|FIXME|HACK|XXX):", "."],
    { signal, timeout: 10000, cwd }
  );
  const todos = parseTodos(todoResult.stdout);

  return { fileTree, recentCommits, keyFiles, todos };
}

function parseCommits(raw: string): CommitSummary[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, date, author] = line.split("|");
      return { hash: hash?.slice(0, 7) ?? "", message: message ?? "", date: date ?? "", author: author ?? "" };
    });
}

function parseTodos(raw: string): TodoItem[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .slice(0, 50) // cap at 50
    .map((line) => {
      const match = line.match(/^\.\/(.+?):(\d+):\s*.*?(TODO|FIXME|HACK|XXX):\s*(.*)$/);
      if (!match) return null;
      return {
        file: match[1],
        line: parseInt(match[2], 10),
        type: match[3] as TodoItem["type"],
        text: match[4].trim(),
      };
    })
    .filter((t): t is TodoItem => t !== null);
}

/**
 * Build a simplified directory tree from the find output.
 */
export function buildDirectoryTree(findOutput: string): DirectoryNode[] {
  const lines = findOutput.split("\n").filter(Boolean).slice(0, 200);
  const root: DirectoryNode[] = [];

  for (const line of lines) {
    const clean = line.replace(/^\.\//, "");
    if (!clean || clean === ".") continue;
    root.push({ path: clean, type: clean.includes(".") ? "file" : "dir" });
  }

  return root;
}
