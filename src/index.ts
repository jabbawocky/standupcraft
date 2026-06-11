#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { Octokit } from "@octokit/rest";

const server = new McpServer({ name: "standupcraft", version: "1.0.0" });

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface GitCommit {
  repo: string;
  hash: string;
  message: string;
  timestamp: string;
  author_email: string;
  files_changed: number;
  insertions: number;
  deletions: number;
}

function getGitLog(repoPath: string, days: number, authorEmail?: string): GitCommit[] {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const authorFilter = authorEmail ? `--author="${authorEmail}"` : "";
  try {
    const raw = execSync(
      `git -C "${repoPath}" log --since="${since}" ${authorFilter} --format="%H|||%ae|||%ai|||%s" --numstat 2>/dev/null`,
      { encoding: "utf8", timeout: 10000 }
    );
    const commits: GitCommit[] = [];
    const blocks = raw.trim().split(/\n(?=[a-f0-9]{40}\|\|\|)/);
    for (const block of blocks) {
      if (!block.trim()) continue;
      const lines = block.trim().split("\n");
      const [hash, email, ts, ...msgParts] = lines[0].split("|||");
      if (!hash || !email || !ts) continue;
      const message = msgParts.join("|||").trim();
      let insertions = 0, deletions = 0, filesChanged = 0;
      for (let i = 1; i < lines.length; i++) {
        const m = lines[i].match(/^(\d+|-)\s+(\d+|-)\s+.+/);
        if (m) {
          filesChanged++;
          if (m[1] !== "-") insertions += parseInt(m[1]);
          if (m[2] !== "-") deletions += parseInt(m[2]);
        }
      }
      const repoName = repoPath.split("/").pop() || repoPath;
      commits.push({ repo: repoName, hash: hash.trim().slice(0, 8), message: message.trim(), timestamp: ts.trim(), author_email: email.trim(), files_changed: filesChanged, insertions, deletions });
    }
    return commits;
  } catch {
    return [];
  }
}

function detectGitRepos(startPath: string): string[] {
  const repos: string[] = [];
  if (!existsSync(startPath)) return repos;
  try {
    execSync(`git -C "${startPath}" rev-parse --git-dir`, { stdio: "ignore" });
    repos.push(startPath);
    return repos;
  } catch {
    // not a repo root, scan subdirs
  }
  try {
    const entries = readdirSync(startPath);
    for (const entry of entries.slice(0, 20)) {
      const full = join(startPath, entry);
      try {
        if (statSync(full).isDirectory() && !entry.startsWith(".")) {
          execSync(`git -C "${full}" rev-parse --git-dir`, { stdio: "ignore" });
          repos.push(full);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return repos;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ─── Tool: get_git_activity ───────────────────────────────────────────────────

server.tool(
  "get_git_activity",
  "Read local git commit history across one or more repos for a time range. Returns structured commits with message, timestamp, files changed, and line stats. No API key required — reads local .git history only.",
  {
    days: z.number().int().min(1).max(90).default(1).describe("Number of days back to fetch (1 = today + yesterday)"),
    repos: z.array(z.string()).optional().describe("Absolute paths to git repos. If omitted, scans current directory and ~/worker"),
    author: z.string().optional().describe("Filter by author email. Defaults to all authors."),
  },
  async ({ days, repos, author }) => {
    const repoPaths: string[] = repos
      ? repos.map((r) => resolve(r))
      : [
          ...detectGitRepos(process.env.HOME ? join(process.env.HOME, "worker") : "/home/orbitosw/worker"),
          ...detectGitRepos(process.cwd()),
        ].filter((v, i, a) => a.indexOf(v) === i);

    if (repoPaths.length === 0) {
      return { content: [{ type: "text", text: "No git repositories found. Pass explicit `repos` paths." }] };
    }

    const allCommits: GitCommit[] = [];
    for (const p of repoPaths) {
      allCommits.push(...getGitLog(p, days, author));
    }

    allCommits.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const summary = `Found ${allCommits.length} commits across ${repoPaths.length} repo(s) in the last ${days} day(s).`;
    const text = allCommits.length === 0
      ? `${summary}\n\nNo commits found in the specified time range.`
      : `${summary}\n\n${JSON.stringify(allCommits, null, 2)}`;

    return { content: [{ type: "text", text }] };
  }
);

// ─── Tool: get_github_activity ────────────────────────────────────────────────

server.tool(
  "get_github_activity",
  "Fetch PRs opened, merged, reviewed, and issues commented on GitHub in the last N days. Requires GITHUB_TOKEN env var with read:repo scope. Gracefully returns empty result if no token is configured.",
  {
    days: z.number().int().min(1).max(90).default(1).describe("Number of days back to fetch"),
    username: z.string().optional().describe("GitHub username. Reads GITHUB_USERNAME env var if omitted."),
    repos: z.array(z.string()).optional().describe("Repo slugs like 'owner/repo'. If omitted, fetches all user activity."),
  },
  async ({ days, username, repos }) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return { content: [{ type: "text", text: "GITHUB_TOKEN not configured. Set GITHUB_TOKEN env var (read:repo scope) to enable GitHub activity. Git activity still works without it." }] };
    }

    const user = username || process.env.GITHUB_USERNAME;
    if (!user) {
      return { content: [{ type: "text", text: "GitHub username required. Pass `username` or set GITHUB_USERNAME env var." }] };
    }

    const octokit = new Octokit({ auth: token });
    const since = new Date(Date.now() - days * 86400000).toISOString();

    try {
      const result: Record<string, unknown[]> = { prs_opened: [], prs_merged: [], prs_reviewed: [], issues_commented: [] };

      if (repos && repos.length > 0) {
        for (const repoSlug of repos) {
          const [owner, repo] = repoSlug.split("/");
          if (!owner || !repo) continue;
          const { data: prs } = await octokit.pulls.list({ owner, repo, state: "all", sort: "updated", direction: "desc", per_page: 50 });
          for (const pr of prs) {
            if (pr.user?.login !== user) continue;
            if (pr.created_at > since) (result.prs_opened as unknown[]).push({ title: pr.title, url: pr.html_url, repo: repoSlug, state: pr.state, created_at: pr.created_at });
            if (pr.merged_at && pr.merged_at > since) (result.prs_merged as unknown[]).push({ title: pr.title, url: pr.html_url, repo: repoSlug, merged_at: pr.merged_at });
          }
        }
      } else {
        const { data: events } = await octokit.activity.listEventsForAuthenticatedUser({ username: user, per_page: 100 });
        for (const event of events) {
          if (event.created_at && event.created_at < since) continue;
          if (event.type === "PullRequestEvent" && event.payload) {
            const p = event.payload as { action?: string; pull_request?: { title?: string; html_url?: string; merged?: boolean } };
            const repo = event.repo?.name;
            if (p.action === "opened") (result.prs_opened as unknown[]).push({ title: p.pull_request?.title, url: p.pull_request?.html_url, repo, created_at: event.created_at });
            if (p.action === "closed" && p.pull_request?.merged) (result.prs_merged as unknown[]).push({ title: p.pull_request?.title, url: p.pull_request?.html_url, repo, merged_at: event.created_at });
          }
          if (event.type === "IssueCommentEvent") {
            const p = event.payload as { issue?: { title?: string; html_url?: string }; comment?: { html_url?: string } };
            (result.issues_commented as unknown[]).push({ issue: p.issue?.title, url: p.issue?.html_url, repo: event.repo?.name, commented_at: event.created_at });
          }
        }
      }

      const total = Object.values(result).reduce((s, v) => s + (v as unknown[]).length, 0);
      return { content: [{ type: "text", text: `GitHub activity for ${user} in the last ${days} day(s): ${total} events.\n\n${JSON.stringify(result, null, 2)}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `GitHub API error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// ─── Tool: generate_standup ───────────────────────────────────────────────────

server.tool(
  "generate_standup",
  "Synthesize git commit history (and optionally GitHub activity) into a formatted daily standup update. Pass the raw output from get_git_activity (and optionally get_github_activity) and this tool formats it into a clean, ready-to-paste standup.",
  {
    git_activity: z.string().describe("Raw output from get_git_activity tool"),
    github_activity: z.string().optional().describe("Raw output from get_github_activity tool (optional)"),
    format: z.enum(["slack", "markdown", "email", "plain"]).default("slack").describe("Output format"),
    sections: z.array(z.enum(["yesterday", "today", "blockers"])).default(["yesterday", "today", "blockers"]).describe("Sections to include"),
    tone: z.enum(["concise", "detailed", "client-facing"]).default("concise").describe("Tone: concise (bullet), detailed (narrative), client-facing (professional prose)"),
    your_name: z.string().optional().describe("Your name for sign-off (client-facing tone only)"),
    blockers: z.string().optional().describe("Any blockers or dependencies to mention"),
    planned_today: z.string().optional().describe("What you plan to work on today (if known)"),
  },
  async ({ git_activity, github_activity, format, sections, tone, your_name, blockers, planned_today }) => {
    const hasGit = git_activity && !git_activity.includes("No commits found");
    const hasGitHub = github_activity && !github_activity.includes("not configured") && !github_activity.includes("0 events");

    let contextBlock = `=== GIT ACTIVITY ===\n${git_activity}\n`;
    if (hasGitHub) contextBlock += `\n=== GITHUB ACTIVITY ===\n${github_activity}\n`;

    const formatInstructions: Record<string, string> = {
      slack: "Format for Slack: use *bold* for section headers, bullet points with •, keep it scannable in 3-5 lines total",
      markdown: "Format as Markdown: use ## headers and - bullet points",
      email: "Format as a professional email-ready update: prose paragraphs, no emoji",
      plain: "Format as plain text, no markup",
    };

    const toneInstructions: Record<string, string> = {
      concise: "Be concise — 3-5 bullets max. Skip trivial commits (merge commits, version bumps). Group related commits into one theme.",
      detailed: "Include more detail — mention specific files, PR numbers, and technical context. Aim for 5-8 bullets.",
      "client-facing": "Write in professional client-facing prose. Focus on business outcomes and deliverables, not technical commit messages. Start with what was shipped, then what comes next.",
    };

    const sectionList = sections.join(", ");
    const blockersText = blockers ? `Blockers: ${blockers}` : "Blockers: none";
    const todayText = planned_today ? `Planned today: ${planned_today}` : "Infer today's plan from commit patterns and incomplete work visible in the data.";
    const signoff = your_name && tone === "client-facing" ? `\nSign off with: ${your_name}` : "";

    const prompt = `You are generating a daily standup update from developer activity data.

${contextBlock}

Instructions:
- ${formatInstructions[format]}
- ${toneInstructions[tone]}
- Include these sections: ${sectionList}
- ${blockersText}
- ${todayText}
- Do NOT include raw git hashes or timestamps in the output
- Translate commit messages into human-readable accomplishment statements
- If no meaningful activity is found, say so clearly${signoff}

Generate the standup now:`;

    return {
      content: [
        {
          type: "text",
          text: `STANDUP PROMPT (paste into Claude or use in your MCP client):\n\n${prompt}\n\n---\n\nTIP: If you're using Claude Desktop, just say "Generate my standup" after calling get_git_activity — Claude will synthesize the activity automatically without needing this prompt.`,
        },
      ],
    };
  }
);

// ─── Tool: generate_weekly_summary ───────────────────────────────────────────

server.tool(
  "generate_weekly_summary",
  "Generate a weekly engineering summary or freelancer client progress report from git and GitHub activity. Pass raw output from get_git_activity (with days=7) to produce a summary suitable for client reports, invoices, or team updates.",
  {
    git_activity: z.string().describe("Raw output from get_git_activity with days=7"),
    github_activity: z.string().optional().describe("Raw output from get_github_activity with days=7 (optional)"),
    format: z.enum(["email", "client-report", "notion", "slack", "markdown"]).default("email").describe("Output format"),
    audience: z.enum(["team", "manager", "client", "self"]).default("team").describe("Who this summary is for"),
    project_name: z.string().optional().describe("Project or client name to reference in the summary"),
    your_name: z.string().optional().describe("Your name for client-facing formats"),
    include_metrics: z.boolean().default(true).describe("Include commit count, files changed, PR count metrics"),
  },
  async ({ git_activity, github_activity, format, audience, project_name, your_name, include_metrics }) => {
    const hasGitHub = github_activity && !github_activity.includes("not configured") && !github_activity.includes("0 events");
    let contextBlock = `=== WEEKLY GIT ACTIVITY ===\n${git_activity}\n`;
    if (hasGitHub) contextBlock += `\n=== WEEKLY GITHUB ACTIVITY ===\n${github_activity}\n`;

    const audienceInstructions: Record<string, string> = {
      client: "Write for a non-technical client. Focus on business outcomes, deliverables, and progress toward goals. Avoid technical jargon. Make it invoice-defensible — the client should understand exactly what was done and why it has value.",
      manager: "Write for an engineering manager. Include technical detail, velocity indicators, and flag any technical debt or scope concerns.",
      team: "Write for a team Slack update. Concise, bullet-pointed, with enough detail for teammates to understand what you shipped.",
      self: "Write a personal 'what I shipped this week' retrospective. Honest, detailed, including what went well and what was slower than expected.",
    };

    const projectLine = project_name ? `Project: ${project_name}` : "";
    const signoffLine = your_name && (audience === "client" || audience === "manager") ? `Sign off with: ${your_name}` : "";
    const metricsLine = include_metrics ? "Include a summary metrics line (e.g. X commits, Y files changed, Z PRs merged)." : "";

    const prompt = `You are generating a weekly progress summary from developer activity data.

${contextBlock}

Instructions:
- Audience: ${audience}. ${audienceInstructions[audience]}
- Format: ${format}
${projectLine}
${metricsLine}
- Group commits into themes/epics (e.g. "Authentication system", "Dashboard UI", "Bug fixes")
- Do NOT list raw commit hashes
- If GitHub activity is provided, mention notable PRs and reviews${signoffLine}

Generate the weekly summary now:`;

    return {
      content: [
        {
          type: "text",
          text: `WEEKLY SUMMARY PROMPT:\n\n${prompt}\n\n---\n\nTIP: Call get_git_activity with days=7 first, then pass the output to this tool.`,
        },
      ],
    };
  }
);

// ─── Tool: list_configured_sources ────────────────────────────────────────────

server.tool(
  "list_configured_sources",
  "Show which activity sources are configured and ready to use. Checks for GITHUB_TOKEN, GITHUB_USERNAME, and local git repos. Use this to understand what data get_git_activity and get_github_activity will return.",
  {},
  async () => {
    const hasToken = !!process.env.GITHUB_TOKEN;
    const hasUsername = !!process.env.GITHUB_USERNAME;
    const workerPath = process.env.HOME ? join(process.env.HOME, "worker") : "/home/orbitosw/worker";
    const repos = detectGitRepos(workerPath);
    const cwdRepos = detectGitRepos(process.cwd());
    const allRepos = [...repos, ...cwdRepos].filter((v, i, a) => a.indexOf(v) === i);

    const lines = [
      "## StandupCraft — Configured Sources",
      "",
      `**Git repos detected:** ${allRepos.length}`,
      ...allRepos.map((r) => `  • ${r}`),
      "",
      `**GitHub API:** ${hasToken ? "✓ GITHUB_TOKEN set" : "✗ GITHUB_TOKEN not set — set it to enable PR/issue activity"}`,
      `**GitHub username:** ${hasUsername ? `✓ GITHUB_USERNAME=${process.env.GITHUB_USERNAME}` : "✗ GITHUB_USERNAME not set — pass username parameter to get_github_activity"}`,
      "",
      "**Quick start:**",
      "1. Call `get_git_activity` — works immediately, no setup needed",
      "2. Call `generate_standup` with the output — Claude will write your standup",
      "",
      "**To enable GitHub activity:**",
      "1. Create a token at github.com/settings/tokens (read:repo scope)",
      "2. Set GITHUB_TOKEN=<token> in your MCP server environment",
      "3. Set GITHUB_USERNAME=<your-handle> (or pass username to get_github_activity)",
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
