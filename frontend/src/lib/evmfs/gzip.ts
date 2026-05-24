/**
 * Browser-native gzip codec wrappers. Uses the standard Compression/
 * DecompressionStream API supported in all evergreen browsers (Chrome 80+,
 * Firefox 113+, Safari 16.4+, Edge 80+).
 */

export async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream is unavailable in this environment");
  }
  const blob = new Blob([new Uint8Array(input)]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

export async function gzip(input: Uint8Array | string): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("CompressionStream is unavailable in this environment");
  }
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const blob = new Blob([new Uint8Array(bytes)]);
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
