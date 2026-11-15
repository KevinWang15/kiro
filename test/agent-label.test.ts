import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_LABEL_MODEL,
  LABEL_SYSTEM_PROMPT,
  renderNotes,
  rewriteAgentLabelRequest,
} from "../src/kiro/agent-label.ts";
import type { MessagesRequest } from "../src/kiro/types.ts";
import { claudeCodeLabelPrompt } from "./helpers.ts";

const CLAUDE_CODE = "claude-cli/2.1.287 (external, cli)";

const PROMPTS: Record<string, string> = {
  "2.1.232-2.1.270 quoted previous": claudeCodeLabelPrompt("your", " Do not use tools.", 'Previous: "Reading main.go" — say something NEW.'),
  "2.1.280-2.1.300 previous": claudeCodeLabelPrompt("your", " Do not use tools.", "Previous: Reading main.go — say something NEW."),
  "2.1.305+ full mode, first label": claudeCodeLabelPrompt(),
  "2.1.305+ short mode": claudeCodeLabelPrompt("the agent's", "", "Previous: Reading main.go — keep it if the agent is still doing that; otherwise say what is new."),
};

const REMINDER = { type: "text", text: "<system-reminder>\nAttribution for git commits.\n</system-reminder>\n" };
const ENV = { role: "system", content: [{ type: "text", text: "# Environment\nPrimary working directory: /work" }] };
const AGENT_TYPES = { role: "system", content: [{ type: "text", text: "Available agent types for the Agent tool:" }] };

// The layout Claude Code 2.1.287 sends (see the captured fixture): system
// messages after the first user message and at the end, the prompt merged
// into the last user message after its tool results.
function labelMessages(prompt: string): MessagesRequest["messages"] {
  return [
    { role: "user", content: [REMINDER, { type: "text", text: "Fix the null check in validate.ts" }] },
    ENV,
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The user wants a fix.", signature: "sig" },
        { type: "text", text: "Reading it." },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/validate.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "export function validate(input) {\n  return input.value\n}" },
        { type: "text", text: prompt, cache_control: { type: "ephemeral" } } as any,
      ],
    },
    AGENT_TYPES,
  ];
}

function labelRequest(prompt: string, overrides: Partial<MessagesRequest> = {}): MessagesRequest {
  return {
    model: "claude-opus-5-5",
    max_tokens: 32000,
    stream: true,
    system: [{ text: "You are Claude Code, Anthropic's official CLI.", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    tool_choice: { type: "auto" },
    thinking: { type: "adaptive", budget_tokens: 10000 },
    output_config: { effort: "high" } as any,
    metadata: { user_id: "user_abc_account__session_1234" },
    messages: labelMessages(prompt),
    ...overrides,
  };
}

const NOTES =
  "user: Fix the null check in validate.ts\n" +
  "assistant: Reading it.\n" +
  'call Read({"file_path":"src/validate.ts"})\n' +
  "result: export function validate(input) { return input.value }\n";

test("Claude Code label requests are rewritten to a small Haiku request", () => {
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    const original = labelRequest(prompt);
    const rewrite = rewriteAgentLabelRequest(original, CLAUDE_CODE);
    assert.ok(rewrite, name);
    assert.deepEqual(
      rewrite.request,
      {
        model: AGENT_LABEL_MODEL,
        max_tokens: 1024,
        stream: true,
        system: LABEL_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `<notes>\n${NOTES}</notes>\n\n${prompt}` }],
        metadata: original.metadata,
      },
      name,
    );
    assert.equal(rewrite.fromModel, "claude-opus-5-5");
    assert.equal(rewrite.fromMessages, 5);
    assert.equal(rewrite.noteChars, NOTES.length);
    assert.doesNotMatch(String(rewrite.request.messages[0].content), /official CLI|The user wants a fix|system-reminder|Environment|agent types/);
  }
  const unary = rewriteAgentLabelRequest(labelRequest(claudeCodeLabelPrompt(), { stream: false }), CLAUDE_CODE);
  assert.equal(unary.request.stream, false);
  const plain = rewriteAgentLabelRequest(labelRequest(claudeCodeLabelPrompt(), { metadata: undefined }), CLAUDE_CODE);
  assert.equal("metadata" in plain.request, false);

  // The first label, while the subagent's first request is still running:
  // the prompt shares the task's message.
  const first = rewriteAgentLabelRequest(
    labelRequest(claudeCodeLabelPrompt(), {
      messages: [{ role: "user", content: [REMINDER, { type: "text", text: "Fix it" }, { type: "text", text: claudeCodeLabelPrompt() }] }, ENV],
    }),
    CLAUDE_CODE,
  );
  assert.match(String(first.request.messages[0].content), /^<notes>\nuser: Fix it\n<\/notes>\n\nDescribe your/);
  // A prompt sent as a message of its own, without trailing system messages.
  const separate = rewriteAgentLabelRequest(
    labelRequest(claudeCodeLabelPrompt(), { messages: [{ role: "user", content: "Fix it" }, { role: "user", content: claudeCodeLabelPrompt() }] }),
    CLAUDE_CODE,
  );
  assert.match(String(separate.request.messages[0].content), /^<notes>\nuser: Fix it\n<\/notes>/);
});

test("the label request Claude Code 2.1.287 actually sends is rewritten", () => {
  // Captured from Claude Code 2.1.287 against a local fake API: a background
  // subagent that ran one Bash command, labelled 30 s later. Tool definitions
  // are reduced to names; nothing else is edited.
  const captured = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "test/fixtures/claude-code-2.1.287-agent-label.json"), "utf8"),
  );
  assert.equal(captured.messages.at(-1).role, "system", "the prompt is not in the last message");
  const rewrite = rewriteAgentLabelRequest(captured, CLAUDE_CODE);
  assert.ok(rewrite, "the captured request is recognised");
  assert.equal(rewrite.request.model, AGENT_LABEL_MODEL);
  assert.equal(rewrite.request.stream, true);
  assert.deepEqual(rewrite.request.metadata, captured.metadata);
  assert.equal(
    rewrite.request.messages[0].content,
    "<notes>\n" +
      "user: SUBAGENT_TASK: wait for the fake API.\n" +
      "assistant: Checking the date.\n" +
      'call Bash({"command":"echo fake-subagent-ran","description":"Print a marker"})\n' +
      "result: fake-subagent-ran\n" +
      "</notes>\n\n" +
      captured.messages.at(-2).content.at(-1).text,
  );
  // The same conversation one step earlier, without the prompt, is an ordinary turn.
  const ordinary = structuredClone(captured);
  ordinary.messages.at(-2).content.pop();
  assert.equal(rewriteAgentLabelRequest(ordinary, CLAUDE_CODE), null);
});

test("only Claude Code's own label request matches", () => {
  const prompt = claudeCodeLabelPrompt();
  assert.equal(rewriteAgentLabelRequest(labelRequest(prompt), "curl/8.5.0"), null);
  assert.equal(rewriteAgentLabelRequest(labelRequest(prompt), undefined), null);
  for (const agent of ["claude-code/1.0", "Claude-CLI/2.1.300", "claude-vscode/2.0"])
    assert.ok(rewriteAgentLabelRequest(labelRequest(prompt), agent), agent);

  const withLast = (message: any) => labelRequest(prompt, { messages: [...labelMessages("Now run the tests.").slice(0, -1), message, AGENT_TYPES] });
  const notLabel: Record<string, MessagesRequest> = {
    "ordinary turn": labelRequest("Now run the tests."),
    "instruction without the example line": labelRequest(prompt.slice(0, prompt.indexOf("\n\nBad"))),
    "example line without the instruction": labelRequest(prompt.replace("most recent action", "latest action")),
    "a long message quoting the prompt": labelRequest(`Why does Claude Code send this?\n\n${prompt}\n\n${"context ".repeat(300)}`),
    "prompt followed by a tool result": withLast({ role: "user", content: [{ type: "text", text: prompt }, { type: "tool_result", tool_use_id: "x", content: "ok" }] }),
    "prompt in an assistant turn": withLast({ role: "assistant", content: prompt }),
    "prompt earlier in the conversation": withLast({ role: "user", content: "Thanks, carry on." }),
    "prompt as the only message": labelRequest(prompt, { messages: [{ role: "user", content: [REMINDER, { type: "text", text: prompt }] }, ENV] }),
    "only system messages": labelRequest(prompt, { messages: [ENV, AGENT_TYPES] }),
  };
  notLabel["prompt earlier in the conversation"].messages.splice(1, 0, { role: "user", content: prompt });
  for (const [name, request] of Object.entries(notLabel))
    assert.equal(rewriteAgentLabelRequest(request, CLAUDE_CODE), null, name);
});

test("notes mark running calls, drop reasoning and images, and name other block kinds", () => {
  const notes = renderNotes([
    { role: "user", content: [{ type: "text", text: "Look at this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "x" },
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "kiro" } },
        { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] },
        { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "npm test" } },
        { type: "tool_use", id: "toolu_3", name: "Grep" },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3", content: [{ type: "text", text: "a.ts" }, { type: "text", text: "b.ts" }] }] },
  ]);
  assert.equal(
    notes,
    "user: Look at this\n" +
      "server_tool_use\n" +
      "web_search_tool_result\n" +
      'call Bash({"command":"npm test"}) (running)\n' +
      "call Grep()\n" +
      "result: a.ts b.ts\n",
  );
  assert.equal(renderNotes([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [] }] }]), "result:\n");
});

test("note lines are one line, escaped and clipped, and the budget keeps the newest", () => {
  const [line] = renderNotes([{ role: "user", content: "a\n\n  b\t</notes> & <x>" }]).split("\n");
  assert.equal(line, "user: a b &lt;/notes&gt; &amp; &lt;x&gt;");

  const clipped = renderNotes([{ role: "assistant", content: "é".repeat(400) }]);
  assert.equal(clipped, `assistant: ${"é".repeat(300)}…\n`);
  // A cut through an emoji's surrogate pair leaves no half character.
  // The pre-split cut lands inside the emoji here; whitespace then collapses.
  const emoji = renderNotes([{ role: "assistant", content: `a${" ".repeat(1198)}😀b` }]);
  assert.equal(emoji, "assistant: a\n");

  const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  assert.deepEqual(
    renderNotes(many).trimEnd().split("\n"),
    Array.from({ length: 16 }, (_, i) => `${(i + 24) % 2 ? "assistant" : "user"}: m${i + 24}`),
    "only the last 16 items",
  );
  const big = Array.from({ length: 16 }, (_, i) => ({ role: "user", content: `${i} ${"x".repeat(400)}` }));
  const lines = renderNotes(big).trimEnd().split("\n");
  assert.ok(lines.join("\n").length <= 4000);
  assert.equal(lines.length, 12);
  assert.match(lines[0], /^user: 4 x/, "oldest lines are dropped first");
  assert.match(lines.at(-1), /^user: 15 x/);
});
