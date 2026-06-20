# claude-nonstop

[![npm](https://img.shields.io/npm/v/claude-nonstop)](https://www.npmjs.com/package/claude-nonstop)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)

Multi-account switching + Slack remote access for Claude Code.

**Multi-account switching:** When you hit a rate limit mid-session, claude-nonstop kills the idle process, migrates your session to a different account, and resumes — fully automated, zero downtime.

**Slack remote access:** Each Claude Code session gets a dedicated Slack channel. Send messages in the channel to control Claude remotely. Claude's responses are posted back to the channel.

![claude-nonstop: Slack remote access and multi-account switching](assets/screenshot.png)

> **Platform:** Tested on macOS only. Linux may work but is untested.

[Contributing](CONTRIBUTING.md) | [Security Policy](SECURITY.md) | [Architecture](DESIGN.md)

## Usage

```bash
claude-nonstop                       # Run Claude (best account, auto-switching)
claude-nonstop -p "fix the bug"      # One-shot prompt
claude-nonstop status                # Show usage across all accounts
claude-nonstop --remote-access       # Run with tmux + Slack channels
```

Sample `status` output:

```
  default (alice@gmail.com)
    5-hour:  ███░░░░░░░░░░░░░░░░░ 14%
    7-day:   ██████░░░░░░░░░░░░░░ 29%

  work (alice@company.com) <-- best
    5-hour:  █░░░░░░░░░░░░░░░░░░░ 3%
    7-day:   ██░░░░░░░░░░░░░░░░░░ 8%
```

On launch, claude-nonstop checks usage across all accounts and picks the one with the most headroom. If you hit a rate limit mid-session, it automatically switches to the next best account and resumes your conversation.

## Commands

**Core:**

| Command | Description |
|---------|-------------|
| `status` | Show usage with progress bars and reset times (Enterprise usage-based accounts show a spend bar instead) |
| `add <name>` | Add a new Claude account (opens browser for OAuth) |
| `remove <name>` | Remove an account |
| `list` | List accounts with auth status |
| `reauth` | Re-authenticate expired accounts |
| `resume [id]` | Resume most recent session, or a specific one by ID |

**Slack remote access:**

| Command | Description |
|---------|-------------|
| `setup` | Configure Slack tokens + install hooks (run `setup --help` for flags) |
| `webhook status` | Show webhook service status |
| `webhook install` | Install webhook as launchd service (macOS) |
| `webhook logs` | Tail the webhook log |
| `hooks install` | Install hooks into all profiles |
| `hooks status` | Show hook installation status |

**Maintenance:**

| Command | Description |
|---------|-------------|
| `update` | Update to latest version |
| `uninstall` | Remove claude-nonstop completely |

Any unrecognized arguments are passed through to `claude` directly. Use `-a <name>` to select a specific account.

## How Enterprise usage limits are tracked

Subscription accounts (Pro/Max) and Enterprise usage-based accounts are metered
differently, and claude-nonstop handles both transparently.

**Two kinds of meter.** Every account is checked against the same OAuth usage
endpoint (`GET /api/oauth/usage`), but the response shape differs:

- **Window-metered** (Pro/Max): the API returns rolling `five_hour` and
  `seven_day` utilization percentages. `status` shows these as the 5-hour / 7-day
  bars. This is the meter you hit mid-work.
- **Spend-metered** (Enterprise usage-based): the API returns `five_hour` and
  `seven_day` as `null` and instead a `spend` block with `used`, `limit`, and
  `percent` in USD (minor units / cents). `status` shows a dollar bar, e.g.
  `spend: ████████░░ 65% ($649.13 / $1,000.00)`.

An account is treated as spend-metered **only when both rolling windows are
null**. Enterprise's plan is purely dollar-based; Pro/Max accounts also carry a
`spend` block (their extra-usage overage cap), but their real meter is the
rolling window, so they stay window-metered and their live session/weekly usage
is never hidden behind the overage number.

**The cap is always read live.** The spend limit is taken from the API's
`spend.limit` on every check — there is no cached or hardcoded cap — so if your
org's limit changes, claude-nonstop picks it up on the next `status` or account
selection. The percentage is computed locally from `used / limit` rather than
trusting the API's reported `percent`, which has been observed to briefly lag
during high-traffic periods.

**Kept up to date automatically.** Usage is re-fetched fresh on every `status`
call and every account selection (launch, switch, `use --best`), and the
preemption watcher re-polls every 5 minutes while running. There is no
separate polling daemon — freshness comes from fetching on demand. An Enterprise
account that is over its monthly cap (`spend.percent` ≥ 100%) folds into the same
effective-utilization logic as a rate-limited subscription account, so the scorer
stops routing to it and resumes after the monthly reset.

**Monthly reset.** Enterprise spend caps reset at **00:00 UTC on the 1st of each
calendar month** — a fixed, universal rule confirmed against Anthropic's official
Spend Limits API documentation (the same for every org, independent of the
subscription start date). The API does not expose the reset datetime, so
claude-nonstop computes it locally and displays it in US Pacific time, labeled
`(computed)` — e.g. `Resets: Jun 30, 5:00 PM PDT (computed)`. Note this is the
*spend* reset specifically; it is distinct from the rolling 5-hour/7-day rate
limits (which reset on their own rolling windows) and from Enterprise seat-fee
billing (charged on the contract anniversary, not the 1st).

## Install

The easiest way to install is to ask Claude Code:

```
You: set up claude-nonstop for me
```

Claude Code will follow the [setup instructions in CLAUDE.md](CLAUDE.md#setting-up-claude-nonstop-for-a-user) to install, configure accounts, and set up Slack remote access interactively. That file also serves as a reference for AI agents automating the setup.

### Manual install

**Prerequisites:** Node.js 22+ ([download](https://nodejs.org/)), C/C++ build tools (`xcode-select --install` on macOS), Claude Code CLI ([install](https://docs.anthropic.com/en/docs/claude-code/overview)), and tmux for remote access.

```bash
npm install -g claude-nonstop
claude-nonstop help
```

If `npm install -g` fails with compilation errors, you're missing C/C++ build tools.

<details>
<summary>Install from source (for development)</summary>

```bash
git clone https://github.com/rchaz/claude-nonstop.git
cd claude-nonstop
npm install -g "$(npm pack)"
```
</details>

## Multi-Account Setup

Your existing `~/.claude` account is auto-detected as "default". Verify with `claude-nonstop list`.

Add additional accounts (each must be a different Claude organization). Two accounts can share the same email if they belong to different orgs. Names can contain letters, numbers, hyphens, and underscores:

```bash
claude-nonstop add work
claude-nonstop add personal
```

Each `add` opens your browser for OAuth. After login, claude-nonstop checks for duplicate accounts (same organization) and removes them automatically.

Verify all accounts are working:

```bash
claude-nonstop status
```

Then just run `claude-nonstop` — rate limit switching is automatic.

**Troubleshooting:**
- OAuth didn't complete? Run `claude-nonstop reauth`
- Status shows `error (HTTP 401)`? Run `claude-nonstop reauth`
- "No credentials found"? Run `CLAUDE_CONFIG_DIR="$HOME/.claude-nonstop/profiles/<name>" claude auth login`

**Optional aliases** (`~/.zshrc` or `~/.bashrc`):

```bash
alias claude='claude-nonstop'
alias cn='claude-nonstop --dangerously-skip-permissions'
```

## Slack Remote Access

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) > **Create New App** > **From a manifest**. Paste [`slack-manifest.yaml`](slack-manifest.yaml), click **Create**, then **Install to Workspace**.

<details>
<summary>Manual setup (without manifest)</summary>

Create a new app at [api.slack.com/apps](https://api.slack.com/apps). Enable Socket Mode (Settings > Socket Mode). Add bot token scopes: `chat:write`, `channels:manage`, `channels:history`, `channels:read`, `reactions:read`, `reactions:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`. Subscribe to bot events: `message.channels`, `message.im`, `app_mention`. Install to workspace.
</details>

**Collect two tokens:**

1. **Bot Token** (`xoxb-...`) — OAuth & Permissions page (created on install)
2. **App Token** (`xapp-...`) — Basic Information > App-Level Tokens > **Generate Token and Scopes** > add `connections:write` scope > Generate

### 2. Run setup

```bash
claude-nonstop setup --bot-token xoxb-... --app-token xapp-... --invite-user-id U12345ABCDE
```

This writes `~/.claude-nonstop/.env`, installs hooks, and starts the webhook service (macOS). Run `setup --help` for all flags. For interactive setup, just run `claude-nonstop setup`.

Find your Slack User ID: click your profile picture > Profile > three-dot menu > Copy member ID.

### 3. Verify

```bash
claude-nonstop webhook status    # Should show "running" with a PID
claude-nonstop hooks status      # All should show "installed"
```

### 4. Run with remote access

```bash
claude-nonstop --remote-access
```

This creates a tmux session named after the current directory, enables `--dangerously-skip-permissions` for unattended operation, and sets `CLAUDE_REMOTE_ACCESS=true` so each session gets a dedicated Slack channel (e.g., `#cn-myproject-abc12345`). Reply in the channel to send messages to Claude.

**Control commands** in session channels:

| Command | Action |
|---------|--------|
| `!stop` | Interrupt Claude (Ctrl+C) |
| `!status` | Show current terminal output |
| `!cmd <text>` | Relay text verbatim (e.g. `!cmd /clear`) |
| `!help` | List available commands |
| `!archive` | Archive the channel |

**Note:** Slack message relay sends keystrokes to tmux. Claude must be waiting for input to receive messages. If Claude is mid-processing, keystrokes queue and are delivered when Claude next waits.

**Security:** `--remote-access` implies `--dangerously-skip-permissions`, giving Claude full system access. Use `SLACK_ALLOWED_USERS` to restrict who can send commands via Slack.

**Troubleshooting:**
- Channel not created? Run `claude-nonstop hooks install` then `hooks status`
- Webhook not receiving? Run `claude-nonstop webhook status` then `webhook logs`
- Messages not reaching Claude? Check `tmux ls` and that Claude is waiting for input

## How It Works

**Multi-account switching** queries the Anthropic usage API for all accounts (~200ms), picks the one with the most headroom, then monitors Claude's output for rate limit messages in real-time. On detection: kill, migrate session files to the next account, resume with `claude --resume`.

**Preempting back to a higher-priority account.** Rate-limit switching only moves *down* the priority list — it reacts to a limit on the current account and never climbs back on its own. Without a counterpart, a long session that fell back to a last-resort account (e.g. a metered Enterprise account) would stay there for hours even after the preferred account's rolling window reset, because no rate limit fires to trigger a re-check. So while parked on a non-top-priority account, a background watcher re-polls usage every 5 minutes and, the moment a strictly higher-priority account drops below the "freed up" threshold (90% by default, kept under the 98% exhaustion cutoff so it never swaps onto a near-full account), it migrates the session back up. Preemptive swaps reuse the same migrate/resume path and don't count against the swap budget. The watcher only arms when you've set account priorities and at least one account outranks the current one; tune it with `CLAUDE_NONSTOP_PREEMPT_INTERVAL_MS` (poll interval in ms — set to `0` to disable) and `CLAUDE_NONSTOP_PREEMPT_THRESHOLD` (the freed-up percentage).

**Slack remote access** uses Claude Code [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — `SessionStart` creates a Slack channel, `Stop` posts a completion summary. A separate webhook process connects via Slack Socket Mode and relays channel messages to tmux. The runner scrapes PTY output for tool activity and posts progress updates to Slack every ~10 seconds.

## Architecture

```
claude-nonstop/
├── bin/claude-nonstop.js         CLI entry point and command routing
├── lib/                          Core logic (ESM)
│   ├── config.js                 Account registry
│   ├── keychain.js               OS credential store reading
│   ├── usage.js                  Anthropic usage API client
│   ├── scorer.js                 Best-account selection
│   ├── session.js                Session file migration
│   ├── runner.js                 Process wrapper + rate limit detection
│   ├── service.js                launchd service management (macOS)
│   ├── tmux.js                   tmux session management
│   ├── reauth.js                 Re-authentication flow
│   └── platform.js               OS detection
├── remote/                       Slack remote access subsystem (CJS)
│   ├── hook-notify.cjs           Hook entry point
│   ├── channel-manager.cjs       Slack channel lifecycle
│   ├── webhook.cjs               Socket Mode handler (Slack -> tmux)
│   ├── start-webhook.cjs         Webhook process entry point
│   ├── load-env.cjs              Environment file loader
│   └── paths.cjs                 Shared path constants
└── scripts/postinstall.js        Restart webhook on npm install
```

User data lives under `~/.claude-nonstop/` (config, `.env`, profiles, logs). See [DESIGN.md](DESIGN.md) for details.

## Troubleshooting

### `npm install` fails with compilation errors

`node-pty` requires C/C++ build tools: `xcode-select --install` (macOS), then re-run `npm install`.

### Usage shows "error (HTTP 401)"

OAuth token expired. Run `claude-nonstop reauth` to refresh all expired accounts.

### Webhook not receiving messages

Check `claude-nonstop webhook status` and `webhook logs`. Verify Socket Mode is enabled and bot events (`message.channels`, `message.im`) are subscribed in your Slack app settings.

### Messages not reaching Claude

Claude must be waiting for input. Check `tmux ls` and `~/.claude-nonstop/data/channel-map.json`.

## Platform Support

| Platform | Credential Store | Service Management | Status |
|----------|-----------------|-------------------|--------|
| macOS | Keychain (`security`) | launchd | Tested |
| Linux | Secret Service (`secret-tool`) | Manual (systemd) | Untested |
| Windows | — | — | Not supported |

## License

[MIT](LICENSE)
