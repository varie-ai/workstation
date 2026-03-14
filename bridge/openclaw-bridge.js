#!/usr/bin/env node
/**
 * openclaw-bridge.js — Bridge daemon between Workstation events and Telegram/WhatsApp
 *
 * Watches ~/.varie-workstation/events.jsonl for new events from Workstation,
 * applies tier rules (accumulate tool_use, notify on stop/question/plan),
 * captures screenshots, and sends via `openclaw message send`.
 *
 * Telegram is the primary channel; WhatsApp is automatic fallback on failure.
 *
 * Zero LLM cost — uses direct message delivery, no agent turns.
 * Zero npm dependencies — Node.js stdlib only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// =============================================================================
// Configuration
// =============================================================================

const EVENTS_PATH = path.join(os.homedir(), '.varie-workstation', 'events.jsonl');
const SCREENSHOT_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'media');
const SCREENSHOT_TTL_MS = 30 * 60 * 1000; // 30 min TTL for screenshot files
// Notification channels — loaded from OpenClaw config at startup.
// First is primary, rest are fallbacks (tried in order on failure).
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
let CHANNELS = [];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB rotation threshold
const DEBOUNCE_MS = 5000;               // Min 5s between notifications per session
const POLL_INTERVAL_MS = 1000;           // Fallback poll interval
const ROTATION_CHECK_INTERVAL = 10 * 60 * 1000; // Check rotation every 10 min
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const MSG_SPLIT_CHARS = 2000;                  // Split long messages at ~2000 chars (safe margin for 4096 Telegram limit)
const PENDING_PROMPTS_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'pending-prompts.json');
const PENDING_PROMPT_TTL_MS = 10 * 60 * 1000;  // 10 min TTL for pending prompts
const PIDFILE_PATH = path.join(os.homedir(), '.varie-workstation', 'bridge.pid');
const LOG_DIR = path.join(os.homedir(), '.varie-workstation');
const LOG_FILE = path.join(LOG_DIR, 'bridge.log');
const LOG_MAX_SIZE = 2 * 1024 * 1024;          // 2MB — rotate when exceeded
const LOG_TTL_DAYS = 7;                          // Delete rotated logs older than 7 days
const LOG_ROTATE_PREFIX = 'bridge.log.';         // Rotated files: bridge.log.2026-03-14, etc.

// =============================================================================
// OpenClaw Channel Discovery
// =============================================================================

/**
 * Load notification channels from OpenClaw config (~/.openclaw/openclaw.json).
 * Returns array of { name, target } for each enabled channel with allowFrom.
 * Returns [] if OpenClaw is not installed or no channels are configured.
 */
function loadChannels() {
  if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) {
    return [];
  }

  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8'));
    const channels = config.channels || {};
    const result = [];

    for (const [name, cfg] of Object.entries(channels)) {
      if (!cfg.enabled) continue;
      // allowFrom may be inline (dmPolicy: "allowlist") or in credentials file (dmPolicy: "pairing")
      let target = '';
      if (Array.isArray(cfg.allowFrom) && cfg.allowFrom.length > 0) {
        target = String(cfg.allowFrom[0]);
      } else {
        const credPath = path.join(os.homedir(), '.openclaw', 'credentials', `${name}-default-allowFrom.json`);
        try {
          if (fs.existsSync(credPath)) {
            const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
            // Credentials file is { version, allowFrom: [...] } or possibly a flat array
            const ids = Array.isArray(cred) ? cred : (Array.isArray(cred.allowFrom) ? cred.allowFrom : []);
            if (ids.length > 0) target = String(ids[0]);
          }
        } catch { /* ignore credential read errors */ }
      }
      result.push({ name, target });
    }

    return result;
  } catch (err) {
    log('Failed to read OpenClaw config:', err.message);
    return [];
  }
}

// =============================================================================
// State
// =============================================================================

let lastReadPosition = 0;

// Per-project state (keyed by projectPath, since tool_use and stop events have different sessionIds)
// Map<projectPath, { tools: Map<toolName, count>, lastNotifyTs, project }>
const sessionState = new Map();

// Screenshot window ID cache

// Notification gating (controlled by Workstation main process via IPC)
let remoteModeEnabled = false;
let notifyAlways = false;
let notificationChannelsFilter = ''; // comma-separated "channel:target" pairs, empty = all

// Listen for IPC messages from Workstation main process
process.on('message', (msg) => {
  if (msg.type === 'remote-mode') {
    remoteModeEnabled = msg.enabled;
    log('Remote mode:', remoteModeEnabled ? 'ON' : 'OFF');
  } else if (msg.type === 'send-image') {
    // ISSUE-017: Auto-screenshot after dispatch — main process captured the image,
    // we just need to send it via the notification channel.
    const { imagePath, caption } = msg;
    if (imagePath && fs.existsSync(imagePath)) {
      sendImageNotification(imagePath, caption || 'Screenshot');
    } else {
      log('send-image: no valid imagePath');
    }
  } else if (msg.type === 'config') {
    if (msg.notifyAlways !== undefined) notifyAlways = msg.notifyAlways;
    if (msg.remoteModeEnabled !== undefined) remoteModeEnabled = msg.remoteModeEnabled;
    if (msg.notificationChannels !== undefined) notificationChannelsFilter = msg.notificationChannels;
    log('Config updated: notifyAlways=' + notifyAlways, 'remote=' + remoteModeEnabled, 'channels=' + (notificationChannelsFilter || '(all)'));
  }
});

// =============================================================================
// Logging (persistent file + stdout, sync writes for crash safety)
// =============================================================================

let logEnabled = false;

function initLogFile() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logEnabled = true;
  } catch (err) {
    console.error('Failed to init log dir:', err.message);
  }
}

function log(...args) {
  const line = new Date().toISOString() + ' [bridge] ' + args.map(a =>
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(' ');
  console.log(line);
  if (logEnabled) {
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  }
}

function rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stats = fs.statSync(LOG_FILE);
    if (stats.size <= LOG_MAX_SIZE) return;

    const dateStr = new Date().toISOString().split('T')[0];
    const rotatedPath = path.join(LOG_DIR, LOG_ROTATE_PREFIX + dateStr);
    let dest = rotatedPath;
    let counter = 1;
    while (fs.existsSync(dest)) {
      dest = rotatedPath + '.' + counter++;
    }
    fs.renameSync(LOG_FILE, dest);
    log('Log rotated to', path.basename(dest));
  } catch (err) {
    console.error('Log rotation failed:', err.message);
  }
}

function pruneOldLogs() {
  try {
    const now = Date.now();
    const ttl = LOG_TTL_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(LOG_DIR);
    for (const file of files) {
      if (!file.startsWith(LOG_ROTATE_PREFIX)) continue;
      const filePath = path.join(LOG_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > ttl) {
        fs.unlinkSync(filePath);
        log('Pruned old log:', file);
      }
    }
  } catch {}
}

// =============================================================================
// File Watching
// =============================================================================

function initFilePosition() {
  try {
    const stats = fs.statSync(EVENTS_PATH);
    lastReadPosition = stats.size; // Skip existing content on startup
    log('Watching from position', lastReadPosition);
  } catch {
    lastReadPosition = 0;
  }
}

function readNewLines() {
  try {
    const stats = fs.statSync(EVENTS_PATH);

    // File was truncated (rotation)
    if (stats.size < lastReadPosition) {
      lastReadPosition = 0;
    }

    // No new data
    if (stats.size === lastReadPosition) return [];

    const fd = fs.openSync(EVENTS_PATH, 'r');
    const buf = Buffer.alloc(stats.size - lastReadPosition);
    fs.readSync(fd, buf, 0, buf.length, lastReadPosition);
    fs.closeSync(fd);
    lastReadPosition = stats.size;

    return buf.toString('utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') log('Error reading events:', err.message);
    return [];
  }
}

function processNewEvents() {
  const events = readNewLines();
  for (const event of events) {
    handleEvent(event);
  }
}

function startWatching() {
  initFilePosition();

  // Primary: fs.watch
  try {
    fs.watch(EVENTS_PATH, { persistent: true }, (eventType) => {
      if (eventType === 'change') processNewEvents();
    });
    log('fs.watch active on', EVENTS_PATH);
  } catch (err) {
    log('fs.watch failed, using polling only:', err.message);
  }

  // Fallback: polling (fs.watch can be unreliable)
  setInterval(processNewEvents, POLL_INTERVAL_MS);
}

// =============================================================================
// Event Processing
// =============================================================================

function handleEvent(event) {
  const { type, context, payload } = event;
  const project = context?.project || 'unknown';
  const projectPath = context?.projectPath || 'unknown';

  // Key by projectPath — tool_use and stop events share the same project
  // but have different sessionIds (plugin vs PTY session UUIDs)
  if (!sessionState.has(projectPath)) {
    sessionState.set(projectPath, { tools: new Map(), lastNotifyTs: 0, project });
  }
  const state = sessionState.get(projectPath);
  state.project = project;

  switch (type) {
    case 'tool_use': {
      const toolName = payload?.tool || 'unknown';

      // Tier 0: Interactive tools — need user response via WhatsApp
      // Only notify on pre-tool-use (needsApproval=true).
      // Post-tool-use fires AFTER user responds — skip to avoid double notification.
      if (toolName === 'ExitPlanMode' && payload?.needsApproval) {
        notifyPlanApproval(projectPath, state, payload);
        break;
      }
      if (toolName === 'AskUserQuestion' && payload?.needsApproval) {
        notifyQuestionPrompt(projectPath, state, payload);
        break;
      }

      // Tier 3: accumulate tool usage
      state.tools.set(toolName, (state.tools.get(toolName) || 0) + 1);
      break;
    }

    case 'stop':
      // Tier 1: Claude finished turn — screenshot + tool summary
      // Clear any pending prompt for this project (user responded or session moved on)
      clearPendingPrompt(project);
      notifyStop(projectPath, state);
      break;

    case 'question':
    case 'attention_needed':
      // Tier 2: needs input — screenshot + question text
      notifyAttention(projectPath, state, type, payload);
      break;

    case 'session_start':
      notifySimple(projectPath, state, `[${project}] Session started`);
      break;

    case 'session_end':
      notifySimple(projectPath, state, `[${project}] Session ended`);
      sessionState.delete(projectPath);
      break;
  }
}

// =============================================================================
// Pending Prompts (state file for OpenClaw agent context)
// =============================================================================

function readPendingPrompts() {
  try {
    const data = fs.readFileSync(PENDING_PROMPTS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { prompts: [] };
  }
}

function writePendingPrompts(data) {
  try {
    fs.writeFileSync(PENDING_PROMPTS_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    log('Failed to write pending-prompts.json:', err.message);
  }
}

function addPendingPrompt(project, projectPath, type, details) {
  const data = readPendingPrompts();

  // Remove any existing prompt for the same project (replace with new one)
  data.prompts = data.prompts.filter(p => p.project !== project);

  data.prompts.push({
    type,
    project,
    projectPath,
    timestamp: Date.now(),
    ...details
  });

  writePendingPrompts(data);
  log('Pending prompt added:', project, type);
}

function clearPendingPrompt(project) {
  const data = readPendingPrompts();
  const before = data.prompts.length;
  data.prompts = data.prompts.filter(p => p.project !== project);
  if (data.prompts.length < before) {
    writePendingPrompts(data);
    log('Pending prompt cleared:', project);
  }
}

function cleanExpiredPrompts() {
  const data = readPendingPrompts();
  const now = Date.now();
  const before = data.prompts.length;
  data.prompts = data.prompts.filter(p => (now - p.timestamp) < PENDING_PROMPT_TTL_MS);
  if (data.prompts.length < before) {
    writePendingPrompts(data);
    log('Expired prompts cleaned:', before - data.prompts.length);
  }
}

// =============================================================================
// Notification Functions
// =============================================================================

function checkDebounce(state) {
  const now = Date.now();
  if (now - state.lastNotifyTs < DEBOUNCE_MS) return false;
  state.lastNotifyTs = now;
  return true;
}

function formatToolSummary(tools) {
  if (tools.size === 0) return '';
  const parts = [];
  for (const [name, count] of tools) {
    parts.push(`${name} (${count})`);
  }
  return `Tools: ${parts.join(', ')}`;
}


function notifyStop(projectPath, state) {
  if (!checkDebounce(state)) return;

  const toolSummary = formatToolSummary(state.tools);
  let message = `[${state.project}] Claude finished`;
  if (toolSummary) message += `\n\n${toolSummary}`;

  // Reset tool accumulator
  state.tools.clear();

  // Send text immediately, request screenshot from main process (capturePage)
  sendNotification(message, false);
  requestScreenshot(projectPath, `[${state.project}] Claude finished`);
}

function notifyAttention(projectPath, state, type, payload) {
  if (!checkDebounce(state)) return;

  let message;
  if (type === 'question' && payload?.toolInput) {
    // AskUserQuestion — extract the question text
    const q = typeof payload.toolInput === 'string'
      ? payload.toolInput
      : payload.toolInput.question || JSON.stringify(payload.toolInput);
    message = `[${state.project}] Needs input\n\n"${q}"`;
  } else {
    message = `[${state.project}] Attention needed`;
  }

  // Flush accumulated tools too
  const toolSummary = formatToolSummary(state.tools);
  if (toolSummary) {
    message += `\n\n${toolSummary}`;
    state.tools.clear();
  }

  sendNotification(message, false);
  requestScreenshot(projectPath, `[${state.project}] ${type}`);
}

function notifyPlanApproval(projectPath, state, payload) {
  if (!checkDebounce(state)) return;

  const project = state.project;
  let message = `[${project}] Plan ready for review`;

  // Read the most recently modified plan file
  const planExcerpt = readLatestPlan();
  if (planExcerpt) {
    message += `\n\n${planExcerpt}`;
  }

  // Claude Code's ExitPlanMode shows these 4 options:
  message += '\n\n---';
  message += '\n1. Yes, clear context and bypass permissions';
  message += '\n2. Yes, and bypass permissions';
  message += '\n3. Yes, manually approve edits';
  message += '\n4. Type what to change (reply with your feedback)';
  message += '\n\nReply with option number or feedback';

  // Flush accumulated tools
  const toolSummary = formatToolSummary(state.tools);
  if (toolSummary) {
    message += `\n\n${toolSummary}`;
    state.tools.clear();
  }

  // Track pending prompt so OpenClaw agent has context for replies
  addPendingPrompt(project, projectPath, 'plan_approval', {
    options: [
      '1. Yes, clear context and bypass permissions',
      '2. Yes, and bypass permissions',
      '3. Yes, manually approve edits',
      '4. Type feedback'
    ]
  });

  sendNotification(message);
  requestScreenshot(projectPath, `[${state.project}] Plan review`);
}

function notifyQuestionPrompt(projectPath, state, payload) {
  if (!checkDebounce(state)) return;

  const project = state.project;
  let message = `[${project}] Question from Claude\n(Or just describe what you want — I'll use "Chat about this" to pass your input directly)`;

  // Parse AskUserQuestion toolInput
  const toolInput = payload?.toolInput;
  if (toolInput?.questions && Array.isArray(toolInput.questions)) {
    for (const q of toolInput.questions) {
      const questionText = q.question || q.text || '';
      if (questionText) {
        message += q.multiSelect
          ? `\n\n"${questionText}" (select all that apply)`
          : `\n\n"${questionText}"`;
      }

      if (q.options && Array.isArray(q.options)) {
        message += '\n';
        q.options.forEach((opt, i) => {
          const label = typeof opt === 'string' ? opt : (opt.label || opt);
          const desc = (typeof opt === 'object' && opt.description) ? ` — ${opt.description}` : '';
          message += `\n${i + 1}. ${label}${desc}`;
        });
        message += `\n${q.options.length + 1}. Other (type your answer)`;
      }
    }
  } else {
    message += '\n\n(question details unavailable)';
  }

  message += '\n\n---\nReply with option number or your answer';

  // Flush accumulated tools
  const toolSummary = formatToolSummary(state.tools);
  if (toolSummary) {
    message += `\n\n${toolSummary}`;
    state.tools.clear();
  }

  // Track pending prompt — include all questions for agent context
  const questionsList = [];
  if (toolInput?.questions && Array.isArray(toolInput.questions)) {
    for (const q of toolInput.questions) {
      const opts = [];
      if (q.options && Array.isArray(q.options)) {
        q.options.forEach((opt, i) => {
          const label = typeof opt === 'string' ? opt : (opt.label || opt);
          opts.push(`${i + 1}. ${label}`);
        });
        opts.push(`${opts.length + 1}. Other`);
      }
      questionsList.push({ question: q.question || '', options: opts, multiSelect: !!q.multiSelect });
    }
  }
  addPendingPrompt(project, projectPath, 'question', {
    questionCount: questionsList.length,
    questions: questionsList
  });

  sendNotification(message);
  requestScreenshot(projectPath, `[${project}] Question`);
}

function readLatestPlan() {
  try {
    const files = fs.readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(PLANS_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    const latestPath = path.join(PLANS_DIR, files[0].name);
    return fs.readFileSync(latestPath, 'utf-8');
  } catch (err) {
    log('Failed to read plan file:', err.message);
    return null;
  }
}

/**
 * Split a long message into parts at markdown heading or newline boundaries.
 * Each part stays under MSG_SPLIT_CHARS. Adds continuation markers.
 */
function splitMessage(text) {
  if (text.length <= MSG_SPLIT_CHARS) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MSG_SPLIT_CHARS) {
      parts.push(remaining);
      break;
    }

    // Find a split point within the limit
    const chunk = remaining.substring(0, MSG_SPLIT_CHARS);
    let splitAt = -1;

    // Priority 1: Split before a markdown heading (## or ###) — cleanest break
    const headingMatch = chunk.lastIndexOf('\n##');
    if (headingMatch > MSG_SPLIT_CHARS * 0.3) {
      splitAt = headingMatch;
    }

    // Priority 2: Split at a blank line (paragraph boundary)
    if (splitAt === -1) {
      const blankLine = chunk.lastIndexOf('\n\n');
      if (blankLine > MSG_SPLIT_CHARS * 0.3) {
        splitAt = blankLine;
      }
    }

    // Priority 3: Split at any newline
    if (splitAt === -1) {
      const newline = chunk.lastIndexOf('\n');
      if (newline > MSG_SPLIT_CHARS * 0.3) {
        splitAt = newline;
      }
    }

    // Fallback: hard split at limit
    if (splitAt === -1) {
      splitAt = MSG_SPLIT_CHARS;
    }

    parts.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).replace(/^\n+/, ''); // trim leading newlines from next part
  }

  // Add continuation markers
  if (parts.length > 1) {
    for (let i = 0; i < parts.length; i++) {
      const tag = `[Part ${i + 1}/${parts.length}]`;
      if (i < parts.length - 1) {
        parts[i] += `\n\n_${tag} — continued below..._`;
      } else {
        parts[i] = `_${tag}_\n\n` + parts[i];
      }
    }
  }

  return parts;
}

function notifySimple(sessionId, state, message) {
  if (!checkDebounce(state)) return;
  sendNotification(message, false); // No screenshot for simple events
}

/**
 * Request a screenshot from the main Electron process via IPC.
 * Main process will focus the session, call capturePage(), and send back
 * a 'send-image' IPC message which triggers sendImageNotification().
 */
function requestScreenshot(projectPath, caption) {
  if (process.send) {
    process.send({ type: 'request-screenshot', projectPath, caption });
  }
}

// =============================================================================
// Screenshot Cleanup (screenshots now captured by main process via IPC)
// =============================================================================

function cleanupOldScreenshots() {
  try {
    const now = Date.now();
    const files = fs.readdirSync(SCREENSHOT_DIR);
    for (const file of files) {
      if (!file.startsWith('bridge-screenshot-')) continue;
      const filePath = path.join(SCREENSHOT_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > SCREENSHOT_TTL_MS) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {}
}

// =============================================================================
// Message Sender (Telegram primary, WhatsApp fallback)
// =============================================================================

function trySendOnChannel(channel, message, mediaPath) {
  const args = ['message', 'send',
    '--channel', channel.name,
    '--target', channel.target,
    '--message', message,
  ];
  if (mediaPath) args.push('--media', mediaPath);

  execFileSync('openclaw', args, { timeout: 15000, stdio: 'pipe' });
}

function sendNotification(message, withScreenshot = false) {
  if (!notifyAlways && !remoteModeEnabled) {
    log('Notification suppressed (remote mode off):', message.split('\n')[0]);
    return;
  }

  const mediaPath = null; // Screenshots now handled via IPC to main process (capturePage)
  const preview = message.split('\n')[0];
  const parts = splitMessage(message);

  // Use the selected channel only (single channel from dropdown)
  let channelsToUse = CHANNELS;
  if (notificationChannelsFilter) {
    const match = CHANNELS.find(ch => `${ch.name}:${ch.target}` === notificationChannelsFilter);
    if (match) {
      channelsToUse = [match];
    } else {
      log('Selected channel not found, falling back to first available');
      channelsToUse = CHANNELS.slice(0, 1);
    }
  } else {
    // No selection saved — use first channel
    channelsToUse = CHANNELS.slice(0, 1);
  }

  for (const channel of channelsToUse) {
    let allSent = true;

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      // Attach screenshot only to the last part
      const media = isLast ? mediaPath : null;

      try {
        trySendOnChannel(channel, parts[i], media);
      } catch (err) {
        const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
        log(`Send failed [${channel.name}] part ${i + 1}/${parts.length}:`, errMsg);

        // If message too long, re-split this part into smaller chunks and retry
        if (errMsg.includes('message is too long')) {
          log('Re-splitting oversized part...');
          const subParts = splitMessage(parts[i].substring(0, Math.floor(parts[i].length / 2)))
            .concat(splitMessage(parts[i].substring(Math.floor(parts[i].length / 2))));
          let subOk = true;
          for (let j = 0; j < subParts.length; j++) {
            const subMedia = (isLast && j === subParts.length - 1) ? media : null;
            try {
              trySendOnChannel(channel, subParts[j], subMedia);
            } catch (subErr) {
              log(`Re-split send failed [${channel.name}]:`, subErr.message);
              subOk = false;
              break;
            }
          }
          if (!subOk) { allSent = false; break; }
        } else if (media) {
          // Retry text-only if media failed on the last part
          try {
            trySendOnChannel(channel, parts[i], null);
          } catch (err2) {
            log(`Text fallback failed [${channel.name}] part ${i + 1}:`, err2.message);
            allSent = false;
            break;
          }
        } else {
          allSent = false;
          break;
        }
      }
    }

    if (allSent) {
      log(`Sent [${channel.name}] (${parts.length} part${parts.length > 1 ? 's' : ''}):`, preview);
      return;
    }

    // Fall through to next channel
  }

  log('All channels failed for:', preview);
}

/**
 * ISSUE-017: Send a pre-captured image via the notification channel.
 * Used for auto-screenshot after dispatch (image captured by main process via capturePage).
 * Respects remote mode gating and channel selection, same as sendNotification.
 */
function sendImageNotification(imagePath, caption) {
  if (!notifyAlways && !remoteModeEnabled) {
    log('Image notification suppressed (remote mode off):', caption);
    return;
  }

  let channelsToUse = CHANNELS;
  if (notificationChannelsFilter) {
    const match = CHANNELS.find(ch => `${ch.name}:${ch.target}` === notificationChannelsFilter);
    if (match) {
      channelsToUse = [match];
    } else {
      channelsToUse = CHANNELS.slice(0, 1);
    }
  } else {
    channelsToUse = CHANNELS.slice(0, 1);
  }

  for (const channel of channelsToUse) {
    try {
      trySendOnChannel(channel, caption, imagePath);
      log(`Sent image [${channel.name}]:`, caption);
      return;
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      log(`Image send failed [${channel.name}]:`, errMsg);
      // Try text-only fallback
      try {
        trySendOnChannel(channel, caption, null);
        log(`Text fallback sent [${channel.name}]:`, caption);
        return;
      } catch (err2) {
        log(`Text fallback also failed [${channel.name}]:`, err2.message);
      }
    }
  }

  log('All channels failed for image:', caption);
}

// =============================================================================
// File Rotation
// =============================================================================

function checkRotation() {
  try {
    const stats = fs.statSync(EVENTS_PATH);
    if (stats.size > MAX_FILE_SIZE) {
      log('Rotating events.jsonl (size:', stats.size, ')');
      fs.truncateSync(EVENTS_PATH, 0);
      lastReadPosition = 0;
    }
  } catch {}
}

// =============================================================================
// Main
// =============================================================================

function acquirePidLock() {
  // Check for existing pidfile
  try {
    const existingPid = parseInt(fs.readFileSync(PIDFILE_PATH, 'utf-8').trim(), 10);
    if (existingPid > 0) {
      // Check if the process is still alive
      try {
        process.kill(existingPid, 0); // signal 0 = existence check
        log(`Another bridge instance already running (PID ${existingPid}). Exiting.`);
        process.exit(0);
      } catch {
        // Process not running — stale pidfile, safe to overwrite
        log(`Stale pidfile found (PID ${existingPid}), taking over.`);
      }
    }
  } catch {
    // No pidfile or unreadable — proceed
  }

  // Write our PID
  fs.writeFileSync(PIDFILE_PATH, String(process.pid));
  log('Pidfile written:', PIDFILE_PATH, 'PID:', process.pid);

  // Clean up on exit
  const cleanup = () => {
    try {
      const content = fs.readFileSync(PIDFILE_PATH, 'utf-8').trim();
      if (content === String(process.pid)) {
        fs.unlinkSync(PIDFILE_PATH);
      }
    } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

function main() {
  // Init persistent log file first (so even pidlock messages are logged)
  initLogFile();

  // Acquire pidfile lock (exits if another instance running)
  acquirePidLock();

  // Load notification channels from OpenClaw config
  CHANNELS = loadChannels();
  if (CHANNELS.length === 0) {
    log('No OpenClaw notification channels configured. Bridge disabled.');
    log('Install OpenClaw and configure a messaging channel (Telegram/WhatsApp),');
    log('then relaunch Workstation to enable notifications.');
    process.exit(0);
  }

  log('OpenClaw-Workstation Bridge starting...');
  log('Events file:', EVENTS_PATH);
  log('Channels:', CHANNELS.map(c => `${c.name}(${c.target})`).join(' → '));

  // Ensure screenshot dir exists
  try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

  // Initial cleanup + periodic (rotation + screenshot TTL)
  checkRotation();
  cleanupOldScreenshots();
  setInterval(() => { checkRotation(); cleanupOldScreenshots(); cleanExpiredPrompts(); rotateLogIfNeeded(); pruneOldLogs(); }, ROTATION_CHECK_INTERVAL);

  // Wait for events file if it doesn't exist yet
  if (!fs.existsSync(EVENTS_PATH)) {
    log('Waiting for events file to appear...');
    const parentDir = path.dirname(EVENTS_PATH);
    const watcher = fs.watch(parentDir, (eventType, filename) => {
      if (filename === 'events.jsonl' && fs.existsSync(EVENTS_PATH)) {
        watcher.close();
        log('Events file appeared, starting watch');
        startWatching();
      }
    });
    // Also poll in case fs.watch misses it
    const checkInterval = setInterval(() => {
      if (fs.existsSync(EVENTS_PATH)) {
        clearInterval(checkInterval);
        watcher.close();
        log('Events file appeared, starting watch');
        startWatching();
      }
    }, 2000);
    return;
  }

  startWatching();
  log('Bridge running. Ctrl+C to stop.');
}

main();
