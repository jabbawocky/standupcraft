# StandupCraft — MCP Server for Developer Standups & Client Reports

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: >=18](https://img.shields.io/badge/Node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

> **MCP server that reads your git commits and GitHub activity to generate daily standups, weekly client reports, and sprint retros — inside Claude Desktop.**

Stop reconstructing what you did yesterday from memory. StandupCraft reads your actual git history and GitHub events, then lets Claude write your standup in your voice.

**Install:** `npx -y github:jabbawocky/standupcraft`  
**Works with:** Claude Desktop, Claude Code, Cursor, Windsurf, any MCP-compatible client  
**Requires:** Node.js 18+, git (pre-installed on every dev machine)

---

## What it does

| Tool | What it does |
|---|---|
| `get_git_activity` | Read local git commits across all your repos for any time range — no API key needed |
| `get_github_activity` | Fetch PRs opened/merged, reviews, and issue comments from GitHub (needs GITHUB_TOKEN) |
| `generate_standup` | Format activity data into a ready-to-paste standup (Slack, email, Markdown) |
| `generate_weekly_summary` | Produce a weekly client report or team update from 7 days of activity |
| `list_configured_sources` | Show which data sources are active and which repos are detected |

---

## Quick start

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "standupcraft": {
      "command": "npx",
      "args": ["-y", "github:jabbawocky/standupcraft"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add standupcraft npx -- -y github:jabbawocky/standupcraft
```

Then just say in Claude:

> *"Write my daily standup"*

Claude will call `get_git_activity`, read your commits from the past 24 hours, and generate a clean standup automatically.

---

## Example prompts

- *"Write my daily standup for Slack"*
- *"What did I ship this week? Format it as a client email."*
- *"Generate a weekly progress report for my client — client-facing tone, project name: API Redesign"*
- *"What have I been working on for the past 3 days?"*
- *"Write a standup update — blockers: waiting on design review, planning to finish auth today"*

---

## GitHub activity (optional)

For PR-level detail, set `GITHUB_TOKEN`:

```json
{
  "mcpServers": {
    "standupcraft": {
      "command": "npx",
      "args": ["-y", "github:jabbawocky/standupcraft"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "GITHUB_USERNAME": "your-github-handle"
      }
    }
  }
}
```

Git activity works with no config at all — just install and go.

---

## Who it's for

**Individual developers** who spend 5–15 minutes every morning reconstructing what they did yesterday before standup. StandupCraft reads your git log so you don't have to.

**Freelancers and consultants** who write the same "what I shipped this week" narrative multiple times — once for their internal standup, once for a client progress email, once for an invoice note. StandupCraft generates all three from one data source.

**Engineering leads** who compile their team's activity into weekly stakeholder summaries. Point StandupCraft at multiple repos and get a synthesized narrative.

---

## How it works

1. `get_git_activity` runs `git log` locally — no data leaves your machine, no API key required
2. `get_github_activity` (optional) calls the GitHub REST API with your token
3. `generate_standup` passes the raw activity data to Claude as a structured prompt
4. Claude writes your standup in the requested tone and format

All data stays local except the optional GitHub API call. No cloud storage, no account required.

---

## License

MIT
