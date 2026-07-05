import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAstGrepTool } from "../src/tools/ast-grep";

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-ast-grep-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ast_grep tool", () => {
  it("finds a structural TypeScript call", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "fixture.ts"), "const x = 1;\nconsole.log(x);\n", "utf8");

    const tool = createAstGrepTool() as any;
    const result = await tool.execute("call", { pat: "console.log($$$ARGS)", path: "src/**/*.ts" }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain("src/fixture.ts");
    expect(result.content[0].text).toContain("console.log(x)");
    expect(result.details.matchCount).toBe(1);
  });

  it("returns a clean no-match message", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "fixture.ts"), "const x = 1;\n", "utf8");

    const tool = createAstGrepTool() as any;
    const result = await tool.execute("call", { pat: "console.log($$$ARGS)", path: "*.ts" }, undefined, undefined, { cwd });

    expect(result.content[0].text).toContain("No matches found");
    expect(result.details.matchCount).toBe(0);
  });
});
