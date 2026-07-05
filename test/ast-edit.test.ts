import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAstEditResolveTool, createAstEditTool, type AstEditState } from "../src/tools/ast-edit";

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-ast-edit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ast_edit tools", () => {
  it("previews without changing the file, then applies through resolve", async () => {
    const cwd = await tempDir();
    const file = path.join(cwd, "fixture.ts");
    await writeFile(file, "oldApi(1, 2);\n", "utf8");

    const state: AstEditState = new Map();
    const editTool = createAstEditTool(state) as any;
    const resolveTool = createAstEditResolveTool(state) as any;

    const preview = await editTool.execute(
      "preview",
      { ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }], paths: ["*.ts"] },
      undefined,
      undefined,
      { cwd },
    );

    expect(preview.content[0].text).toContain("Preview only");
    expect(preview.details.totalReplacements).toBe(1);
    expect(await readFile(file, "utf8")).toBe("oldApi(1, 2);\n");

    const applied = await resolveTool.execute("apply", { id: preview.details.id, action: "apply" }, undefined);
    expect(applied.content[0].text).toContain("Applied 1 replacement");
    expect(await readFile(file, "utf8")).toBe("newApi(1, 2);\n");
  });

  it("blocks apply when the preview is stale", async () => {
    const cwd = await tempDir();
    const file = path.join(cwd, "fixture.ts");
    await writeFile(file, "oldApi(1);\n", "utf8");

    const state: AstEditState = new Map();
    const editTool = createAstEditTool(state) as any;
    const resolveTool = createAstEditResolveTool(state) as any;

    const preview = await editTool.execute(
      "preview",
      { ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }], paths: ["*.ts"] },
      undefined,
      undefined,
      { cwd },
    );
    await writeFile(file, "oldApi(2);\n", "utf8");

    const applied = await resolveTool.execute("apply", { id: preview.details.id, action: "apply" }, undefined);
    expect(applied.content[0].text).toContain("stale");
    expect(applied.details.stale).toBe(true);
    expect(await readFile(file, "utf8")).toBe("oldApi(2);\n");
  });
});
