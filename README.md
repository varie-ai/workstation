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

### Plugin Only (CLI skills)
```bash
# From Claude Code
/plugin add varie-workstation
```

Skills like `/work-start`, `/work-checkpoint`, `/work-status` work without the desktop app.

### Full Workstation (Desktop App)
The desktop app provides the multi-terminal UI and voice control.

**Auto-install:** After adding the plugin, run `/workstation autolaunch on` to auto-download and launch.

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
| `/workstation` | Configure settings, launch app |
| `/work-start` | Initialize task tracking |
| `/work-checkpoint` | Save current state |
| `/work-resume` | Resume previous work |
| `/work-status` | Show all active tasks |
| `/work-handover` | Generate handover doc |
| `/work-sessions` | List active sessions |
| `/dispatch` | Send to specific session |
| `/route` | Auto-route by context |
| `/projects` | Show project index |

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
