import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

export interface TextToolResultDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export async function textResult<T extends TextToolResultDetails>(text: string, details: T) {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let resultText = truncation.content;
  if (truncation.truncated) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-ast-grep-"));
    const tempFile = path.join(tempDir, "output.txt");
    await withFileMutationQueue(tempFile, async () => {
      await writeFile(tempFile, text, "utf8");
    });

    details.truncation = truncation;
    details.fullOutputPath = tempFile;
    resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
    resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    resultText += ` Full output saved to: ${tempFile}]`;
  }

  return {
    content: [{ type: "text" as const, text: resultText }],
    details,
  };
}

export async function withFileMutationQueues<T>(absolutePaths: string[], run: () => Promise<T>): Promise<T> {
  const uniquePaths = [...new Set(absolutePaths.map((entry) => path.resolve(entry)))].sort();

  const enter = (index: number): Promise<T> => {
    const nextPath = uniquePaths[index];
    if (!nextPath) return run();
    return withFileMutationQueue(nextPath, () => enter(index + 1));
  };

  return enter(0);
}

export function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
