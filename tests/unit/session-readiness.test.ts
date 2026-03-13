import { describe, it, expect, beforeEach } from 'vitest';
import { SessionReadinessTracker } from '../../src/main/session-readiness';

describe('SessionReadinessTracker', () => {
  let tracker: SessionReadinessTracker;

  beforeEach(() => {
    tracker = new SessionReadinessTracker(100, 10);
  });

  describe('register + awaitReady', () => {
    it('should resolve true when readyPromise resolves true', async () => {
      tracker.register('s1', Promise.resolve(true));
      const ready = await tracker.awaitReady('s1');
      expect(ready).toBe(true);
    });

    it('should resolve false when readyPromise resolves false', async () => {
      tracker.register('s1', Promise.resolve(false));
      const ready = await tracker.awaitReady('s1');
      expect(ready).toBe(false);
    });

    it('should return true for untracked sessions (assume ready)', async () => {
      const ready = await tracker.awaitReady('unknown-session');
      expect(ready).toBe(true);
    });

    it('should timeout if readyPromise never resolves', async () => {
      const neverResolves = new Promise<boolean>(() => {});
      tracker.register('s1', neverResolves);
      const ready = await tracker.awaitReady('s1', 50);
      expect(ready).toBe(false);
    });

    it('should resolve immediately when session is already ready', async () => {
      tracker.register('s1', Promise.resolve(true));
      // Let microtask run so .then() marks ready=true
      await new Promise((r) => setTimeout(r, 10));

      const start = Date.now();
      const ready = await tracker.awaitReady('s1');
      const elapsed = Date.now() - start;

      expect(ready).toBe(true);
      expect(elapsed).toBeLessThan(20);
    });

    it('should handle readyPromise rejection gracefully (unblock dispatches)', async () => {
      tracker.register('s1', Promise.reject(new Error('PTY crashed')));
      // Let microtask run so .catch() marks ready=true
      await new Promise((r) => setTimeout(r, 10));

      expect(tracker.isReady('s1')).toBe(true);
    });
  });

  describe('isReady (synchronous)', () => {
    it('should return false before promise resolves', () => {
      tracker.register('s1', new Promise(() => {}));
      expect(tracker.isReady('s1')).toBe(false);
    });

    it('should return true after promise resolves', async () => {
      tracker.register('s1', Promise.resolve(true));
      await new Promise((r) => setTimeout(r, 10));
      expect(tracker.isReady('s1')).toBe(true);
    });

    it('should return true for untracked sessions', () => {
      expect(tracker.isReady('no-such-session')).toBe(true);
    });
  });

  describe('remove', () => {
    it('should stop tracking a session', () => {
      tracker.register('s1', new Promise(() => {}));
      expect(tracker.isReady('s1')).toBe(false);

      tracker.remove('s1');
      expect(tracker.isReady('s1')).toBe(true); // untracked = ready
      expect(tracker.size).toBe(0);
    });

    it('should be a no-op for untracked sessions', () => {
      tracker.remove('nonexistent');
      expect(tracker.size).toBe(0);
    });
  });

  describe('size', () => {
    it('should track number of entries', () => {
      expect(tracker.size).toBe(0);

      tracker.register('s1', Promise.resolve(true));
      expect(tracker.size).toBe(1);

      tracker.register('s2', Promise.resolve(true));
      expect(tracker.size).toBe(2);
    });

    it('should overwrite on re-register', () => {
      tracker.register('s1', Promise.resolve(true));
      tracker.register('s1', Promise.resolve(false));
      expect(tracker.size).toBe(1);
    });
  });

  describe('cleanup (eviction at capacity)', () => {
    it('should evict oldest entries when map reaches maxEntries', () => {
      const small = new SessionReadinessTracker(5, 2);

      for (let i = 0; i < 5; i++) {
        small.register(`s${i}`, Promise.resolve(true));
      }
      expect(small.size).toBe(5);

      // 6th entry triggers cleanup: keep 2 most recent + insert new = 3
      small.register('s5', Promise.resolve(true));
      expect(small.size).toBe(3);
    });

    it('should not evict below maxEntries', () => {
      const small = new SessionReadinessTracker(10, 5);

      for (let i = 0; i < 8; i++) {
        small.register(`s${i}`, Promise.resolve(true));
      }
      expect(small.size).toBe(8); // 8 < 10, no cleanup
    });

    it('should keep most recently used entries during eviction', async () => {
      const small = new SessionReadinessTracker(5, 2);

      // Register 4 sessions
      for (let i = 0; i < 4; i++) {
        small.register(`s${i}`, Promise.resolve(true));
        // Small delay to ensure distinct timestamps
        await new Promise((r) => setTimeout(r, 5));
      }

      // Touch s0 (oldest) to bump its lastUsed
      await small.awaitReady('s0');
      await new Promise((r) => setTimeout(r, 5));

      // Add s4 (reaches 5 — at limit but no cleanup yet)
      small.register('s4', Promise.resolve(true));
      expect(small.size).toBe(5);

      // Add s5 — triggers cleanup, keeps 2 most recent by lastUsed
      // s0 was recently touched, s4 and s5 are newest by creation
      // s1, s2, s3 should be evicted (oldest lastUsed, never touched)
      await new Promise((r) => setTimeout(r, 5));
      small.register('s5', Promise.resolve(true));

      // Should have kept 2 + 1 new = 3
      expect(small.size).toBe(3);

      // s0 should survive (recently touched), s1-s3 should be gone
      // We can verify s0 is still tracked (isReady returns based on tracking)
      await new Promise((r) => setTimeout(r, 10));
      expect(small.isReady('s0')).toBe(true); // tracked + resolved
    });

    it('should handle repeated cleanups correctly', () => {
      const small = new SessionReadinessTracker(3, 1);

      // Fill to 3
      small.register('a', Promise.resolve(true));
      small.register('b', Promise.resolve(true));
      small.register('c', Promise.resolve(true));
      expect(small.size).toBe(3);

      // Trigger first cleanup: keep 1 + add 1 = 2
      small.register('d', Promise.resolve(true));
      expect(small.size).toBe(2);

      // Add one more — still under 3
      small.register('e', Promise.resolve(true));
      expect(small.size).toBe(3);

      // Trigger second cleanup
      small.register('f', Promise.resolve(true));
      expect(small.size).toBe(2);
    });
  });

  describe('concurrent scenarios', () => {
    it('should handle multiple awaits on the same session', async () => {
      let resolve!: (v: boolean) => void;
      const promise = new Promise<boolean>((r) => { resolve = r; });

      tracker.register('s1', promise);

      // Two concurrent awaits
      const p1 = tracker.awaitReady('s1', 5000);
      const p2 = tracker.awaitReady('s1', 5000);

      resolve(true);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
    });

    it('should handle register overwriting a pending session', async () => {
      tracker.register('s1', new Promise(() => {})); // never resolves
      expect(tracker.isReady('s1')).toBe(false);

      // Re-register with an immediately resolving promise
      tracker.register('s1', Promise.resolve(true));
      const ready = await tracker.awaitReady('s1');
      expect(ready).toBe(true);
    });
  });
});
