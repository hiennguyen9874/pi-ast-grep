import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAstEditResolveTool, createAstEditTool, type AstEditState } from "./tools/ast-edit";
import { createAstGrepTool } from "./tools/ast-grep";

export default function astGrepExtension(pi: ExtensionAPI) {
  const astEditState: AstEditState = new Map();

  pi.registerTool(createAstGrepTool());
  pi.registerTool(createAstEditTool(astEditState));
  pi.registerTool(createAstEditResolveTool(astEditState));
}
