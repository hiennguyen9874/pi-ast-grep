import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const GLOB_CHARS_RE = /[*?[\]{}]/;

export interface ResolvedSearchTarget {
  rawPath: string;
  basePath: string;
  glob?: string;
  isFile: boolean;
}

export function normalizeAtPrefix(value: string): string {
  if (!value.startsWith("@")) return value;
  const withoutAt = value.slice(1);
  if (
    withoutAt.startsWith("/") ||
    withoutAt === "~" ||
    withoutAt.startsWith("~/") ||
    path.win32.isAbsolute(withoutAt)
  ) {
    return withoutAt;
  }
  return value;
}

export function expandTilde(value: string, home = os.homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return home + value.slice(1);
  return value;
}

export function resolveToCwd(value: string, cwd: string): string {
  const expanded = expandTilde(normalizeAtPrefix(value.trim()));
  if (/^\/+$/u.test(expanded)) return cwd;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

export function toPathList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : value.split(";");
  return values.map((entry) => entry.trim()).filter(Boolean);
}

export function hasGlobPathChars(value: string): boolean {
  return GLOB_CHARS_RE.test(value);
}

async function statIfExists(absolutePath: string) {
  try {
    return await stat(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function assertLocalPath(rawPath: string): void {
  if (URL_SCHEME_RE.test(rawPath) || /^www\./i.test(rawPath)) {
    throw new Error(`Only local filesystem paths are supported: ${rawPath}`);
  }
}

function splitGlobPath(rawPath: string): { base: string; glob: string } {
  const normalized = rawPath.replace(/\\/g, "/");
  const absolutePrefix = normalized.startsWith("/") ? "/" : "";
  const parts = normalized.split("/");
  let firstGlobIndex = parts.findIndex((part) => hasGlobPathChars(part));
  if (firstGlobIndex < 0) firstGlobIndex = parts.length - 1;

  const baseParts = parts.slice(0, firstGlobIndex).filter((part, index) => !(index === 0 && part === ""));
  const globParts = parts.slice(firstGlobIndex).filter((part) => part.length > 0);
  const base = absolutePrefix + baseParts.join("/");
  return { base: base || ".", glob: globParts.join("/") || "**/*" };
}

export async function parseSearchPathPreferringLiteral(rawPath: string, cwd: string): Promise<ResolvedSearchTarget> {
  const normalized = normalizeAtPrefix(rawPath.trim());
  assertLocalPath(normalized);

  const literalPath = resolveToCwd(normalized, cwd);
  const literalStat = await statIfExists(literalPath);
  if (literalStat) {
    return {
      rawPath,
      basePath: literalPath,
      isFile: literalStat.isFile(),
    };
  }

  if (!hasGlobPathChars(normalized)) {
    return { rawPath, basePath: literalPath, isFile: false };
  }

  const { base, glob } = splitGlobPath(normalized);
  const basePath = resolveToCwd(base, cwd);
  const baseStat = await statIfExists(basePath);
  return {
    rawPath,
    basePath,
    glob,
    isFile: baseStat?.isFile() ?? false,
  };
}

export const parseSearchPath = parseSearchPathPreferringLiteral;

export async function resolveSearchTargets(rawPaths: string[], cwd: string): Promise<ResolvedSearchTarget[]> {
  const targets = await Promise.all(rawPaths.map((rawPath) => parseSearchPathPreferringLiteral(rawPath, cwd)));
  return targets;
}

export function normalizePosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function formatPathRelativeToCwd(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return normalizePosixPath(relative);
  }
  return normalizePosixPath(path.resolve(absolutePath));
}

export function absoluteMatchPath(target: ResolvedSearchTarget, nativePath: string): string {
  return target.isFile ? target.basePath : path.resolve(target.basePath, nativePath);
}
