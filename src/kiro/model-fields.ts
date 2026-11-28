// A request's thinking mode and reasoning effort, sent to Kiro as request
// fields.
//
// Kiro takes them in additionalModelRequestFields on
// generateAssistantResponse and as `reasoning` on CreateResponse, and
// ListAvailableModels says what each model accepts
// (additionalModelRequestFieldsSchema). Kiro checks a request against that
// schema and answers 400 for a value outside it (xhigh on Opus 4.6, any field
// on Sonnet 4.5), so the adapter sends only what the account's own model list
// names. Seen on 2026-11-28: Fable 5.2 lists thinking type "adaptive" and
// output_config.effort low, medium, high, xhigh and max; with effort sent as
// a field Kiro echoed it back, reasoned longer and metered more at max than
// at low.
//
// What Kiro has no field value for stays in the thinking tag the converter
// writes at the top of the prompt, as before.

import { DEFAULT_EFFORT, type MessagesRequest, type ModelRequestFields } from "./types.ts";

export const MODEL_LIST_TTL_MS = 15 * 60_000;
export const MODEL_LIST_RETRY_MS = 60_000;
export const MODEL_LIST_TIMEOUT_MS = 5_000;
// The list came in one page of 25 models; a longer one is followed this far.
export const MODEL_LIST_MAX_PAGES = 10;

const EFFORT_FIELDS = ["output_config", "reasoning"] as const;

/** What Kiro's schema lets a request say for one model. */
export interface ModelControls {
  thinkingTypes: string[];
  // Claude models take the effort under output_config, as the Messages API
  // does; the other models that have one take it under reasoning.
  effortField?: (typeof EFFORT_FIELDS)[number];
  effortLevels: string[];
}

/** Models by Kiro's id; one Kiro lists no fields for is absent. */
export type ModelCatalog = Map<string, ModelControls>;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// The enum of a property reached through nested `properties`.
function enumAt(schema: unknown, ...path: string[]): string[] {
  let node = record(schema);
  for (const name of path) node = record(record(node?.properties)?.[name]);
  return strings(node?.enum);
}

function modelControls(schema: unknown): ModelControls | undefined {
  const effortField = EFFORT_FIELDS.find((field) => enumAt(schema, field, "effort").length > 0);
  const controls: ModelControls = {
    thinkingTypes: enumAt(schema, "thinking", "type"),
    effortField,
    effortLevels: effortField ? enumAt(schema, effortField, "effort") : [],
  };
  return controls.thinkingTypes.length > 0 || effortField ? controls : undefined;
}

/** Adds one page of ListAvailableModels' `models` to the catalog. */
export function addModels(catalog: ModelCatalog, models: unknown): void {
  if (!Array.isArray(models)) return;
  for (const model of models) {
    const id = record(model)?.modelId;
    const controls = modelControls(record(model)?.additionalModelRequestFieldsSchema);
    if (typeof id === "string" && controls) catalog.set(id, controls);
  }
}

/**
 * The fields that say what the request asked for, as far as Kiro lists them
 * for the model. Undefined when it lists none of it.
 */
export function modelRequestFields(
  req: MessagesRequest,
  controls: ModelControls | undefined,
): ModelRequestFields | undefined {
  if (!controls) return undefined;
  const fields: ModelRequestFields = {};
  const adaptive = req.thinking?.type === "adaptive";
  if (adaptive && controls.thinkingTypes.includes("adaptive"))
    fields.thinking = { type: "adaptive" };
  // Adaptive thinking that names no effort runs at the Messages API's default.
  const effort = req.output_config?.effort || (adaptive ? DEFAULT_EFFORT : undefined);
  if (effort && controls.effortField && controls.effortLevels.includes(effort))
    fields[controls.effortField] = { effort };
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** The effort level a request carries as a field. */
export const fieldEffort = (fields: ModelRequestFields | undefined): string | undefined =>
  fields?.output_config?.effort ?? fields?.reasoning?.effort;
