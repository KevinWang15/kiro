// Filters over request logs: a list of tokens, each a field, an operator and
// values, all of which must hold. The dashboard's filter bar writes them, and
// the page URL and the API carry each one as `field:operator:value,value`
// (a comma or percent sign inside a value is percent-encoded).

export type FilterOperator =
  | "is"
  | "in"
  | "not"
  | "notIn"
  | "exists"
  | "missing"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export interface FilterToken {
  field: string;
  operator: FilterOperator;
  values: string[];
}

export interface UsageField {
  name: string;
  title: string;
  // text and integer fields hold values requests can be grouped by and picked
  // from; number fields are compared with a typed number.
  kind: "text" | "integer" | "number";
  // SQL over request_logs. Written here, never taken from a request.
  expression: string;
  nullable?: boolean;
  // The only values a text field can hold.
  choices?: string[];
  unit?: string;
}

const TOTAL_TOKENS =
  "(inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens)";

export const USAGE_FIELDS: UsageField[] = [
  { name: "model", title: "Model", kind: "text", expression: "model" },
  { name: "account", title: "Account", kind: "integer", expression: "accountId", nullable: true },
  {
    name: "outcome",
    title: "Outcome",
    kind: "text",
    expression: "CASE WHEN success = 1 THEN 'success' ELSE 'failed' END",
    choices: ["success", "failed"],
  },
  { name: "status", title: "Status code", kind: "integer", expression: "statusCode", nullable: true },
  { name: "cost", title: "Cost", kind: "number", expression: "costUsd", unit: "USD" },
  { name: "totalTokens", title: "Total tokens", kind: "number", expression: TOTAL_TOKENS, unit: "tokens" },
  { name: "inputTokens", title: "Input tokens", kind: "number", expression: "inputTokens", unit: "tokens" },
  { name: "outputTokens", title: "Output tokens", kind: "number", expression: "outputTokens", unit: "tokens" },
  { name: "cacheReadTokens", title: "Cache read tokens", kind: "number", expression: "cacheReadInputTokens", unit: "tokens" },
  { name: "cacheWriteTokens", title: "Cache write tokens", kind: "number", expression: "cacheCreationInputTokens", unit: "tokens" },
  { name: "latency", title: "Latency", kind: "number", expression: "latencyMs", unit: "ms", nullable: true },
  { name: "ttft", title: "Time to first token", kind: "number", expression: "ttftMs", unit: "ms", nullable: true },
  { name: "credits", title: "Kiro credits", kind: "number", expression: "kiroCredits", unit: "credits" },
];

const COMPARISONS = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
const MAX_TOKENS = 20;
const MAX_VALUES = 100;

export const usageField = (name: string): UsageField | undefined =>
  USAGE_FIELDS.find((field) => field.name === name);

// A field requests can be grouped by, and whose values the filter bar lists.
export const isDimension = (field: UsageField): boolean => field.kind !== "number";

export function fieldOperators(field: UsageField): FilterOperator[] {
  const operators: FilterOperator[] =
    field.kind === "number"
      ? ["is", "not", "gt", "gte", "lt", "lte"]
      : ["is", "in", "not", "notIn"];
  return field.nullable ? [...operators, "exists", "missing"] : operators;
}

// A filter the request got wrong; the route answers 400 with the message.
export class FilterError extends Error {}

function decodeValue(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new FilterError(`Filter value "${text}" is not valid`);
  }
}

function parseToken(text: string): FilterToken {
  const [name = "", operator = "", ...rest] = text.split(":");
  const field = usageField(name);
  if (!field) throw new FilterError(`Unknown filter field "${name}"`);
  if (!fieldOperators(field).includes(operator as FilterOperator))
    throw new FilterError(`"${operator}" is not a condition of ${field.title}`);
  const list = rest.join(":");
  const values = list === "" ? [] : list.split(",").map(decodeValue);
  const takesNone = operator === "exists" || operator === "missing";
  const takesMany = operator === "in" || operator === "notIn";
  if (takesNone ? values.length > 0 : takesMany ? values.length < 1 : values.length !== 1)
    throw new FilterError(
      `${field.title} ${operator} takes ${takesNone ? "no value" : takesMany ? "at least one value" : "one value"}`,
    );
  if (values.length > MAX_VALUES)
    throw new FilterError(`A filter takes at most ${MAX_VALUES} values`);
  for (const value of values) {
    const valid =
      field.kind === "integer"
        ? /^-?\d{1,15}$/.test(value)
        : field.kind === "number"
          ? value.trim() !== "" && Number.isFinite(Number(value))
          : field.choices
            ? field.choices.includes(value)
            : value !== "";
    if (!valid) throw new FilterError(`"${value}" is not a value of ${field.title}`);
  }
  return { field: field.name, operator: operator as FilterOperator, values };
}

// The `f` query parameter, given once or several times.
export function parseFilters(input: unknown): FilterToken[] {
  if (input === undefined || input === null || input === "") return [];
  const items = Array.isArray(input) ? input : [input];
  if (items.length > MAX_TOKENS)
    throw new FilterError(`At most ${MAX_TOKENS} filters can be combined`);
  return items.map((item) => {
    if (typeof item !== "string") throw new FilterError("A filter must be text");
    return parseToken(item);
  });
}

export interface SqlFilter {
  // A condition for a WHERE clause; "1" when nothing is filtered.
  where: string;
  params: Array<string | number>;
}

export const NO_FILTER: SqlFilter = { where: "1", params: [] };

export function compileFilters(tokens: FilterToken[]): SqlFilter {
  if (tokens.length === 0) return NO_FILTER;
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  for (const token of tokens) {
    const field = usageField(token.field);
    if (!field) throw new FilterError(`Unknown filter field "${token.field}"`);
    const expression = field.expression;
    const values = token.values.map((value) =>
      field.kind === "text" ? value : Number(value),
    );
    const marks = values.map(() => "?").join(", ");
    switch (token.operator) {
      case "is":
      case "in":
        conditions.push(`${expression} IN (${marks})`);
        break;
      // A request without the value is not one of the excluded values.
      case "not":
      case "notIn":
        conditions.push(`(${expression} IS NULL OR ${expression} NOT IN (${marks}))`);
        break;
      case "exists":
        conditions.push(`${expression} IS NOT NULL`);
        break;
      case "missing":
        conditions.push(`${expression} IS NULL`);
        break;
      default:
        conditions.push(`${expression} ${COMPARISONS[token.operator]} ?`);
    }
    params.push(...values);
  }
  return { where: conditions.join(" AND "), params };
}

// What the dashboard needs to offer the fields: nothing about their SQL.
export function fieldSchema() {
  return USAGE_FIELDS.map((field) => ({
    name: field.name,
    title: field.title,
    kind: field.kind,
    operators: fieldOperators(field),
    dimension: isDimension(field),
    ...(field.choices ? { choices: field.choices } : {}),
    ...(field.unit ? { unit: field.unit } : {}),
  }));
}
