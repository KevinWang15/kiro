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
