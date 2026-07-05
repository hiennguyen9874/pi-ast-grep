import path from "node:path";
import { Type } from "typebox";
import { astGrep, type AstFindMatch } from "../../native/index.js";
import {
  absoluteMatchPath,
  formatPathRelativeToCwd,
  resolveSearchTargets,
  toPathList,
  type ResolvedSearchTarget,
} from "../path-utils";
import { textResult, type TextToolResultDetails } from "./common";

const DEFAULT_AST_LIMIT = 50;
const PARSE_ERROR_LIMIT = 20;

export const astGrepParameters = Type.Object({
  pat: Type.String({ description: "ast-grep structural pattern" }),
  path: Type.Optional(
    Type.String({
      description:
        'Local file, directory, glob, or semicolon-delimited list to search. Omitted searches ".".',
    }),
  ),
  skip: Type.Optional(Type.Number({ description: "Number of sorted matches to skip before returning results" })),
});

export interface AstGrepParams {
  pat: string;
  path?: string;
  skip?: number;
}

interface DisplayMatch extends AstFindMatch {
  displayPath: string;
  absolutePath: string;
}

export interface AstGrepDetails extends TextToolResultDetails {
  matchCount: number;
  fileCount: number;
  filesSearched: number;
  limitReached: boolean;
  parseErrors?: string[];
  parseErrorsTotal?: number;
  files?: string[];
  fileMatches?: Array<{ path: string; count: number }>;
}

function compareMatch(left: DisplayMatch, right: DisplayMatch): number {
  return (
    left.displayPath.localeCompare(right.displayPath) ||
    left.startLine - right.startLine ||
    left.startColumn - right.startColumn ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn ||
    left.byteStart - right.byteStart ||
    left.byteEnd - right.byteEnd
  );
}

function normalizeParseErrors(errors: string[] | undefined): { errors: string[]; total: number } {
  const normalized = (errors ?? []).map((error) => {
    const parseError = error.match(/^.+: (.+: parse error \(syntax tree contains error nodes\))$/u);
    return parseError?.[1] ?? error;
  });
  return { errors: normalized.slice(0, PARSE_ERROR_LIMIT), total: normalized.length };
}

async function runTargets(
  targets: ResolvedSearchTarget[],
  cwd: string,
  pattern: string,
  skip: number,
  signal?: AbortSignal,
) {
  const retained: DisplayMatch[] = [];
  let totalMatches = 0;
  let filesWithMatches = 0;
  let filesSearched = 0;
  let limitReached = false;
  const parseErrors: string[] = [];

  for (const target of targets) {
    const result = await astGrep({
      patterns: [pattern],
      path: target.basePath,
      glob: target.glob,
      offset: 0,
      limit: skip + DEFAULT_AST_LIMIT + 1,
      includeMeta: true,
      signal,
    });

    totalMatches += result.totalMatches;
    filesWithMatches += result.filesWithMatches;
    filesSearched += result.filesSearched;
    limitReached = limitReached || result.limitReached;
    if (result.parseErrors) parseErrors.push(...result.parseErrors);

    for (const match of result.matches) {
      const absolutePath = absoluteMatchPath(target, match.path);
      retained.push({
        ...match,
        absolutePath,
        displayPath: formatPathRelativeToCwd(absolutePath, cwd),
      });
    }
  }

  retained.sort(compareMatch);
  const visible = retained.slice(skip);
  const matches = visible.slice(0, DEFAULT_AST_LIMIT);

  return {
    matches,
    totalMatches,
    filesWithMatches,
    filesSearched,
    limitReached: limitReached || visible.length > DEFAULT_AST_LIMIT,
    parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
  };
}

function renderMatches(matches: DisplayMatch[], limitReached: boolean, parseErrors: string[], parseErrorsTotal: number): string {
  const lines: string[] = [];
  const byFile = new Map<string, DisplayMatch[]>();
  for (const match of matches) {
    const list = byFile.get(match.displayPath) ?? [];
    list.push(match);
    byFile.set(match.displayPath, list);
  }

  for (const [filePath, fileMatches] of byFile) {
    if (lines.length > 0) lines.push("");
    lines.push(`${filePath} (${fileMatches.length} match${fileMatches.length === 1 ? "" : "es"})`);
    for (const match of fileMatches) {
      const matchLines = match.text.split("\n");
      for (let index = 0; index < matchLines.length; index++) {
        const lineNumber = match.startLine + index;
        const marker = index === 0 ? "*" : " ";
        lines.push(`${marker}${lineNumber}:${index === 0 ? match.startColumn : 1}: ${matchLines[index] ?? ""}`);
      }
      if (match.metaVariables && Object.keys(match.metaVariables).length > 0) {
        const meta = Object.entries(match.metaVariables)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}=${value}`)
          .join(", ");
        lines.push(`  meta: ${meta}`);
      }
    }
  }

  if (limitReached) lines.push("", "Result limit reached; narrow `path` or use `skip` to page.");
  if (parseErrors.length > 0) {
    lines.push("", `Parse issues (${parseErrors.length} shown${parseErrorsTotal > parseErrors.length ? ` of ${parseErrorsTotal}` : ""}):`);
    for (const error of parseErrors) lines.push(`- ${error}`);
  }
  return lines.join("\n");
}

export function createAstGrepTool() {
  return {
    name: "ast_grep",
    label: "AST Grep",
    description:
      "Search local source files with ast-grep structural patterns. Output is truncated to Pi's default tool limits.",
    promptSnippet: "Search code by AST structure with ast-grep patterns.",
    promptGuidelines: [
      "Use ast_grep when syntax shape matters more than text, such as calls, declarations, imports, or language constructs.",
      "Avoid repo-root ast_grep scans; narrow `path` to one language or subsystem first.",
      "Use `$$$NAME`, not `$$NAME`, for zero-or-more ast_grep metavariable captures.",
      "Treat ast_grep parse issues as query failure or mis-scoping, not proof that no code exists.",
    ],
    parameters: astGrepParameters,

    async execute(_toolCallId: string, params: AstGrepParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const pattern = params.pat.trim();
      if (!pattern) throw new Error("`pat` must be a non-empty pattern");

      const skip = params.skip === undefined ? 0 : Math.floor(params.skip);
      if (!Number.isFinite(skip) || skip < 0) throw new Error("`skip` must be a non-negative number");

      const rawPaths = toPathList(params.path);
      const targets = await resolveSearchTargets(rawPaths.length > 0 ? rawPaths : ["."], ctx.cwd);
      const result = await runTargets(targets, ctx.cwd, pattern, skip, signal);
      const parse = normalizeParseErrors(result.parseErrors);
      const fileCounts = new Map<string, number>();
      for (const match of result.matches) fileCounts.set(match.displayPath, (fileCounts.get(match.displayPath) ?? 0) + 1);
      const files = [...fileCounts.keys()];

      const details: AstGrepDetails = {
        matchCount: result.totalMatches,
        fileCount: result.filesWithMatches,
        filesSearched: result.filesSearched,
        limitReached: result.limitReached,
        ...(parse.errors.length > 0 ? { parseErrors: parse.errors, parseErrorsTotal: parse.total } : {}),
        files,
        fileMatches: files.map((filePath) => ({ path: filePath, count: fileCounts.get(filePath) ?? 0 })),
      };

      if (result.matches.length === 0) {
        const parseText = parse.errors.length > 0 ? `\nParse issues:\n${parse.errors.map((error) => `- ${error}`).join("\n")}` : "";
        return textResult(`No matches found${parseText}`, details);
      }

      return textResult(renderMatches(result.matches, result.limitReached, parse.errors, parse.total), details);
    },
  };
}
