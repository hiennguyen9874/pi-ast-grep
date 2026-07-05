import crypto from "node:crypto";
import { Type } from "typebox";
import { astEdit, type AstReplaceChange, type AstReplaceFileChange } from "../../native/index.js";
import {
  absoluteMatchPath,
  formatPathRelativeToCwd,
  resolveSearchTargets,
  type ResolvedSearchTarget,
} from "../path-utils";
import { envPositiveInt, textResult, withFileMutationQueues, type TextToolResultDetails } from "./common";

const PARSE_ERROR_LIMIT = 20;

export const astEditParameters = Type.Object({
  ops: Type.Array(
    Type.Object({
      pat: Type.String({ description: "ast-grep pattern to match" }),
      out: Type.String({ description: "replacement template" }),
    }),
    { minItems: 1, description: "Rewrite operations" },
  ),
  paths: Type.Array(Type.String({ description: "Local file, directory, or glob to rewrite" }), {
    minItems: 1,
    description: "Local files, directories, or globs to rewrite",
  }),
});

export const astEditResolveParameters = Type.Object({
  id: Type.String({ description: "Pending ast_edit preview id" }),
  action: Type.String({ enum: ["apply", "discard"], description: "Apply or discard the pending preview" }),
});

export interface AstEditParams {
  ops: Array<{ pat: string; out: string }>;
  paths: string[];
}

export interface AstEditResolveParams {
  id: string;
  action: "apply" | "discard";
}

interface DisplayChange extends AstReplaceChange {
  displayPath: string;
  absolutePath: string;
}

interface DisplayFileChange extends AstReplaceFileChange {
  displayPath: string;
  absolutePath: string;
}

interface AggregatedEditResult {
  changes: DisplayChange[];
  fileChanges: DisplayFileChange[];
  totalReplacements: number;
  filesTouched: number;
  filesSearched: number;
  applied: boolean;
  limitReached: boolean;
  parseErrors?: string[];
}

export interface AstEditDetails extends TextToolResultDetails {
  id?: string;
  totalReplacements: number;
  filesTouched: number;
  filesSearched: number;
  applied: boolean;
  limitReached: boolean;
  parseErrors?: string[];
  parseErrorsTotal?: number;
  files?: string[];
  fileReplacements?: Array<{ path: string; count: number }>;
  stale?: boolean;
  action?: "apply" | "discard";
}

export interface PendingAstEdit {
  id: string;
  params: AstEditParams;
  cwd: string;
  targets: ResolvedSearchTarget[];
  rewrites: Record<string, string>;
  maxFiles: number;
  signature: string;
  touchedFiles: string[];
  createdAt: number;
}

export type AstEditState = Map<string, PendingAstEdit>;

function normalizeParseErrors(errors: string[] | undefined): { errors: string[]; total: number } {
  const normalized = errors ?? [];
  return { errors: normalized.slice(0, PARSE_ERROR_LIMIT), total: normalized.length };
}

function compareChange(left: DisplayChange, right: DisplayChange): number {
  return (
    left.displayPath.localeCompare(right.displayPath) ||
    left.startLine - right.startLine ||
    left.startColumn - right.startColumn ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn ||
    left.byteStart - right.byteStart ||
    left.byteEnd - right.byteEnd ||
    left.before.localeCompare(right.before) ||
    left.after.localeCompare(right.after)
  );
}

function validateOps(params: AstEditParams): Record<string, string> {
  if (!params.ops || params.ops.length === 0) throw new Error("`ops` must include at least one op entry");
  const rewrites: Record<string, string> = {};
  for (const [index, op] of params.ops.entries()) {
    if (!op.pat.trim()) throw new Error(`\`ops[${index}].pat\` must be a non-empty pattern`);
    if (Object.prototype.hasOwnProperty.call(rewrites, op.pat)) {
      throw new Error(`Duplicate rewrite pattern: ${op.pat}`);
    }
    rewrites[op.pat] = op.out;
  }
  return rewrites;
}

async function runAstEditTargets(
  targets: ResolvedSearchTarget[],
  cwd: string,
  options: {
    rewrites: Record<string, string>;
    dryRun: boolean;
    maxFiles: number;
    signal?: AbortSignal;
  },
): Promise<AggregatedEditResult> {
  const changes: DisplayChange[] = [];
  const fileCounts = new Map<string, DisplayFileChange>();
  const parseErrors: string[] = [];
  let totalReplacements = 0;
  let filesSearched = 0;
  let applied = !options.dryRun;
  let limitReached = false;

  for (const target of targets) {
    const result = await astEdit({
      rewrites: options.rewrites,
      path: target.basePath,
      glob: target.glob,
      dryRun: options.dryRun,
      maxFiles: options.maxFiles,
      failOnParseError: false,
      signal: options.signal,
    });

    totalReplacements += result.totalReplacements;
    filesSearched += result.filesSearched;
    applied = applied && result.applied;
    limitReached = limitReached || result.limitReached;
    if (result.parseErrors) parseErrors.push(...result.parseErrors);

    for (const change of result.changes) {
      const absolutePath = absoluteMatchPath(target, change.path);
      changes.push({ ...change, absolutePath, displayPath: formatPathRelativeToCwd(absolutePath, cwd) });
    }
    for (const fileChange of result.fileChanges) {
      const absolutePath = absoluteMatchPath(target, fileChange.path);
      const displayPath = formatPathRelativeToCwd(absolutePath, cwd);
      const existing = fileCounts.get(displayPath);
      fileCounts.set(displayPath, {
        ...fileChange,
        absolutePath,
        displayPath,
        count: (existing?.count ?? 0) + fileChange.count,
      });
    }
  }

  changes.sort(compareChange);
  const fileChanges = [...fileCounts.values()].sort((left, right) => left.displayPath.localeCompare(right.displayPath));
  return {
    changes,
    fileChanges,
    totalReplacements,
    filesTouched: fileChanges.length,
    filesSearched,
    applied,
    limitReached,
    parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
  };
}

function signatureFor(result: AggregatedEditResult): string {
  return JSON.stringify({
    totalReplacements: result.totalReplacements,
    filesTouched: result.filesTouched,
    fileChanges: result.fileChanges.map((entry) => ({ path: entry.displayPath, count: entry.count })),
    changes: result.changes.map((entry) => ({
      path: entry.displayPath,
      before: entry.before,
      after: entry.after,
      byteStart: entry.byteStart,
      byteEnd: entry.byteEnd,
      startLine: entry.startLine,
      startColumn: entry.startColumn,
      endLine: entry.endLine,
      endColumn: entry.endColumn,
    })),
  });
}

function renderChanges(result: AggregatedEditResult, parseErrors: string[], parseErrorsTotal: number, id?: string): string {
  const lines: string[] = [];
  const byFile = new Map<string, DisplayChange[]>();
  for (const change of result.changes) {
    const list = byFile.get(change.displayPath) ?? [];
    list.push(change);
    byFile.set(change.displayPath, list);
  }

  for (const [filePath, changes] of byFile) {
    if (lines.length > 0) lines.push("");
    const count = result.fileChanges.find((entry) => entry.displayPath === filePath)?.count ?? changes.length;
    lines.push(`${filePath} (${count} replacement${count === 1 ? "" : "s"})`);
    for (const change of changes) {
      const before = (change.before.split("\n", 1)[0] ?? "").slice(0, 160);
      const after = (change.after.split("\n", 1)[0] ?? "").slice(0, 160);
      lines.push(`-${change.startLine}:${change.startColumn}: ${before}`);
      lines.push(`+${change.startLine}:${change.startColumn}: ${after}`);
    }
  }

  if (result.limitReached) lines.push("", "Limit reached; narrow `paths`.");
  if (parseErrors.length > 0) {
    lines.push("", `Parse issues (${parseErrors.length} shown${parseErrorsTotal > parseErrors.length ? ` of ${parseErrorsTotal}` : ""}):`);
    for (const error of parseErrors) lines.push(`- ${error}`);
  }
  if (id) {
    lines.push(
      "",
      `Preview only. Call ast_edit_resolve({ id: "${id}", action: "apply" }) to apply, or action: "discard" to discard.`,
    );
  }

  return lines.join("\n");
}

function detailsFor(result: AggregatedEditResult, parseErrors: string[], parseErrorsTotal: number, extra: Partial<AstEditDetails> = {}): AstEditDetails {
  return {
    totalReplacements: result.totalReplacements,
    filesTouched: result.filesTouched,
    filesSearched: result.filesSearched,
    applied: result.applied,
    limitReached: result.limitReached,
    ...(parseErrors.length > 0 ? { parseErrors, parseErrorsTotal } : {}),
    files: result.fileChanges.map((entry) => entry.displayPath),
    fileReplacements: result.fileChanges.map((entry) => ({ path: entry.displayPath, count: entry.count })),
    ...extra,
  };
}

export function createAstEditTool(state: AstEditState) {
  return {
    name: "ast_edit",
    label: "AST Edit",
    description:
      "Preview AST-aware structural rewrites over local files. This tool does not write until ast_edit_resolve applies the preview.",
    promptSnippet: "Preview syntax-aware structural rewrites with ast-grep.",
    promptGuidelines: [
      "Use ast_edit for codemods or structural rewrites where text replacement is unsafe.",
      "ast_edit previews only; call ast_edit_resolve with action `apply` or `discard` after reviewing the preview.",
      "Use `$$$NAME`, not `$$NAME`, for zero-or-more ast_edit metavariable captures.",
      "Treat ast_edit parse issues as malformed pattern or mis-scoped paths, not as a clean no-op.",
    ],
    parameters: astEditParameters,

    async execute(_toolCallId: string, params: AstEditParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const rewrites = validateOps(params);
      if (!params.paths || params.paths.length === 0) throw new Error("`paths` must include at least one path");
      const maxFiles = envPositiveInt("PI_MAX_AST_FILES", 1000);
      const targets = await resolveSearchTargets(params.paths, ctx.cwd);
      const preview = await runAstEditTargets(targets, ctx.cwd, { rewrites, dryRun: true, maxFiles, signal });
      const parse = normalizeParseErrors(preview.parseErrors);

      if (preview.totalReplacements === 0) {
        const details = detailsFor(preview, parse.errors, parse.total);
        const parseText = parse.errors.length > 0 ? `\nParse issues:\n${parse.errors.map((error) => `- ${error}`).join("\n")}` : "";
        return textResult(`No replacements made${parseText}`, details);
      }

      const id = crypto.randomUUID();
      const signature = signatureFor(preview);
      state.set(id, {
        id,
        params,
        cwd: ctx.cwd,
        targets,
        rewrites,
        maxFiles,
        signature,
        touchedFiles: preview.fileChanges.map((entry) => entry.absolutePath),
        createdAt: Date.now(),
      });

      const details = detailsFor(preview, parse.errors, parse.total, { id });
      return textResult(renderChanges(preview, parse.errors, parse.total, id), details);
    },
  };
}

export function createAstEditResolveTool(state: AstEditState) {
  return {
    name: "ast_edit_resolve",
    label: "AST Edit Resolve",
    description: "Apply or discard a pending ast_edit preview.",
    promptSnippet: "Apply or discard a pending ast_edit preview.",
    promptGuidelines: [
      "Use ast_edit_resolve after ast_edit previews; do not claim ast_edit changed files until ast_edit_resolve apply succeeds.",
      "If ast_edit_resolve reports a stale preview, rerun ast_edit before applying.",
    ],
    parameters: astEditResolveParameters,

    async execute(_toolCallId: string, params: AstEditResolveParams, signal: AbortSignal | undefined) {
      const pending = state.get(params.id);
      if (!pending) {
        return textResult<AstEditDetails>(`No pending ast_edit preview found for id ${params.id}. Rerun ast_edit.`, {
          totalReplacements: 0,
          filesTouched: 0,
          filesSearched: 0,
          applied: false,
          limitReached: false,
          id: params.id,
          action: params.action,
        } satisfies AstEditDetails);
      }

      if (params.action === "discard") {
        state.delete(params.id);
        return textResult<AstEditDetails>(`Discarded pending ast_edit preview ${params.id}.`, {
          totalReplacements: 0,
          filesTouched: 0,
          filesSearched: 0,
          applied: false,
          limitReached: false,
          id: params.id,
          action: "discard",
        } satisfies AstEditDetails);
      }

      if (params.action !== "apply") throw new Error('`action` must be "apply" or "discard"');

      return withFileMutationQueues(pending.touchedFiles, async () => {
        const currentPreview = await runAstEditTargets(pending.targets, pending.cwd, {
          rewrites: pending.rewrites,
          dryRun: true,
          maxFiles: pending.maxFiles,
          signal,
        });
        const currentSignature = signatureFor(currentPreview);
        if (currentSignature !== pending.signature) {
          state.delete(params.id);
          const parse = normalizeParseErrors(currentPreview.parseErrors);
          const details = detailsFor(currentPreview, parse.errors, parse.total, {
            id: params.id,
            stale: true,
            action: "apply",
          });
          return textResult(
            `Pending ast_edit preview ${params.id} is stale; no files were changed. Rerun ast_edit before applying.`,
            details,
          );
        }

        const applied = await runAstEditTargets(pending.targets, pending.cwd, {
          rewrites: pending.rewrites,
          dryRun: false,
          maxFiles: pending.maxFiles,
          signal,
        });
        state.delete(params.id);
        const parse = normalizeParseErrors(applied.parseErrors);
        const details = detailsFor(applied, parse.errors, parse.total, { id: params.id, action: "apply" });
        const text = `Applied ${applied.totalReplacements} replacement${applied.totalReplacements === 1 ? "" : "s"} in ${applied.filesTouched} file${applied.filesTouched === 1 ? "" : "s"}.`;
        return textResult(text, details);
      });
    },
  };
}
