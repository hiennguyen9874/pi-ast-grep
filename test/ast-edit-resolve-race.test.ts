import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-ast-edit-race-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.doUnmock("../native/index.js");
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ast_edit_resolve race safety", () => {
  it("applies only exact preview-touched files", async () => {
    vi.resetModules();
    const calls: any[] = [];
    const astEdit = vi.fn(async (options: any) => {
      calls.push(options);
      return {
        changes: [
          {
            path: "fixture.ts",
            before: "oldApi(1)",
            after: "newApi(1)",
            byteStart: 0,
            byteEnd: 9,
            deletedLength: 9,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 10,
          },
        ],
        fileChanges: [{ path: "fixture.ts", count: 1 }],
        totalReplacements: 1,
        filesTouched: 1,
        filesSearched: 1,
        applied: !options.dryRun,
        limitReached: false,
      };
    });
    vi.doMock("../native/index.js", () => ({ astEdit }));

    const { createAstEditResolveTool, createAstEditTool } = await import("../src/tools/ast-edit");
    const cwd = await tempDir();
    const previewedFile = path.join(cwd, "fixture.ts");
    await writeFile(previewedFile, "oldApi(1);\n", "utf8");

    const state = new Map();
    const editTool = createAstEditTool(state) as any;
    const resolveTool = createAstEditResolveTool(state) as any;

    const preview = await editTool.execute(
      "preview",
      { ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }], paths: ["*.ts"] },
      undefined,
      undefined,
      { cwd },
    );
    await writeFile(path.join(cwd, "new-file.ts"), "oldApi(2);\n", "utf8");

    await resolveTool.execute("apply", { id: preview.details.id, action: "apply" }, undefined);

    const applyCalls = calls.filter((call) => call.dryRun === false);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].path).toBe(previewedFile);
    expect(applyCalls[0].glob).toBeUndefined();
  });
});
