# pi-ast-grep

AST-aware structural search and rewrite extension for [pi](https://github.com/earendil-works/pi-coding-agent), powered by [ast-grep](https://ast-grep.github.io/) and tree-sitter.

## Features

- **Structural search** (`ast_grep`) — Find code by AST shape, not text. Match calls, declarations, imports, and language constructs across 50+ languages.
- **Preview-before-apply rewrites** (`ast_edit` / `ast_edit_resolve`) — Preview structural replacements, review the diff, then apply or discard. Stale previews are detected before writing, preventing accidental overwrites.
- **50+ languages** — Bundles tree-sitter parsers for TypeScript, JavaScript, Python, Rust, Go, Java, C, C++, Ruby, PHP, Swift, Kotlin, and many more (see [Language support](#language-support)).
- **Native performance** — Rust backend via NAPI-RS for fast, cancellable searches and rewrites.
- **File mutation queues** — Integrates with pi's file mutation queue, so edits play nicely with other tools touching the same files.

## Installation

```bash
npm install pi-ast-grep
```

Or within a pi workspace:

```bash
pi install pi-ast-grep
```

### Requirements

- Node.js >= 22
- Linux x64 (glibc) — other platforms require building the native addon from source (see [Building from source](#building-from-source))
- pi >= 0.74.0

## Tools

### `ast_grep` — structural search

Search local source files with ast-grep structural patterns.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pat` | string | yes | ast-grep structural pattern |
| `path` | string | no | File, directory, glob, or `;`-delimited list. Defaults to `.` |
| `skip` | number | no | Skip the first N sorted matches for pagination |

**Pattern syntax:**

- `$NAME` — capture exactly one AST node
- `$$$NAME` — capture zero or more AST nodes
- Repeated meta-variables require identical code (e.g., `$A == $A` matches `x == x` only)
- Patterns must parse as a single valid AST node

**Examples:**

```
console.log($$$ARGS)                    # find all console.log calls
$IMPORT from '$SOURCE'                  # find imports
class $_ { $$$BODY }                    # find class bodies
async function $NAME($$$ARGS): $_ { $$$BODY }  # find async functions
```

### `ast_edit` — preview structural rewrites

Preview AST-aware replacements without writing files. Each call produces a preview ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ops` | array | yes | Rewrite operations, each with `pat` and `out` |
| `paths` | array | yes | Files, directories, or globs to target |

### `ast_edit_resolve` — apply or discard

Apply or discard a pending `ast_edit` preview.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Preview ID from an `ast_edit` call |
| `action` | string | yes | `"apply"` or `"discard"` |

**Workflow:**

```
ast_edit → review preview → ast_edit_resolve (apply | discard)
```

If the files changed since the preview was created, `apply` reports the preview as stale and does nothing. Rerun `ast_edit` to get a fresh preview.

## Language support

Supported file types and their tree-sitter parsers:

| Language | Extensions |
|----------|-----------|
| Astro | `.astro` |
| Bash | `.sh`, `.bash`, `.bashrc`, `.bash_profile` |
| C | `.c`, `.h` |
| C# | `.cs` |
| C++ | `.cpp`, `.cc`, `.cxx`, `.h`, `.hpp`, `.hh`, `.hxx` |
| Clojure | `.clj`, `.cljs`, `.cljc`, `.edn` |
| CMake | `.cmake`, `CMakeLists.txt` |
| CSS | `.css` |
| Dart | `.dart` |
| Diff | `.diff`, `.patch` |
| Dockerfile | `Dockerfile`, `.dockerfile` |
| Elixir | `.ex`, `.exs` |
| Elisp | `.el` |
| Erlang | `.erl`, `.hrl` |
| Fortran | `.f`, `.f90`, `.f95`, `.f03`, `.f08` |
| Go | `.go` |
| GraphQL | `.graphql`, `.gql` |
| Haskell | `.hs`, `.lhs` |
| HCL | `.hcl`, `.tf` |
| HTML | `.html`, `.htm` |
| INI | `.ini` |
| Java | `.java` |
| JavaScript | `.js`, `.jsx`, `.cjs`, `.mjs` |
| JSON | `.json` |
| Julia | `.jl` |
| Just | `.just`, `Justfile`, `justfile` |
| Kotlin | `.kt`, `.kts` |
| Lua | `.lua` |
| Make | `Makefile`, `*.mk` |
| Markdown | `.md`, `.markdown` |
| Nix | `.nix` |
| Objective-C | `.m`, `.mm` |
| OCaml | `.ml`, `.mli` |
| Odin | `.odin` |
| Perl | `.pl`, `.pm` |
| PHP | `.php` |
| PowerShell | `.ps1`, `.psm1`, `.psd1` |
| Protobuf | `.proto` |
| Python | `.py`, `.pyi`, `.pyx`, `.pxd`, `.pxi` |
| R | `.r`, `.R` |
| Regex | `.regex` |
| Ruby | `.rb` |
| Rust | `.rs` |
| Scala | `.scala` |
| Solidity | `.sol` |
| SQL | `.sql` |
| Starlark | `.star`, `.bzl`, `BUILD`, `WORKSPACE` |
| Svelte | `.svelte` |
| Swift | `.swift` |
| TLA+ | `.tla` |
| TOML | `.toml` |
| TypeScript | `.ts`, `.tsx`, `.cts`, `.mts` |
| Verilog | `.v`, `.sv` |
| Vue | `.vue` |
| XML | `.xml` |
| YAML | `.yaml`, `.yml` |
| Zig | `.zig` |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_MAX_AST_FILES` | `1000` | Maximum files searched per `ast_edit` call |

## Building from source

```bash
# Install dependencies
npm install

# Build the native addon (requires Rust toolchain)
npm run build:native

# Run tests
npm test
```

### Rust prerequisites

Install Rust via [rustup](https://rustup.rs):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## License

MIT
