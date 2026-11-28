function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= data[index];
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

function stringHeader(name: string, value: string): Buffer {
  const nameBytes = Buffer.from(name);
  const valueBytes = Buffer.from(value);
  const header = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  header.writeUInt8(nameBytes.length, offset++);
  nameBytes.copy(header, offset);
  offset += nameBytes.length;
  header.writeUInt8(0x07, offset++);
  header.writeUInt16BE(valueBytes.length, offset);
  offset += 2;
  valueBytes.copy(header, offset);
  return header;
}

export function eventFrame(
  payload: unknown,
  headers: Array<{ name: string; value: string }> = [],
): Buffer {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(JSON.stringify(payload));
  const headerBuffer = Buffer.concat(
    headers.map((header) => stringHeader(header.name, header.value)),
  );
  const message = Buffer.alloc(12 + headerBuffer.length + body.length + 4);
  message.writeUInt32BE(message.length, 0);
  message.writeUInt32BE(headerBuffer.length, 4);
  message.writeUInt32BE(crc32(message.subarray(0, 8)), 8);
  headerBuffer.copy(message, 12);
  body.copy(message, 12 + headerBuffer.length);
  message.writeUInt32BE(
    crc32(message.subarray(0, message.length - 4)),
    message.length - 4,
  );
  return message;
}

// Entries of Kiro's ListAvailableModels as an Enterprise account got them on
// 2026-11-28, cut down to what the adapter reads.
const effortSchema = (thinkingTypes: string[], levels: string[]) => ({
  type: "object",
  properties: {
    thinking: {
      type: "object",
      properties: {
        type: { type: "string", enum: thinkingTypes },
        display: { type: "string", enum: ["summarized", "omitted"] },
      },
      required: ["type"],
    },
    output_config: {
      type: "object",
      properties: { effort: { type: "string", enum: levels, default: "high" } },
    },
    max_tokens: { type: "integer", minimum: 1024, maximum: 64000 },
  },
  additionalProperties: false,
});
export const kiroModelList = {
  defaultModel: { modelId: "auto" },
  models: [
    { modelId: "auto", modelName: "Auto" },
    {
      modelId: "claude-fable-5.2",
      additionalModelRequestFieldsSchema: effortSchema(["adaptive"], ["low", "medium", "high", "xhigh", "max"]),
    },
    {
      modelId: "claude-opus-5.5",
      additionalModelRequestFieldsSchema: effortSchema(["adaptive"], ["low", "medium", "high", "xhigh", "max"]),
    },
    {
      modelId: "claude-opus-4.6",
      additionalModelRequestFieldsSchema: effortSchema(["adaptive", "disabled"], ["low", "medium", "high", "max"]),
    },
    { modelId: "claude-sonnet-4.5" },
    {
      modelId: "gpt-5.6-sol",
      additionalModelRequestFieldsSchema: {
        type: "object",
        properties: {
          reasoning: {
            type: "object",
            properties: { effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] } },
          },
        },
        additionalProperties: false,
      },
    },
  ],
  nextToken: null,
};

export function reasoningFrame(payload: { text?: string; signature?: string; redactedContent?: string }): Buffer {
  return eventFrame(payload, [
    { name: ":event-type", value: "reasoningContentEvent" },
  ]);
}

export function meteringFrame(credits = 0.25): Buffer {
  return eventFrame({ usage: credits }, [
    { name: ":event-type", value: "meteringEvent" },
  ]);
}

export function successfulKiroStream(
  text = "Hello from Kiro",
  credits = 0.25,
): Buffer {
  return Buffer.concat([
    eventFrame({ content: text }),
    eventFrame({ contextUsagePercentage: 1 }),
    eventFrame({ usage: credits }, [
      { name: ":event-type", value: "meteringEvent" },
    ]),
  ]);
}

// Claude Code's background-agent label prompt. The fixed lines are
// byte-identical from 2.1.232 to 2.1.322; `previous` is the optional
// "Previous:" line in the form each release wrote it, or "".
export function claudeCodeLabelPrompt(subject = "your", doNotUseTools = " Do not use tools.", previous = ""): string {
  return (
    `Describe ${subject} most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch.${doNotUseTools}\n` +
    (previous ? `\n${previous}\n` : "") +
    '\nGood: "Reading runAgent.ts"\nGood: "Fixing null check in validate.ts"\nGood: "Running auth module tests"\nGood: "Adding retry logic to fetchUser"\n\n' +
    'Bad (past tense): "Analyzed the branch diff"\nBad (too vague): "Investigating the issue"\nBad (too long): "Reviewing full branch diff and AgentTool.tsx integration"\nBad (branch name): "Analyzed adam/background-summary branch diff"'
  );
}
