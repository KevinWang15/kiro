import test from "node:test";
import assert from "node:assert/strict";
import { convertRequest } from "../src/kiro/converter.ts";
import { toCreateResponseRequest } from "../src/kiro/create-response.ts";
import {
  addModels,
  fieldEffort,
  modelRequestFields,
  type ModelCatalog,
} from "../src/kiro/model-fields.ts";
import type { MessagesRequest } from "../src/kiro/types.ts";
import { kiroModelList } from "./helpers.ts";

const catalog: ModelCatalog = new Map();
addModels(catalog, kiroModelList.models);
const controls = (modelId: string) => catalog.get(modelId);

const request = (model: string, extra: Partial<MessagesRequest> = {}): MessagesRequest => ({
  model,
  system: "Be brief.",
  messages: [{ role: "user", content: "Hi" }],
  ...extra,
});
const adaptive = { type: "adaptive", budget_tokens: 0 };
const firstTurn = (req: MessagesRequest, withCatalog = true) => {
  const converted = convertRequest(req, withCatalog ? { modelControls: controls } : undefined);
  return {
    fields: converted.additionalModelRequestFields,
    text: converted.conversationState.currentMessage.userInputMessage.content,
  };
};

test("Kiro's model list says which fields each model takes", () => {
  assert.deepEqual(catalog.get("claude-fable-5.2"), {
    thinkingTypes: ["adaptive"],
    effortField: "output_config",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  });
  assert.deepEqual(catalog.get("claude-opus-4.6")?.effortLevels, ["low", "medium", "high", "max"]);
  assert.deepEqual(catalog.get("gpt-5.6-sol"), {
    thinkingTypes: [],
    effortField: "reasoning",
    effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
  });
  // Models Kiro lists no fields for are absent.
  assert.equal(catalog.has("claude-sonnet-4.5"), false);
  assert.equal(catalog.has("auto"), false);

  const odd: ModelCatalog = new Map();
  for (const models of [undefined, "x", [null, 5, {}, { modelId: 7 }, { modelId: "m", additionalModelRequestFieldsSchema: [] }]])
    addModels(odd, models);
  assert.equal(odd.size, 0);
});

test("a request's thinking mode and effort become the fields Kiro lists", () => {
  const fields = (model: string, extra: Partial<MessagesRequest>) =>
    modelRequestFields(request(model, extra), catalog.get(model));

  assert.deepEqual(fields("claude-fable-5.2", { thinking: adaptive, output_config: { effort: "max" } }), {
    thinking: { type: "adaptive" },
    output_config: { effort: "max" },
  });
  // Adaptive thinking that names no effort runs at the Messages API's default.
  assert.deepEqual(fields("claude-fable-5.2", { thinking: adaptive }), {
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  });
  // An effort without thinking is still what the client asked for.
  assert.deepEqual(fields("claude-fable-5.2", { output_config: { effort: "low" } }), {
    output_config: { effort: "low" },
  });
  // A level Kiro doesn't list for the model isn't sent: Kiro answers it 400.
  assert.deepEqual(fields("claude-opus-4.6", { thinking: adaptive, output_config: { effort: "xhigh" } }), {
    thinking: { type: "adaptive" },
  });
  // Kiro has no field for a thinking budget.
  assert.equal(fields("claude-fable-5.2", { thinking: { type: "enabled", budget_tokens: 8000 } }), undefined);
  assert.deepEqual(
    fields("claude-fable-5.2", { thinking: { type: "enabled", budget_tokens: 8000 }, output_config: { effort: "medium" } }),
    { output_config: { effort: "medium" } },
  );
  assert.deepEqual(fields("gpt-5.6-sol", { output_config: { effort: "xhigh" } }), { reasoning: { effort: "xhigh" } });
  assert.equal(fields("claude-fable-5.2", {}), undefined);
  assert.equal(fields("claude-sonnet-4.5", { thinking: adaptive, output_config: { effort: "high" } }), undefined);

  assert.equal(fieldEffort({ output_config: { effort: "max" } }), "max");
  assert.equal(fieldEffort({ reasoning: { effort: "low" } }), "low");
  assert.equal(fieldEffort({ thinking: { type: "adaptive" } }), undefined);
  assert.equal(fieldEffort(undefined), undefined);
});

test("what goes as fields is not also written into the prompt", () => {
  const max = { thinking: adaptive, output_config: { effort: "max" } };
  // Claude Code's names are dashed; the list is looked up by Kiro's id.
  const sent = firstTurn(request("claude-fable-5-2", max));
  assert.deepEqual(sent.fields, { thinking: { type: "adaptive" }, output_config: { effort: "max" } });
  assert.equal(sent.text, "Be brief.\n\nHi");

  // Without a model list, or for a model with no fields, the tag says it as before.
  const tag = "<thinking_mode>adaptive</thinking_mode><thinking_effort>max</thinking_effort>\n\nBe brief.\n\nHi";
  assert.deepEqual(firstTurn(request("claude-fable-5-2", max), false), { fields: undefined, text: tag });
  assert.deepEqual(firstTurn(request("claude-sonnet-4-5", max)), { fields: undefined, text: tag });

  // A level Kiro doesn't list stays in the tag, beside the mode it does take.
  const unlisted = firstTurn(request("claude-opus-4-6", { thinking: adaptive, output_config: { effort: "xhigh" } }));
  assert.deepEqual(unlisted.fields, { thinking: { type: "adaptive" } });
  assert.match(unlisted.text, /^<thinking_mode>adaptive<\/thinking_mode><thinking_effort>xhigh<\/thinking_effort>\n\n/);

  // A thinking budget has no field, so its tag stays.
  const budget = firstTurn(request("claude-fable-5-2", { thinking: { type: "enabled", budget_tokens: 8000 } }));
  assert.equal(budget.fields, undefined);
  assert.match(budget.text, /^<thinking_mode>enabled<\/thinking_mode><max_thinking_length>8000<\/max_thinking_length>\n\n/);

  // Nothing asked for, nothing sent.
  assert.deepEqual(firstTurn(request("claude-fable-5-2")), { fields: undefined, text: "Be brief.\n\nHi" });
});

test("CreateResponse carries the fields as one reasoning object", () => {
  const converted = (extra: Partial<MessagesRequest>, model = "claude-fable-5-2") =>
    toCreateResponseRequest(convertRequest(request(model, extra), { modelControls: controls }));
  assert.deepEqual(converted({ thinking: adaptive, output_config: { effort: "max" } }).reasoning, {
    type: "adaptive",
    effort: "max",
  });
  assert.deepEqual(converted({ output_config: { effort: "low" } }).reasoning, { effort: "low" });
  assert.deepEqual(
    converted({ thinking: adaptive, output_config: { effort: "xhigh" } }, "claude-opus-4-6").reasoning,
    { type: "adaptive" },
  );
  assert.equal(Object.hasOwn(converted({}), "reasoning"), false);
});
