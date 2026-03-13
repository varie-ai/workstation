#!/usr/bin/env node
/**
 * wctl - Standalone CLI for controlling Varie Workstation sessions
 * Adapted from varie-workstation/plugin/scripts/workstation-dispatch.js
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Socket helpers (from workstation-dispatch.js) ---

function getDaemonInfo() {
  const daemonInfoPath = path.join(os.homedir(), '.varie-workstation', 'daemon.json');
  if (!fs.existsSync(daemonInfoPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(daemonInfoPath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function getSocketPath() {
  const info = getDaemonInfo();
  return (info && info.socketPath) || '/tmp/varie-workstation.sock';
}

function sendCommand(json, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();

    if (!fs.existsSync(socketPath)) {
      reject(new Error('Workstation daemon not running (socket not found)'));
      return;
    }

    const client = net.createConnection(socketPath);
    let response = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        reject(new Error('Timeout waiting for response'));
      }
    }, timeoutMs);

    client.on('connect', () => {
      client.write(json + '\n');
    });

    client.on('data', (data) => {
      response += data.toString();
      if (response.includes('\n')) {
        clearTimeout(timeout);
        resolved = true;
        client.end();
        resolve(response.trim());
      }
    });

    client.on('end', () => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        if (response) {
          resolve(response.trim());
        } else {
          reject(new Error('Connection closed without response'));
        }
      }
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

// --- Human-readable formatter ---

function timeAgo(dateStr) {
  if (!dateStr) return 'unknown';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatHuman(command, jsonStr) {
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return jsonStr;
  }

  if (data.status === 'error') {
    return `Error: ${data.message}${data.suggestions ? '\nSuggestions: ' + data.suggestions.join(', ') : ''}`;
  }

  switch (command) {
    case 'status': {
      const info = getDaemonInfo();
      if (!info) return 'Workstation: not running (no daemon info)';
      const lines = [`Workstation: running (PID ${info.pid})`];
      lines.push(`Socket: ${info.socketPath}`);
      if (info.startedAt) lines.push(`Up since: ${timeAgo(info.startedAt)}`);
      if (data.workers) lines.push(`Workers: ${data.workers.length} active`);
      return lines.join('\n');
    }

    case 'list': {
      const workers = data.workers || [];
      if (workers.length === 0) return 'Workstation: no active sessions';
      const lines = [`Workstation: ${workers.length} session${workers.length > 1 ? 's' : ''} active\n`];
      for (const w of workers) {
        lines.push(`  ${w.repo || 'unknown'} (${w.sessionId ? w.sessionId.slice(0, 8) : '?'})`);
        const parts = [];
        if (w.taskId) parts.push(`Task: ${w.taskId}`);
        parts.push(`Active ${timeAgo(w.lastActive)}`);
        lines.push(`    ${parts.join(' | ')}`);
        if (w.workContext) lines.push(`    ${w.workContext}`);
      }
      return lines.join('\n');
    }

    case 'dispatch':
      return `Dispatched to ${data.targetSessionId || 'session'}${data.confirmBeforeSend ? ' (awaiting confirmation)' : ''}`;

    case 'dispatch-answers':
      return `Dispatched ${data.answerCount || '?'} answers to ${data.targetSessionId || 'session'}`;

    case 'route': {
      let msg = `Routed to ${data.targetSessionId || 'session'}`;
      if (data.autoCreated) msg += ' (new session created)';
      if (data.confirmBeforeSend) msg += ' (awaiting confirmation)';
      return msg;
    }

    case 'create':
      return `Created session: ${data.newSessionId || 'unknown'}`;

    case 'focus':
      return `Focused session ${data.targetSessionId || 'unknown'}`;

    case 'escape':
      return `Sent Escape to session ${data.targetSessionId || 'unknown'}`;

    case 'interrupt':
      return `Sent Ctrl+C to session ${data.targetSessionId || 'unknown'}`;

    case 'enter':
      return `Sent Enter to session ${data.targetSessionId || 'unknown'}`;

    case 'screenshot':
      if (data.imagePath) return `Screenshot saved: ${data.imagePath}`;
      return `Screenshot failed (no image captured)`;

    case 'discover': {
      let msg = `Discovered ${data.total || 0} repos`;
      if (data.newCount) msg += `, ${data.newCount} new`;
      return msg;
    }

    default:
      return JSON.stringify(data, null, 2);
  }
}

// --- Status command (local, no socket command needed) ---

async function runStatus(human) {
  const info = getDaemonInfo();
  if (!info) {
    const result = { status: 'error', message: 'Workstation daemon not running (no daemon.json)' };
    console.log(human ? formatHuman('status', JSON.stringify(result)) : JSON.stringify(result));
    process.exit(1);
  }

  // Check if PID is alive
  let pidAlive = false;
  try {
    process.kill(info.pid, 0);
    pidAlive = true;
  } catch {
    pidAlive = false;
  }

  if (!pidAlive) {
    const result = { status: 'error', message: `Workstation daemon not running (PID ${info.pid} dead)` };
    console.log(human ? formatHuman('status', JSON.stringify(result)) : JSON.stringify(result));
    process.exit(1);
  }

  // Ping socket with list_workers to verify responsiveness
  try {
    const resp = await sendCommand(JSON.stringify({
      type: 'list_workers',
      sessionId: 'wctl-status-' + Date.now(),
      timestamp: Date.now()
    }), 5000);

    const parsed = JSON.parse(resp);
    const result = {
      status: 'ok',
      pid: info.pid,
      socketPath: info.socketPath,
      startedAt: info.startedAt,
      version: info.version,
      workers: parsed.workers || []
    };
    console.log(human ? formatHuman('status', JSON.stringify(result)) : JSON.stringify(result));
  } catch (err) {
    const result = {
      status: 'ok',
      pid: info.pid,
      socketPath: info.socketPath,
      startedAt: info.startedAt,
      version: info.version,
      warning: `Socket ping failed: ${err.message}`
    };
    console.log(human ? formatHuman('status', JSON.stringify(result)) : JSON.stringify(result));
  }
}

// --- Main ---

async function main() {
  const rawArgs = process.argv.slice(2);

  // Extract flags
  const human = rawArgs.includes('--human') || rawArgs.includes('-H');
  const args = rawArgs.filter(a => a !== '--human' && a !== '-H');

  const command = args[0] || 'help';
  const sessionId = 'wctl-' + Date.now();

  // Status is handled locally
  if (command === 'status') {
    await runStatus(human);
    return;
  }

  let json;
  let timeout = 5000;
  let cmdKey = command; // for formatHuman

  switch (command) {
    case 'list':
    case 'list-workers':
    case 'list_workers':
    case 'workers':
      cmdKey = 'list';
      json = JSON.stringify({
        type: 'list_workers',
        sessionId,
        timestamp: Date.now()
      });
      break;

    case 'dispatch':
      cmdKey = 'dispatch';
      if (args.length < 3) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl dispatch <session-id> <message>' }));
        process.exit(1);
      }
      json = JSON.stringify({
        type: 'dispatch',
        sessionId,
        timestamp: Date.now(),
        payload: {
          targetSessionId: args[1],
          message: args.slice(2).join(' '),
          remote: true
        }
      });
      timeout = 10000;
      break;

    case 'dispatch-answers':
    case 'dispatch_answers': {
      cmdKey = 'dispatch-answers';
      // Extract flags
      const daArgs = args.slice(1);
      let optionCounts = undefined;
      let chatArrows = undefined;
      const ocIdx = daArgs.indexOf('--option-counts');
      if (ocIdx !== -1 && daArgs[ocIdx + 1]) {
        optionCounts = daArgs[ocIdx + 1].split(',').map(Number);
        daArgs.splice(ocIdx, 2);
      }
      const caIdx = daArgs.indexOf('--chat-arrows');
      if (caIdx !== -1 && daArgs[caIdx + 1]) {
        chatArrows = parseInt(daArgs[caIdx + 1], 10);
        daArgs.splice(caIdx, 2);
      }
      if (daArgs.length < 2 && !chatArrows) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl dispatch-answers <session-id> [--option-counts N,M,...] [--chat-arrows N] <answer1> ...' }));
        process.exit(1);
      }
      const daSessionId = daArgs[0];
      const answers = daArgs.slice(1);
      const daPayload = {
        targetSessionId: daSessionId,
        answers: answers.length > 0 ? answers : ['noop'],
        remote: true
      };
      if (optionCounts) daPayload.optionCounts = optionCounts;
      if (chatArrows) daPayload.chatArrows = chatArrows;
      json = JSON.stringify({
        type: 'dispatch_answers',
        sessionId,
        timestamp: Date.now(),
        payload: daPayload
      });
      // Timeout scales with number of answers (2s per answer + 5s buffer + extra for arrow navigation)
      timeout = (answers.length * 2500) + 5000;
      break;
    }

    case 'route':
      cmdKey = 'route';
      if (args.length < 3) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl route <query> <message>' }));
        process.exit(1);
      }
      json = JSON.stringify({
        type: 'route',
        sessionId,
        timestamp: Date.now(),
        payload: {
          query: args[1],
          message: args.slice(2).join(' '),
          remote: true
        }
      });
      timeout = 60000;
      break;

    case 'create':
    case 'create-worker':
    case 'create_worker': {
      cmdKey = 'create';
      const cwArgs = args.slice(1).filter(a => a !== '--skip-permissions');
      const hasSkipPerms = args.includes('--skip-permissions');
      if (cwArgs.length < 2) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl create <repo> <path> [task-id] [--skip-permissions]' }));
        process.exit(1);
      }
      const payload = {
        repo: cwArgs[0],
        repoPath: cwArgs[1],
        taskId: cwArgs[2] || '',
        remote: true
      };
      if (hasSkipPerms) payload.claudeFlags = '--dangerously-skip-permissions';
      json = JSON.stringify({
        type: 'create_worker',
        sessionId,
        timestamp: Date.now(),
        payload
      });
      timeout = 10000;
      break;
    }

    case 'focus':
    case 'focus-session':
    case 'focus_session': {
      cmdKey = 'focus';
      if (args.length < 2) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl focus <session-id>' }));
        process.exit(1);
      }
      json = JSON.stringify({
        type: 'focus_session',
        sessionId,
        timestamp: Date.now(),
        payload: { targetSessionId: args[1] }
      });
      timeout = 5000;
      break;
    }

    case 'escape': {
      cmdKey = 'escape';
      if (args.length < 2) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl escape <session-id>' }));
        process.exit(1);
      }
      json = JSON.stringify({
        type: 'send_escape',
        sessionId,
        timestamp: Date.now(),
        payload: { targetSessionId: args[1] }
      });
      timeout = 5000;
      break;
    }

    case 'interrupt': {
      cmdKey = 'interrupt';
      if (args.length < 2) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl interrupt <session-id>' }));
        process.exit(1);
      }
      json = JSON.stringify({
        type: 'send_interrupt',
        sessionId,
        timestamp: Date.now(),
        payload: { targetSessionId: args[1] }
      });
      timeout = 5000;
      break;
    }

    case 'enter': {
      cmdKey = 'enter';
      if (args.length < 2) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl enter <session-id>' }));
        process.exit(1);
      }
      json = JSON.stringify({
        type: 'send_enter',
        sessionId,
        timestamp: Date.now(),
        payload: { targetSessionId: args[1] }
      });
      timeout = 5000;
      break;
    }

    case 'screenshot': {
      cmdKey = 'screenshot';
      if (args.length < 2) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl screenshot <session-id> | --screen [display-num]' }));
        process.exit(1);
      }
      if (args[1] === '--screen') {
        json = JSON.stringify({
          type: 'screenshot',
          sessionId,
          timestamp: Date.now(),
          payload: { mode: 'screen', displayNumber: parseInt(args[2], 10) || 1 }
        });
      } else {
        json = JSON.stringify({
          type: 'screenshot',
          sessionId,
          timestamp: Date.now(),
          payload: { mode: 'session', targetSessionId: args[1] }
        });
      }
      timeout = 10000;
      break;
    }

    case 'set-remote-mode':
    case 'set_remote_mode':
    case 'remote-mode': {
      cmdKey = 'set-remote-mode';
      const modeArg = (args[1] || '').toLowerCase();
      if (modeArg !== 'on' && modeArg !== 'off') {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: wctl set-remote-mode on|off' }));
        process.exit(1);
      }
      json = JSON.stringify({
        type: 'set_remote_mode',
        sessionId,
        timestamp: Date.now(),
        payload: { enabled: modeArg === 'on' }
      });
      timeout = 5000;
      break;
    }

    case 'discover':
    case 'discover-projects':
    case 'discover_projects': {
      cmdKey = 'discover';
      const discoverPath = args[1];
      json = JSON.stringify({
        type: 'discover_projects',
        sessionId,
        timestamp: Date.now(),
        payload: discoverPath ? { path: discoverPath } : {}
      });
      timeout = 10000;
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(`wctl - Control Varie Workstation sessions

Commands:
  status                              Check if workstation is running
  list                                List all active sessions
  dispatch <id> <message>             Send command to specific session
  dispatch-answers <id> [--option-counts N,M] [--chat-arrows N] <a1> <a2>...
                                      Send multi-question answers. Tokens: number, enter, next
                                      --chat-arrows: select "Chat about this" (N arrow-downs)
  route <query> <message>             Auto-route to best matching session
  create <repo> <path> [task]         Create a new session
  focus <id>                          Focus session full-screen (agent mode)
  escape <id>                         Send Escape key to session (cancel prompt/menu)
  interrupt <id>                      Send Ctrl+C to session (stop running process)
  enter <id>                          Send Enter key to session (confirm/dismiss)
  screenshot <id>                     Screenshot a session (focus + capture)
  screenshot --screen [display-num]   Screenshot full display (1=main, 2=secondary)
  set-remote-mode on|off              Enable/disable remote mode (bridge auto-focus)
  discover [path]                     Scan for project repos

Flags:
  --human, -H                   Human-readable output (for messaging)
  --skip-permissions            Skip Claude permissions (create only)

Examples:
  wctl status
  wctl list --human
  wctl dispatch abc123 "run the tests"
  wctl dispatch-answers abc123 2 1 3              # single-select questions
  wctl dispatch-answers abc123 --option-counts 5,3 1 2 next 2   # with multi-select
  wctl route varie_character "check git status"
  wctl create algo_trading ~/workplace/projects/algo_trading backtest`);
      process.exit(0);
      break;

    default:
      console.log(JSON.stringify({ status: 'error', message: `Unknown command: ${command}. Run wctl --help` }));
      process.exit(1);
  }

  try {
    const response = await sendCommand(json, timeout);
    console.log(human ? formatHuman(cmdKey, response) : response);
  } catch (err) {
    const errJson = JSON.stringify({ status: 'error', message: err.message });
    console.log(human ? formatHuman(cmdKey, errJson) : errJson);
    process.exit(1);
  }
}

main();
