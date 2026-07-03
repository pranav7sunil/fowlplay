/**
 * Model-facing toolset: schemas (`buildToolSpecs`) and dispatch
 * (`dispatchToolCall`). The actual environment (filesystem, staging overlay,
 * search) is abstracted behind `ToolHost`, implemented later by the extension.
 *
 * Tools accept batch inputs (open N files, apply N edits) to minimize round-trips.
 */

import type { SkillMeta, ToolResult, ToolSpec } from '../../shared/types';
import { applyFindReplace } from './edits';

// ---------------------------------------------------------------------------
// Host abstraction
// ---------------------------------------------------------------------------

export interface GrepOptions {
  path?: string;
  ignoreCase?: boolean;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface DirEntry {
  name: string;
  kind: 'file' | 'dir';
}

/** A staging operation applied to the in-memory overlay (never touches disk). */
export type StageOp =
  | { kind: 'modify'; path: string; content: string }
  | { kind: 'create'; path: string; content: string }
  | { kind: 'delete'; path: string };

/**
 * Environment the tools operate against. Reads go through the staging overlay so
 * edits stack coherently across turns.
 */
export interface ToolHost {
  /** Read a file's current (overlay-aware) content. Rejects if it does not exist. */
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<DirEntry[]>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, opts: GrepOptions): Promise<GrepMatch[]>;
  /** Apply staged edits to the overlay. */
  stageEdit(ops: StageOp[]): Promise<void>;
  /** Paths currently staged (for diagnostics / summaries). */
  listStaged(): Promise<string[]>;
  /**
   * Load a skill's full instruction body by name, or `null` if no such skill.
   * Optional: hosts without the skills capability simply omit it (the `load_skill`
   * tool is only ever offered when skills exist).
   */
  loadSkill?(name: string): Promise<string | null>;
  /** Skills available to load, used to list valid names in error messages. */
  skills?: SkillMeta[];
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

export interface BuildToolSpecsOptions {
  /**
   * When non-empty, a `load_skill` tool is appended (with the available skill names
   * listed in its description). With no skills the toolset is exactly today's — the
   * skills capability is strictly opt-in.
   */
  skills?: SkillMeta[];
}

export function buildToolSpecs(opts?: BuildToolSpecsOptions): ToolSpec[] {
  const specs: ToolSpec[] = [
    {
      name: 'open_files',
      description:
        'Read one or more files. Returns their contents with line numbers. Batch multiple paths in one call.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'File paths to open.',
          },
        },
        required: ['paths'],
      },
    },
    {
      name: 'list_dir',
      description: 'List the entries (files and subdirectories) of a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'glob',
      description: 'Find files matching a glob pattern (e.g. "src/**/*.ts").',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern.' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'grep',
      description:
        'Search file contents for a regular expression. Returns file:line matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for.' },
          path: {
            type: 'string',
            description: 'Optional directory or file to scope the search.',
          },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive search.' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'edit_files',
      description:
        'Apply a batch of edits to the staging layer. Each edit either replaces text ' +
        '(path, find, replace, optional all), creates a file (path, create), or deletes ' +
        'one (path, delete:true). Nothing is written to disk.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                find: { type: 'string' },
                replace: { type: 'string' },
                all: { type: 'boolean' },
                create: { type: 'string' },
                delete: { type: 'boolean' },
              },
              required: ['path'],
            },
            description: 'The edits to apply.',
          },
        },
        required: ['edits'],
      },
    },
  ];

  const skills = opts?.skills;
  if (skills && skills.length > 0) {
    specs.push({
      name: 'load_skill',
      description:
        'Load the full instructions for a reusable skill before you rely on it. ' +
        `Available skills: ${skills.map((s) => s.name).join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The exact name of the skill to load.' },
        },
        required: ['name'],
      },
    });
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatchToolCall(
  host: ToolHost,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'open_files':
        return await openFiles(host, args);
      case 'list_dir':
        return await listDir(host, args);
      case 'glob':
        return await globTool(host, args);
      case 'grep':
        return await grepTool(host, args);
      case 'edit_files':
        return await editFiles(host, args);
      case 'load_skill':
        return await loadSkillTool(host, args);
      default:
        return { ok: false, content: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, content: `Tool "${name}" failed: ${errMessage(err)}` };
  }
}

// --- open_files -------------------------------------------------------------

async function openFiles(host: ToolHost, args: unknown): Promise<ToolResult> {
  const paths = asStringArray((args as { paths?: unknown })?.paths);
  if (paths.length === 0) {
    return { ok: false, content: 'open_files requires a non-empty "paths" array' };
  }

  const sections: string[] = [];
  let anyOk = false;
  for (const path of paths) {
    try {
      const content = await host.readFile(path);
      sections.push(`===== ${path} =====\n${numberLines(content)}`);
      anyOk = true;
    } catch (err) {
      sections.push(`===== ${path} =====\n[error: ${errMessage(err)}]`);
    }
  }
  return {
    ok: anyOk,
    content: sections.join('\n\n'),
    gcClass: 'file-content',
  };
}

// --- list_dir ---------------------------------------------------------------

async function listDir(host: ToolHost, args: unknown): Promise<ToolResult> {
  const path = asString((args as { path?: unknown })?.path);
  if (path === undefined) {
    return { ok: false, content: 'list_dir requires a "path" string' };
  }
  const entries = await host.listDir(path);
  const lines = entries.map((e) => (e.kind === 'dir' ? `${e.name}/` : e.name));
  return {
    ok: true,
    content: lines.length > 0 ? lines.join('\n') : '(empty directory)',
    gcClass: 'other',
  };
}

// --- glob -------------------------------------------------------------------

async function globTool(host: ToolHost, args: unknown): Promise<ToolResult> {
  const pattern = asString((args as { pattern?: unknown })?.pattern);
  if (pattern === undefined) {
    return { ok: false, content: 'glob requires a "pattern" string' };
  }
  const matches = await host.glob(pattern);
  return {
    ok: true,
    content: matches.length > 0 ? matches.join('\n') : '(no matches)',
    gcClass: 'search-result',
  };
}

// --- grep -------------------------------------------------------------------

async function grepTool(host: ToolHost, args: unknown): Promise<ToolResult> {
  const a = (args ?? {}) as { pattern?: unknown; path?: unknown; ignoreCase?: unknown };
  const pattern = asString(a.pattern);
  if (pattern === undefined) {
    return { ok: false, content: 'grep requires a "pattern" string' };
  }
  const opts: GrepOptions = {};
  const path = asString(a.path);
  if (path !== undefined) opts.path = path;
  if (typeof a.ignoreCase === 'boolean') opts.ignoreCase = a.ignoreCase;

  const matches = await host.grep(pattern, opts);
  const lines = matches.map((m) => `${m.path}:${m.line}:${m.text}`);
  return {
    ok: true,
    content: lines.length > 0 ? lines.join('\n') : '(no matches)',
    gcClass: 'search-result',
  };
}

// --- edit_files -------------------------------------------------------------

interface EditSpec {
  path: string;
  find?: string;
  replace?: string;
  all?: boolean;
  create?: string;
  delete?: boolean;
}

async function editFiles(host: ToolHost, args: unknown): Promise<ToolResult> {
  const rawEdits = (args as { edits?: unknown })?.edits;
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return { ok: false, content: 'edit_files requires a non-empty "edits" array' };
  }

  const results: string[] = [];
  const stageOps: StageOp[] = [];
  let allOk = true;

  for (let i = 0; i < rawEdits.length; i += 1) {
    const edit = normalizeEdit(rawEdits[i]);
    const label = `#${i + 1} ${edit?.path ?? '(no path)'}`;
    if (!edit || !edit.path) {
      results.push(`${label}: FAIL — each edit needs a "path"`);
      allOk = false;
      continue;
    }

    if (edit.delete === true) {
      stageOps.push({ kind: 'delete', path: edit.path });
      results.push(`${label}: ok — deleted`);
      continue;
    }

    if (typeof edit.create === 'string') {
      stageOps.push({ kind: 'create', path: edit.path, content: edit.create });
      results.push(`${label}: ok — created`);
      continue;
    }

    if (typeof edit.find === 'string') {
      let current: string;
      try {
        current = await host.readFile(edit.path);
      } catch (err) {
        results.push(`${label}: FAIL — cannot read file: ${errMessage(err)}`);
        allOk = false;
        continue;
      }
      const outcome = applyFindReplace(current, edit.find, edit.replace ?? '', edit.all === true);
      if (outcome.ok) {
        stageOps.push({ kind: 'modify', path: edit.path, content: outcome.content });
        results.push(`${label}: ok — replaced`);
      } else {
        allOk = false;
        const miss = outcome.nearestMiss ? `\n   nearest miss:\n${indent(outcome.nearestMiss)}` : '';
        results.push(`${label}: FAIL — ${outcome.reason}${miss}`);
      }
      continue;
    }

    results.push(`${label}: FAIL — edit must specify find/replace, create, or delete:true`);
    allOk = false;
  }

  // Only commit staged ops if at least one succeeded; a batch with some failures
  // still stages the ones that worked so progress accumulates.
  if (stageOps.length > 0) {
    try {
      await host.stageEdit(stageOps);
    } catch (err) {
      return { ok: false, content: `staging failed: ${errMessage(err)}` };
    }
  }

  return { ok: allOk, content: results.join('\n'), gcClass: 'other' };
}

// --- load_skill -------------------------------------------------------------

async function loadSkillTool(host: ToolHost, args: unknown): Promise<ToolResult> {
  const name = asString((args as { name?: unknown })?.name)?.trim();
  if (!name) {
    return { ok: false, content: 'load_skill requires a "name" string' };
  }
  if (!host.loadSkill) {
    return { ok: false, content: 'skills are not available in this session' };
  }
  const body = await host.loadSkill(name);
  if (body === null) {
    const available = host.skills?.map((s) => s.name).join(', ');
    return {
      ok: false,
      content: available
        ? `unknown skill: ${name}. Available skills: ${available}`
        : `unknown skill: ${name}`,
    };
  }
  return { ok: true, content: body, gcClass: 'other' };
}

function normalizeEdit(raw: unknown): EditSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const path = asString(o.path);
  if (path === undefined) return null;
  const spec: EditSpec = { path };
  if (typeof o.find === 'string') spec.find = o.find;
  if (typeof o.replace === 'string') spec.replace = o.replace;
  if (typeof o.all === 'boolean') spec.all = o.all;
  if (typeof o.create === 'string') spec.create = o.create;
  if (typeof o.delete === 'boolean') spec.delete = o.delete;
  return spec;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numberLines(content: string): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width, ' ')}\t${line}`)
    .join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `     ${l}`)
    .join('\n');
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
