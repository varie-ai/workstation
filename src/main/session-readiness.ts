/**
 * Session Readiness Tracker (ISSUE-016)
 *
 * Tracks Claude startup readiness for newly created sessions.
 * When a session is created, a readyPromise (from waitForClaudeReady) is registered.
 * Subsequent dispatches to that session await readiness before writing to PTY.
 *
 * Bounded map: evicts least-recently-used entries when capacity is reached.
 */

import { log } from './logger';

interface ReadinessEntry {
  createdAt: number;
  lastUsed: number;
  ready: boolean;
  readyPromise: Promise<boolean>;
}

export class SessionReadinessTracker {
  private map = new Map<string, ReadinessEntry>();
  private readonly maxEntries: number;
  private readonly keepEntries: number;

  constructor(maxEntries = 100, keepEntries = 10) {
    this.maxEntries = maxEntries;
    this.keepEntries = keepEntries;
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Register a session with a readiness promise.
   * Called after session creation — the promise resolves when Claude is ready.
   */
  register(sessionId: string, readyPromise: Promise<boolean>): void {
    this.cleanup();

    const now = Date.now();
    const entry: ReadinessEntry = {
      createdAt: now,
      lastUsed: now,
      ready: false,
      readyPromise,
    };

    // Mark ready when promise resolves (fire-and-forget)
    readyPromise.then((result) => {
      const e = this.map.get(sessionId);
      if (e === entry) e.ready = result;
    }).catch(() => {
      const e = this.map.get(sessionId);
      if (e === entry) e.ready = true; // On error, unblock dispatches
    });

    this.map.set(sessionId, entry);
  }

  /**
   * Await readiness for a session. Returns immediately for untracked or already-ready sessions.
   * Races the readyPromise against a timeout.
   */
  async awaitReady(sessionId: string, timeoutMs = 30000): Promise<boolean> {
    const entry = this.map.get(sessionId);
    if (!entry) return true; // Untracked = assume ready (existing session)

    entry.lastUsed = Date.now();

    if (entry.ready) return true;

    // Race against timeout
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs)
    );

    const result = await Promise.race([entry.readyPromise, timeout]);
    return result;
  }

  /**
   * Synchronous check — true if session is untracked or already ready.
   */
  isReady(sessionId: string): boolean {
    const entry = this.map.get(sessionId);
    return !entry || entry.ready;
  }

  /**
   * Remove a session from tracking (e.g., on session close).
   */
  remove(sessionId: string): void {
    this.map.delete(sessionId);
  }

  /**
   * Evict oldest entries by lastUsed when map reaches capacity.
   * Keeps the most recently used entries.
   */
  private cleanup(): void {
    if (this.map.size < this.maxEntries) return;

    const entries = [...this.map.entries()]
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    const removeCount = entries.length - this.keepEntries;
    for (let i = 0; i < removeCount; i++) {
      this.map.delete(entries[i][0]);
    }

    log('INFO', `Readiness map cleanup: evicted ${removeCount}, kept ${this.map.size}`);
  }
}
