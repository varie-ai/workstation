#!/usr/bin/env node
/**
 * workstation-dispatch - Send dispatch commands to Varie Workstation daemon
 * Node.js version for proper long-running request handling
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Get socket path from daemon info
function getSocketPath() {
  const daemonInfoPath = path.join(os.homedir(), '.varie-workstation', 'daemon.json');
  let socketPath = '/tmp/varie-workstation.sock';

  if (fs.existsSync(daemonInfoPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonInfoPath, 'utf-8'));
      socketPath = info.socketPath || socketPath;
    } catch (e) {
      // Use default
    }
  }

  return socketPath;
}

// Send command and wait for response
function sendCommand(json, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();

    if (!fs.existsSync(socketPath)) {
      reject(new Error('Workstation daemon not running'));
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
      // Check if we have a complete JSON response
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

// Escape JSON string
function escapeJson(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const sessionId = process.env.CLAUDE_SESSION_ID || 'orchestrator-' + Date.now();

  let json;
  let timeout = 5000; // Default 5s

  switch (command) {
    case 'list-workers':
    case 'list_workers':
    case 'workers':
      json = JSON.stringify({
        type: 'list_workers',
        sessionId,
        timestamp: Date.now()
      });
      break;

    case 'dispatch':
      if (args.length < 3) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: dispatch <session-id> <message>' }));
        process.exit(1);
      }
      json = JSON.stringify({
        type: 'dispatch',
        sessionId,
        timestamp: Date.now(),
        payload: {
          targetSessionId: args[1],
          message: args.slice(2).join(' ')
        }
      });
      timeout = 10000; // 10s for dispatch
      break;

    case 'route':
      if (args.length < 3) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: route <query> <message>' }));
        process.exit(1);
      }
      json = JSON.stringify({
        type: 'route',
        sessionId,
        timestamp: Date.now(),
        payload: {
          query: args[1],
          message: args.slice(2).join(' ')
        }
      });
      timeout = 60000; // 60s for route (may auto-create and wait for Claude)
      break;

    case 'create-worker':
    case 'create_worker': {
      // Filter out --skip-permissions flag from positional args
      const cwArgs = args.slice(1).filter(a => a !== '--skip-permissions');
      const hasSkipPerms = args.includes('--skip-permissions');
      if (cwArgs.length < 2) {
        console.log(JSON.stringify({ status: 'error', message: 'Usage: create-worker <repo> <path> [task-id] [--skip-permissions]' }));
        process.exit(1);
      }
      const cwPayload = {
        repo: cwArgs[0],
        repoPath: cwArgs[1],
        taskId: cwArgs[2] || ''
      };
      if (hasSkipPerms) {
        cwPayload.claudeFlags = '--dangerously-skip-permissions';
      }
      json = JSON.stringify({
        type: 'create_worker',
        sessionId,
        timestamp: Date.now(),
        payload: cwPayload
      });
      break;
    }

    case 'discover-projects':
    case 'discover_projects':
    case 'discover':
      // Optional path argument: discover-projects [path]
      const discoverPath = args[1];
      json = JSON.stringify({
        type: 'discover_projects',
        sessionId,
        timestamp: Date.now(),
        payload: discoverPath ? { path: discoverPath } : {}
      });
      timeout = 10000; // 10s for discovery
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(`workstation-dispatch - Send dispatch commands to Varie Workstation

Commands:
  list-workers              - List all workers with status
  dispatch <id> <message>   - Send to specific worker by session ID
  route <query> <message>   - Auto-route to best matching worker
  create-worker <repo> <path> [task] [--skip-permissions] - Create new worker
  discover-projects [path]  - Scan for repos and add to projects index
                              If path is a repo, adds just that repo
                              If path is a directory, scans for repos inside
                              If no path, scans default workspace

Examples:
  workstation-dispatch list-workers
  workstation-dispatch dispatch abc123 "check the API status"
  workstation-dispatch route "react-app" "check git status"
  workstation-dispatch create-worker react-app /path/to/repo feature_auth
  workstation-dispatch create-worker react-app /path/to/repo --skip-permissions
  workstation-dispatch discover-projects
  workstation-dispatch discover-projects ~/external_projects
  workstation-dispatch discover-projects ~/code/my-app`);
      process.exit(0);
      break;

    default:
      console.log(JSON.stringify({ status: 'error', message: `Unknown command: ${command}` }));
      process.exit(1);
  }

  try {
    const response = await sendCommand(json, timeout);
    console.log(response);
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', message: err.message }));
    process.exit(1);
  }
}

main();
