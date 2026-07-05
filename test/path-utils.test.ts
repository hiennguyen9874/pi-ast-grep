import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSearchPathPreferringLiteral, toPathList } from "../src/path-utils";

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-ast-path-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("path utils", () => {
  it("splits src/**/*.ts into base src and glob **/*.ts", async () => {
    const cwd = await tempDir();
    const target = await parseSearchPathPreferringLiteral("src/**/*.ts", cwd);
    expect(target.basePath).toBe(path.join(cwd, "src"));
    expect(target.glob).toBe("**/*.ts");
  });

  it("splits *.ts into base cwd and glob *.ts", async () => {
    const cwd = await tempDir();
    const target = await parseSearchPathPreferringLiteral("*.ts", cwd);
    expect(target.basePath).toBe(cwd);
    expect(target.glob).toBe("*.ts");
  });

  it("prefers an existing literal path with brackets over glob parsing", async () => {
    const cwd = await tempDir();
    const file = path.join(cwd, "literal[abc].ts");
    await writeFile(file, "const x = 1;\n", "utf8");

    const target = await parseSearchPathPreferringLiteral("literal[abc].ts", cwd);
    expect(target.basePath).toBe(file);
    expect(target.glob).toBeUndefined();
    expect(target.isFile).toBe(true);
  });

  it("splits semicolon-delimited path lists", () => {
    expect(toPathList("src/**/*.ts; tests/**/*.ts ; ;README.md")).toEqual([
      "src/**/*.ts",
      "tests/**/*.ts",
      "README.md",
    ]);
  });
});
