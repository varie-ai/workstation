/**
 * Varie Workstation - Shared Types
 *
 * Type definitions for sessions, checkpoints, and workspace state.
 */

// =============================================================================
// Step Types
// =============================================================================

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface Step {
  id: string;
  name: string;
  status: StepStatus;

  // Timing
  started_at?: string;
  completed_at?: string;

  // State
  outcome?: string; // For completed steps
  notes?: string; // For in_progress steps
  blocked_reason?: string; // For blocked steps
  blocked_since?: string;
  unblock_action?: string;

  // Files
  files_changed?: string[]; // Completed: what was modified
  files_touched?: string[]; // In progress: what's being worked on

  // Verification
  verification?: string; // How completion was verified

  // Dependencies
  depends_on?: string[]; // Step IDs this depends on

  // Optional finer granularity
  subtasks?: string[];
}

// =============================================================================
// Task Types
// =============================================================================

export interface Task {
  id: string; // e.g., "33_character_api"
  name: string; // e.g., "Character API Migration"
  description?: string;
  archive_path: string; // e.g., "archive/33_character_api/"

  // Timing
  started_at: string;
  estimated_completion?: string;

  // Scope
  repos_involved?: string[];

  // Context
  context_files?: string[];

  // For fuzzy matching
  tags?: string[];
}

// =============================================================================
// Git State Types
// =============================================================================

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed';

export interface DirtyFile {
  path: string;
  status: FileStatus;
}

export interface GitState {
  branch: string;
  last_commit: string;
  last_commit_message?: string;
  dirty_files: DirtyFile[];
  staged_files: string[];
}

// =============================================================================
// Session Types
// =============================================================================

export type SessionType = 'orchestrator' | 'worker';

export interface Session {
  session_id: string;
  created_at: string;
  last_active: string;

  // Location
  repo: string;
  repo_path: string;
  working_dir: string;

  // Task
  task: Task;
  steps: Step[];

  // Position
  current_step: string;
  next_step?: string;

  // Recovery
  git_state?: GitState;

  // Terminal (non-essential)
  terminal?: {
    scroll_position?: number;
    last_command?: string;
  };
}

// =============================================================================
// Workspace Types
// =============================================================================

export interface RepoConfig {
  path: string;
  claude_md: string;
  active_session?: string;
}

export interface SessionSummary {
  session_id: string;
  repo: string;
  task: string;
  current_step: string;
  status: StepStatus;
  last_active: string;
}

export interface Workspace {
  root: string;
  last_active_session?: string;
  repos: Record<string, RepoConfig>;
  active_sessions: SessionSummary[];
}

// =============================================================================
// IPC Message Types
// =============================================================================

export type IPCChannel =
  | 'session:create'
  | 'session:close'
  | 'session:focus'
  | 'session:send-input'
  | 'checkpoint:save'
  | 'checkpoint:load'
  | 'workspace:get-status'
  | 'orchestrator:dispatch';

export interface IPCMessage<T = unknown> {
  channel: IPCChannel;
  payload: T;
}

// Session IPC
export interface CreateSessionPayload {
  repo: string;
  working_dir: string;
  task_id?: string;
}

export interface SendInputPayload {
  session_id: string;
  input: string;
}

// Orchestrator IPC
export interface DispatchPayload {
  description: string; // Natural language
}

export interface DispatchResult {
  matched_session?: string;
  suggested_command?: string;
  confidence: number;
  alternatives?: Array<{
    session_id: string;
    task: string;
    relevance: number;
  }>;
}
