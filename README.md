# Workstation

Multi-session orchestration for Claude Code with voice control.

*Created by [Varie AI](https://varie.ai)*

## Features

### Session Management
- **Multi-session terminals** — Run multiple Claude Code sessions side-by-side
- **Smart routing** — Auto-dispatch commands to the right session based on repo/task
- **Work checkpoints** — Save and resume work state across sessions
- **Project discovery** — Auto-detect repos and track work progress

### Voice Control
- **Apple Speech** — Fast, offline speech recognition (macOS)
- **LLM-powered routing** — Gemini/Claude/GPT transcribes and routes voice commands
- **Hands-free dispatch** — Speak naturally: "continue the character API work"
- **Transcript refinement** — AI fixes grammar and misheard words

### Orchestration
- **Manager session** — Central terminal for cross-project commands
- **Natural language dispatch** — Route by repo name, task ID, or context
- **Unified status** — See all sessions and projects at a glance

## Installation

### Step 1: Add the marketplace

In Claude Code, run:

```
/plugin marketplace add https://github.com/varie-ai/workstation
```

### Step 2: Install the plugin

```
/plugin install varie-workstation@varie-workstation
```

### Step 3: Restart Claude Code

Close and reopen Claude Code. The plugin's skills (`/work-start`, `/work-checkpoint`, `/work-status`, etc.) are now available.

### Step 4: Desktop app (automatic)

On your next Claude Code session, the Workstation desktop app downloads and launches automatically in the background. This gives you the multi-terminal UI and voice control.

To disable auto-launch: `/workstation autolaunch off`

**Manual download:** See [GitHub Releases](https://github.com/varie-ai/workstation/releases).

- **macOS (Apple Silicon):** `*-arm64.dmg`
- **macOS (Intel):** `*-x64.dmg`

If macOS blocks the app on first launch:
- **macOS 14 and earlier:** Right-click the app > Open > click Open
- **macOS 15 (Sequoia):** System Settings > Privacy & Security > "Open Anyway"

**Build from source:**
```bash
git clone https://github.com/varie-ai/workstation.git
cd workstation
npm install
npm run dev
```

## Quick Start

### Voice Control Setup
1. Open Workstation app
2. Click gear icon (voice settings)
3. Choose provider (Gemini recommended for direct audio)
4. Enter API key
5. Press Ctrl+V or click mic to speak

### Session Workflow
```bash
# From Manager terminal
/work-sessions          # See all active sessions
/route "my-app" "check API status"  # Route to matching session
/dispatch abc123 "run tests"       # Send to specific session

# From any session
/work-start myrepo feature-x       # Start tracking work
/work-checkpoint                   # Save progress
/work-handover                     # Generate handover doc
```

## Skills Reference

| Skill | Description |
|-------|-------------|
| `/workstation` | Configure settings (autoLaunch, skip-permissions), launch app |
| `/work-start` | Initialize task tracking with context loading |
| `/work-checkpoint` | Save structured work state |
| `/work-resume` | Resume previous work via fuzzy matching |
| `/work-recover` | Compare checkpoint vs reality after crash |
| `/work-status` | Show all active tasks across repos |
| `/work-handover` | Generate session handover documentation |
| `/work-report` | Generate work reports for standups and team syncs |
| `/work-summarize` | Quick summary of current session state |
| `/work-sessions` | List all active sessions |
| `/work-stats` | Show token usage statistics |
| `/dispatch` | Send message to specific session by ID |
| `/route` | Auto-route message to best matching session |
| `/projects` | Show all projects with status |
| `/project` | Deep dive into a specific project |
| `/discover-projects` | Scan for new repos and add to index |

## Voice Input Modes

| Mode | Speed | Accuracy | Offline |
|------|-------|----------|---------|
| Apple Speech | Fast | Good | Yes |
| Direct Audio (Gemini) | Medium | Excellent | No |

**Direct Audio** sends the raw audio to Gemini for transcription, providing better accuracy for technical terms and code-related speech.

## Configuration

Settings stored in `~/.varie/config.yaml`:

```yaml
autoLaunch: true  # Auto-start with Claude Code
```

LLM settings stored in `~/.varie/llm-settings.json`.

## Development

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build for distribution
npm run package:mac
npm run package:win
```

## Requirements

- macOS 12+ (Apple Speech), Windows 10+, or Linux
- Node.js 18+
- Claude Code CLI

## License

MIT

## Links

- [GitHub](https://github.com/varie-ai/workstation)
- [Varie AI](https://varie.ai)
