import type { AnthropicTool, ContentBlock } from "./types.ts";

// Claude Code sends discovered tools in tools[] and references to them in the
// ToolSearch result. Kiro has no tool_reference content block. The ToolSearch
// description promises the model "<functions><function>{...}</function>" lines
// with full schemas, so render resolved references in that format from the
// client's own declarations, using the same names as the wire definitions.
// References to undeclared tools stay visible by name; nothing is invented.
export function renderToolReferences(
  references: ContentBlock[],
  toolsByName: ReadonlyMap<string, AnthropicTool>,
  toWireName: (name: string) => string,
): string {
  const lines = references.map((block) => {
    const tool = toolsByName.get(block.tool_name!);
    if (!tool) return `Tool found: ${toWireName(block.tool_name!)}`;
    return `<function>${JSON.stringify({
      description: tool.description || tool.name,
      name: toWireName(tool.name),
      parameters: tool.input_schema || { type: "object", properties: {} },
    })}</function>`;
  });
  const functions = lines.filter((line) => line.startsWith("<function>"));
  const unresolved = lines.filter((line) => !line.startsWith("<function>"));
  return [
    ...(functions.length ? ["<functions>", ...functions, "</functions>"] : []),
    ...unresolved,
  ].join("\n");
}
