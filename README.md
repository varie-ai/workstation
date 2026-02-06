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

### Option A: Download the app (recommended)

The desktop app bundles the plugin — no separate plugin install needed.

1. Download from [GitHub Releases](https://github.com/varie-ai/workstation/releases):
   - **macOS (Apple Silicon):** `*-arm64.dmg`
   - **macOS (Intel):** `*-x64.dmg`

2. Open the DMG and drag **Workstation** to Applications.

3. Launch the app. All Claude Code sessions started from Workstation automatically have the plugin skills available (`/work-start`, `/work-checkpoint`, `/work-status`, etc.).

> **macOS Gatekeeper:** If macOS blocks the app on first launch:
> - **macOS 14 and earlier:** Right-click the app > Open > click Open
> - **macOS 15 (Sequoia):** System Settings > Privacy & Security > "Open Anyway"

### Option B: Install the plugin first

If you prefer to start with the Claude Code plugin (adds skills to standalone Claude Code sessions too):

**Step 1:** Add the marketplace in Claude Code:
```
/plugin marketplace add https://github.com/varie-ai/workstation
```

**Step 2:** Install the plugin:
```
/plugin install varie-workstation@varie-workstation
```

**Step 3:** Restart Claude Code. The plugin's skills are now available.

**Step 4:** On your next session, the Workstation desktop app downloads and launches automatically. To disable: `/workstation autolaunch off`

### Build from source

```bash
git clone https://github.com/varie-ai/workstation.git
cd workstation
npm install
npm run dev
```

## Privacy

Workstation runs entirely on your machine. No telemetry, no analytics, no data sent to any third party.

- **All state is local** — Checkpoints, session data, and configuration live in `~/.varie/` on your filesystem. Nothing is synced or uploaded.
- **Voice (Apple Speech)** — Processed on-device by macOS. Audio never leaves your machine.
- **LLM smart routing (opt-in)** — If you enable voice routing via an LLM provider (Gemini, Claude, GPT), your voice transcript and project repo names are sent to the provider you choose, using your own API key. This feature is off by default.

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
