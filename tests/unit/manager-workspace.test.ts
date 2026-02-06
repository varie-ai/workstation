import { describe, it, expect, vi } from 'vitest';

// Mock logger
vi.mock('../../src/main/logger', () => ({
  log: vi.fn(),
}));

import {
  parseProjectsYaml,
  serializeProjectsYaml,
  ProjectsData,
} from '../../src/main/manager-workspace';

// ============================================================================
// parseProjectsYaml
// ============================================================================

describe('parseProjectsYaml', () => {
  it('parses empty template with projects: {}', () => {
    const content = `# Workstation - Project Index

projects: {}

repo_aliases: {}
`;
    const data = parseProjectsYaml(content);
    expect(Object.keys(data.projects)).toHaveLength(0);
    expect(Object.keys(data.repo_aliases)).toHaveLength(0);
  });

  it('parses projects: without {} (serializer output format)', () => {
    const content = `# Workstation - Project Index

projects:
  my_project:
    repos:
      - path: /Users/test/projects/my_project
    status: active

repo_aliases:
`;
    const data = parseProjectsYaml(content);
    expect(Object.keys(data.projects)).toHaveLength(1);
    expect(data.projects['my_project']).toBeDefined();
    expect(data.projects['my_project'].repos[0].path).toBe('/Users/test/projects/my_project');
    expect(data.projects['my_project'].status).toBe('active');
  });

  it('parses multiple projects', () => {
    const content = `projects:
  algo_trading:
    repos:
      - path: /Users/test/projects/algo_trading
    status: active
    last_updated: 2026-01-15T00:00:00Z
  varie:
    repos:
      - path: /Users/test/projects/varie
    status: active
  varie_character:
    repos:
      - path: /Users/test/projects/varie_character
    status: discovered

repo_aliases:
`;
    const data = parseProjectsYaml(content);
    expect(Object.keys(data.projects)).toHaveLength(3);
    expect(data.projects['algo_trading'].repos[0].path).toBe('/Users/test/projects/algo_trading');
    expect(data.projects['algo_trading'].last_updated).toBe('2026-01-15T00:00:00Z');
    expect(data.projects['varie'].status).toBe('active');
    expect(data.projects['varie_character'].status).toBe('discovered');
  });

  it('parses project with current_feature field', () => {
    const content = `projects:
  webapp:
    repos:
      - path: /Users/test/webapp
    status: active
    current_feature: user_auth
    last_updated: 2026-02-01T00:00:00Z

repo_aliases:
`;
    const data = parseProjectsYaml(content);
    expect(data.projects['webapp'].current_feature).toBe('user_auth');
  });

  it('parses repo with role field', () => {
    const content = `projects:
  platform:
    repos:
      - path: /Users/test/backend
        role: api
      - path: /Users/test/frontend
        role: web
    status: active

repo_aliases:
`;
    const data = parseProjectsYaml(content);
    expect(data.projects['platform'].repos).toHaveLength(2);
    expect(data.projects['platform'].repos[0].role).toBe('api');
    expect(data.projects['platform'].repos[1].role).toBe('web');
  });

  it('parses repo_aliases', () => {
    const content = `projects: {}

repo_aliases:
  api: backend
  web: frontend
`;
    const data = parseProjectsYaml(content);
    expect(data.repo_aliases['api']).toBe('backend');
    expect(data.repo_aliases['web']).toBe('frontend');
  });

  it('skips comment lines and empty lines', () => {
    const content = `# This is a comment
# Another comment

projects:
  # This project is commented out
  my_project:
    repos:
      - path: /Users/test/my_project
    status: active

repo_aliases:
`;
    const data = parseProjectsYaml(content);
    expect(Object.keys(data.projects)).toHaveLength(1);
  });

  it('parses project names with hyphens', () => {
    const content = `projects:
  my-project:
    repos:
      - path: /Users/test/my-project
    status: active

repo_aliases:
`;
    const data = parseProjectsYaml(content);
    expect(data.projects['my-project']).toBeDefined();
  });

  it('saves last project when file ends without repo_aliases', () => {
    const content = `projects:
  my_project:
    repos:
      - path: /Users/test/my_project
    status: active
`;
    const data = parseProjectsYaml(content);
    expect(data.projects['my_project']).toBeDefined();
    expect(data.projects['my_project'].status).toBe('active');
  });
});

// ============================================================================
// serializeProjectsYaml
// ============================================================================

describe('serializeProjectsYaml', () => {
  it('serializes empty projects', () => {
    const data: ProjectsData = { projects: {}, repo_aliases: {} };
    const yaml = serializeProjectsYaml(data);

    expect(yaml).toContain('projects:');
    expect(yaml).toContain('repo_aliases:');
    expect(yaml).toContain('# No projects yet');
  });

  it('serializes single project', () => {
    const data: ProjectsData = {
      projects: {
        my_project: {
          repos: [{ path: '/Users/test/my_project' }],
          status: 'active',
          last_updated: '2026-02-01T00:00:00Z',
        },
      },
      repo_aliases: {},
    };
    const yaml = serializeProjectsYaml(data);

    expect(yaml).toContain('  my_project:');
    expect(yaml).toContain('      - path: /Users/test/my_project');
    expect(yaml).toContain('    status: active');
    expect(yaml).toContain('    last_updated: 2026-02-01T00:00:00Z');
  });

  it('serializes repo roles', () => {
    const data: ProjectsData = {
      projects: {
        platform: {
          repos: [
            { path: '/Users/test/backend', role: 'api' },
            { path: '/Users/test/frontend', role: 'web' },
          ],
        },
      },
      repo_aliases: {},
    };
    const yaml = serializeProjectsYaml(data);

    expect(yaml).toContain('        role: api');
    expect(yaml).toContain('        role: web');
  });

  it('serializes aliases', () => {
    const data: ProjectsData = {
      projects: {},
      repo_aliases: { api: 'backend', web: 'frontend' },
    };
    const yaml = serializeProjectsYaml(data);

    expect(yaml).toContain('  api: backend');
    expect(yaml).toContain('  web: frontend');
  });

  it('sorts projects alphabetically', () => {
    const data: ProjectsData = {
      projects: {
        zebra: { repos: [{ path: '/z' }] },
        alpha: { repos: [{ path: '/a' }] },
        middle: { repos: [{ path: '/m' }] },
      },
      repo_aliases: {},
    };
    const yaml = serializeProjectsYaml(data);
    const alphaIdx = yaml.indexOf('alpha:');
    const middleIdx = yaml.indexOf('middle:');
    const zebraIdx = yaml.indexOf('zebra:');

    expect(alphaIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(zebraIdx);
  });
});

// ============================================================================
// Round-trip: parse → serialize → parse
// ============================================================================

describe('round-trip parse/serialize', () => {
  it('preserves data through serialize → parse cycle', () => {
    const original: ProjectsData = {
      projects: {
        algo_trading: {
          repos: [{ path: '/Users/test/algo_trading' }],
          status: 'active',
          last_updated: '2026-01-15T00:00:00Z',
        },
        varie_character: {
          repos: [{ path: '/Users/test/varie_character' }],
          status: 'discovered',
          current_feature: 'character_api',
        },
        platform: {
          repos: [
            { path: '/Users/test/backend', role: 'api' },
            { path: '/Users/test/frontend', role: 'web' },
          ],
          status: 'active',
        },
      },
      repo_aliases: {
        api: 'backend',
        web: 'frontend',
      },
    };

    const yaml = serializeProjectsYaml(original);
    const parsed = parseProjectsYaml(yaml);

    expect(Object.keys(parsed.projects).sort()).toEqual(
      Object.keys(original.projects).sort()
    );

    // Check each project's data
    for (const [name, project] of Object.entries(original.projects)) {
      expect(parsed.projects[name]).toBeDefined();
      expect(parsed.projects[name].repos.length).toBe(project.repos.length);
      for (let i = 0; i < project.repos.length; i++) {
        expect(parsed.projects[name].repos[i].path).toBe(project.repos[i].path);
        if (project.repos[i].role) {
          expect(parsed.projects[name].repos[i].role).toBe(project.repos[i].role);
        }
      }
      if (project.status) {
        expect(parsed.projects[name].status).toBe(project.status);
      }
      if (project.current_feature) {
        expect(parsed.projects[name].current_feature).toBe(project.current_feature);
      }
      if (project.last_updated) {
        expect(parsed.projects[name].last_updated).toBe(project.last_updated);
      }
    }

    expect(parsed.repo_aliases).toEqual(original.repo_aliases);
  });

  it('survives multiple serialize → parse cycles', () => {
    const original: ProjectsData = {
      projects: {
        project_a: {
          repos: [{ path: '/a' }],
          status: 'active',
        },
        project_b: {
          repos: [{ path: '/b' }],
          status: 'discovered',
        },
      },
      repo_aliases: {},
    };

    let data = original;
    for (let i = 0; i < 5; i++) {
      const yaml = serializeProjectsYaml(data);
      data = parseProjectsYaml(yaml);
    }

    expect(Object.keys(data.projects).sort()).toEqual(['project_a', 'project_b']);
    expect(data.projects['project_a'].repos[0].path).toBe('/a');
    expect(data.projects['project_b'].repos[0].path).toBe('/b');
  });

  it('regression: serialized output (no {}) can be re-parsed', () => {
    // This was the bug: serializeProjectsYaml writes "projects:" without {}
    // but parseProjectsYaml required {} due to regex \{\}? vs (\{\})?
    const data: ProjectsData = {
      projects: {
        my_project: {
          repos: [{ path: '/Users/test/my_project' }],
          status: 'active',
        },
      },
      repo_aliases: {},
    };

    const yaml = serializeProjectsYaml(data);

    // Verify serializer writes "projects:" without {}
    expect(yaml).toMatch(/^projects:\s*$/m);
    expect(yaml).not.toContain('projects: {}');

    // Verify parser can re-parse it
    const parsed = parseProjectsYaml(yaml);
    expect(Object.keys(parsed.projects)).toHaveLength(1);
    expect(parsed.projects['my_project'].repos[0].path).toBe('/Users/test/my_project');
  });
});
