// Reads a stream of lines, such as the log route's JSON lines, and hands on each whole one.
export async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    carry += decoder.decode(value, { stream: true });
    for (let at = carry.indexOf('\n'); at !== -1; at = carry.indexOf('\n')) {
      const line = carry.slice(0, at);
      carry = carry.slice(at + 1);
      onLine(line);
    }
  }
}
