import type * as http from "node:http";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export function createJsonPostRequest(body: unknown, url = "/"): http.IncomingMessage {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  req.method = "POST";
  req.url = url;
  req.headers = { host: "127.0.0.1" };
  (req as unknown as PassThrough).end(JSON.stringify(body));
  return req;
}

export function createMockServerResponse(): {
  res: http.ServerResponse;
  done: Promise<void>;
  body: () => string;
} {
  const chunks: string[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((chunk?: unknown) => {
      if (chunk !== undefined) {
        chunks.push(String(chunk));
      }
      resolve();
    }),
  } as unknown as http.ServerResponse;
  return { res, done, body: () => chunks.join("") };
}
