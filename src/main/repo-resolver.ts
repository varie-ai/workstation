/**
 * RepoResolver - Smart repo discovery for Varie Workstation
 *
 * Priority:
 * 1. Exact name match
 * 2. CLAUDE.md repos (parsed + scanned)
 * 3. Learned repos
 * 4. Directory scan (including nested)
 * 5. Return suggestions if ambiguous
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';
import { getReposFromProjectsYaml } from './manager-workspace';

export interface RepoInfo {
  name: string;
  path: string;
  source: 'claude_md' | 'learned' | 'scanned' | 'projects_yaml';
  hasClaudeMd: boolean;
}

export interface ResolveResult {
  found: boolean;
  repo?: RepoInfo;
  suggestions?: string[];
  message?: string;
  ambiguous?: boolean;
}

const LEARNED_REPOS_FILE = path.join(
  os.homedir(),
  '.varie-workstation',
  'learned-repos.json'
);

export class RepoResolver {
  private allRepos: Map<string, RepoInfo> = new Map();
  private learnedRepos: Map<string, RepoInfo> = new Map();
  private scanPaths: string[] = [];
  private lastRefreshTime = 0;
  private static REFRESH_COOLDOWN_MS = 5000; // 5 seconds

  constructor(scanPaths: string[] = []) {
    this.scanPaths = scanPaths.length > 0
      ? scanPaths
      : [path.join(os.homedir(), 'workplace', 'projects')];

    this.loadLearnedRepos();
    this.scanAllRepos();
    this.loadProjectsYaml();
  }

  /**
   * Resolve a repo name/query to a path.
   * On cache miss, refreshes all sources once (with cooldown) and retries.
   */
  resolve(query: string): ResolveResult {
    const result = this._resolve(query);
    if (result.found) return result;

    // On miss, refresh and retry (respecting cooldown)
    if (this.shouldRefresh()) {
      log('INFO', `Resolve miss for "${query}", refreshing repo sources...`);
      this.refresh();
      return this._resolve(query);
    }

    return result;
  }

  /**
   * Internal resolve logic — searches allRepos + learnedRepos
   */
  private _resolve(query: string): ResolveResult {
    const queryLower = query.toLowerCase().trim().replace(/[_-]/g, '');

    // Normalize function for comparison
    const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, '');

    // 1. Exact name match (case-insensitive, ignore - and _)
    for (const [name, info] of this.allRepos) {
      if (normalize(name) === queryLower) {
        log('INFO', `Resolved "${query}" exactly: ${info.path}`);
        return { found: true, repo: info };
      }
    }

    // 2. Check learned repos (exact match)
    for (const [name, info] of this.learnedRepos) {
      if (normalize(name) === queryLower) {
        log('INFO', `Resolved "${query}" via learned: ${info.path}`);
        return { found: true, repo: info };
      }
    }

    // 3. Find candidates that contain the query or vice versa
    const candidates: RepoInfo[] = [];
    for (const [name, info] of this.allRepos) {
      const nameLower = normalize(name);
      if (nameLower.includes(queryLower) || queryLower.includes(nameLower)) {
        candidates.push(info);
      }
    }

    // 4. If exactly one strong candidate, use it
    if (candidates.length === 1) {
      log('INFO', `Resolved "${query}" to single candidate: ${candidates[0].path}`);
      return { found: true, repo: candidates[0] };
    }

    // 5. If multiple candidates, check for best match
    if (candidates.length > 1) {
      // Prefer exact substring match at word boundary
      const exactSubstring = candidates.find(c =>
        normalize(c.name) === queryLower ||
        normalize(c.name).endsWith(queryLower) ||
        c.name.toLowerCase().split(/[-_]/).includes(query.toLowerCase())
      );

      if (exactSubstring) {
        log('INFO', `Resolved "${query}" to best candidate: ${exactSubstring.path}`);
        return { found: true, repo: exactSubstring };
      }

      // Ambiguous - return suggestions
      log('WARN', `Ambiguous query "${query}" - ${candidates.length} candidates`);
      return {
        found: false,
        ambiguous: true,
        suggestions: candidates.map(c => c.name),
        message: `Multiple repos match "${query}": ${candidates.map(c => c.name).join(', ')}. Please be more specific.`,
      };
    }

    // 6. No match - return suggestions
    const suggestions = this.getSuggestions(queryLower);
    log('WARN', `Could not resolve "${query}". Suggestions: ${suggestions.join(', ')}`);

    return {
      found: false,
      suggestions,
      message: `Could not find repo matching "${query}". ${
        suggestions.length > 0
          ? `Did you mean: ${suggestions.join(', ')}?`
          : 'Please provide the full path.'
      }`,
    };
  }

  /**
   * Learn a repo from user interaction
   */
  learnRepo(name: string, repoPath: string): void {
    const hasClaudeMd = fs.existsSync(path.join(repoPath, 'CLAUDE.md'));

    this.learnedRepos.set(name, {
      name,
      path: repoPath,
      source: 'learned',
      hasClaudeMd,
    });

    this.saveLearnedRepos();
    log('INFO', `Learned repo: ${name} -> ${repoPath}`);
  }

  /**
   * Refresh all repo sources: re-scan filesystem, reload learned repos,
   * and reload projects.yaml. Call after discovery or on resolve miss.
   */
  refresh(): void {
    log('INFO', 'Refreshing repo sources...');
    this.allRepos.clear();
    this.learnedRepos.clear();

    this.loadLearnedRepos();
    this.scanAllRepos();
    this.loadProjectsYaml();

    this.lastRefreshTime = Date.now();
    log('INFO', `Refresh complete: ${this.allRepos.size} scanned, ${this.learnedRepos.size} learned`);
  }

  /**
   * Check if enough time has passed since last refresh
   */
  private shouldRefresh(): boolean {
    return Date.now() - this.lastRefreshTime > RepoResolver.REFRESH_COOLDOWN_MS;
  }

  /**
   * Load repos from projects.yaml as an additional source.
   * Only adds repos not already known from scan or learned-repos.json.
   */
  private loadProjectsYaml(): void {
    try {
      const entries = getReposFromProjectsYaml();
      let added = 0;

      for (const entry of entries) {
        // Skip if already known
        if (this.allRepos.has(entry.name) || this.learnedRepos.has(entry.name)) {
          continue;
        }

        // Validate path exists on disk
        if (!fs.existsSync(entry.path)) {
          log('DEBUG', `Skipping projects.yaml entry "${entry.name}" - path not found: ${entry.path}`);
          continue;
        }

        const hasClaudeMd = fs.existsSync(path.join(entry.path, 'CLAUDE.md'));
        this.allRepos.set(entry.name, {
          name: entry.name,
          path: entry.path,
          source: 'projects_yaml',
          hasClaudeMd,
        });
        added++;
      }

      if (added > 0) {
        log('INFO', `Loaded ${added} repos from projects.yaml`);
      }
    } catch (err) {
      log('DEBUG', 'Failed to load projects.yaml repos', err);
    }
  }

  /**
   * Scan a custom path and learn any repos found.
   * Smart detection:
   * - If path itself is a repo (has .git or CLAUDE.md), learn just that repo
   * - If path is a directory, scan it for repos and learn all found
   *
   * @returns Array of newly learned repos
   */
  scanAndLearnPath(customPath: string): RepoInfo[] {
    const resolvedPath = customPath.replace(/^~/, os.homedir());
    const learned: RepoInfo[] = [];

    if (!fs.existsSync(resolvedPath)) {
      log('WARN', `Path does not exist: ${resolvedPath}`);
      return learned;
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      log('WARN', `Path is not a directory: ${resolvedPath}`);
      return learned;
    }

    // Check if the path itself is a repo
    const hasGit = fs.existsSync(path.join(resolvedPath, '.git'));
    const hasClaudeMd = fs.existsSync(path.join(resolvedPath, 'CLAUDE.md'));

    if (hasGit || hasClaudeMd) {
      // It's a single repo - learn it directly
      const name = path.basename(resolvedPath);
      if (!this.learnedRepos.has(name) && !this.allRepos.has(name)) {
        const info: RepoInfo = {
          name,
          path: resolvedPath,
          source: 'learned',
          hasClaudeMd,
        };
        this.learnedRepos.set(name, info);
        learned.push(info);
        log('INFO', `Learned single repo: ${name} -> ${resolvedPath}`);
      } else {
        log('INFO', `Repo already known: ${name}`);
      }
    } else {
      // It's a directory - scan for repos inside
      log('INFO', `Scanning directory for repos: ${resolvedPath}`);
      this.scanDirectoryAndLearn(resolvedPath, learned, 0, 3);
    }

    // Save if we learned anything
    if (learned.length > 0) {
      this.saveLearnedRepos();
    }

    return learned;
  }

  /**
   * Scan directory and learn repos (helper for scanAndLearnPath)
   */
  private scanDirectoryAndLearn(
    dirPath: string,
    learned: RepoInfo[],
    depth: number,
    maxDepth: number
  ): void {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'archive') continue;

        const subPath = path.join(dirPath, entry.name);
        const hasGit = fs.existsSync(path.join(subPath, '.git'));
        const hasClaudeMd = fs.existsSync(path.join(subPath, 'CLAUDE.md'));

        if (hasGit || hasClaudeMd) {
          // Found a repo - learn it if not already known
          if (!this.learnedRepos.has(entry.name) && !this.allRepos.has(entry.name)) {
            const info: RepoInfo = {
              name: entry.name,
              path: subPath,
              source: 'learned',
              hasClaudeMd,
            };
            this.learnedRepos.set(entry.name, info);
            learned.push(info);
            log('INFO', `Learned repo: ${entry.name} -> ${subPath}`);
          }
        }

        // Continue scanning subdirectories
        this.scanDirectoryAndLearn(subPath, learned, depth + 1, maxDepth);
      }
    } catch (err) {
      log('DEBUG', `Failed to scan: ${dirPath}`, err);
    }
  }

  /**
   * Get all known repos
   */
  getAllRepos(): RepoInfo[] {
    const all = new Map<string, RepoInfo>();

    for (const [name, info] of this.learnedRepos) {
      all.set(name, info);
    }
    for (const [name, info] of this.allRepos) {
      all.set(name, info);
    }

    return Array.from(all.values());
  }

  /**
   * Scan all repos from scan paths (including nested)
   */
  private scanAllRepos(): void {
    for (const scanPath of this.scanPaths) {
      const resolvedPath = scanPath.replace(/^~/, os.homedir());
      this.scanDirectory(resolvedPath, 0, 3); // Max 3 levels deep
    }

    log('INFO', `Found ${this.allRepos.size} repos`);
  }

  /**
   * Recursively scan directory for repos
   */
  private scanDirectory(dirPath: string, depth: number, maxDepth: number): void {
    if (depth > maxDepth) return;

    try {
      if (!fs.existsSync(dirPath)) return;

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'archive') continue;

        const subPath = path.join(dirPath, entry.name);
        const hasGit = fs.existsSync(path.join(subPath, '.git'));
        const hasClaudeMd = fs.existsSync(path.join(subPath, 'CLAUDE.md'));

        // Add if it's a repo (has .git or CLAUDE.md)
        if (hasGit || hasClaudeMd) {
          if (!this.allRepos.has(entry.name)) {
            this.allRepos.set(entry.name, {
              name: entry.name,
              path: subPath,
              source: hasClaudeMd ? 'claude_md' : 'scanned',
              hasClaudeMd,
            });
          }
        }

        // Continue scanning subdirectories
        this.scanDirectory(subPath, depth + 1, maxDepth);
      }
    } catch (err) {
      log('DEBUG', `Failed to scan: ${dirPath}`, err);
    }
  }

  /**
   * Get suggestions for failed resolution
   */
  private getSuggestions(query: string): string[] {
    const all = this.getAllRepos();
    const suggestions: { name: string; score: number }[] = [];

    for (const repo of all) {
      const nameLower = repo.name.toLowerCase().replace(/[_-]/g, '');
      let score = 0;

      // Partial match
      if (nameLower.includes(query.substring(0, 3))) score += 20;
      if (query.includes(nameLower.substring(0, 3))) score += 15;

      // First letter match
      if (nameLower[0] === query[0]) score += 10;

      // Has CLAUDE.md (preferred)
      if (repo.hasClaudeMd) score += 5;

      if (score > 0) {
        suggestions.push({ name: repo.name, score });
      }
    }

    return suggestions
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((s) => s.name);
  }

  /**
   * Load learned repos from disk
   */
  private loadLearnedRepos(): void {
    try {
      if (fs.existsSync(LEARNED_REPOS_FILE)) {
        const data = JSON.parse(fs.readFileSync(LEARNED_REPOS_FILE, 'utf-8'));
        for (const [name, info] of Object.entries(data)) {
          this.learnedRepos.set(name, info as RepoInfo);
        }
        log('INFO', `Loaded ${this.learnedRepos.size} learned repos`);
      }
    } catch (err) {
      log('WARN', 'Failed to load learned repos', err);
    }
  }

  /**
   * Save learned repos to disk
   */
  private saveLearnedRepos(): void {
    try {
      const dir = path.dirname(LEARNED_REPOS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: Record<string, RepoInfo> = {};
      for (const [name, info] of this.learnedRepos) {
        data[name] = info;
      }

      fs.writeFileSync(LEARNED_REPOS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log('WARN', 'Failed to save learned repos', err);
    }
  }
}
