import { expect, it } from 'vitest';
import { readLines } from './log-stream.ts';

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

it('hands on each whole line, joining a line cut across two chunks', async () => {
  const lines: string[] = [];

  await readLines(stream('{"a":1}\n{"b":', '2}\n', '{"c":3}\n'), (line) => lines.push(line));

  expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
});

it('keeps back a last line with no end, because the server only sends whole ones', async () => {
  const lines: string[] = [];

  await readLines(stream('{"a":1}\n{"b"'), (line) => lines.push(line));

  expect(lines).toEqual(['{"a":1}']);
});
