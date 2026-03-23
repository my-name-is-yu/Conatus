import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

/** Perform an HTTP/HTTPS POST with a JSON body. Returns the response status code. */
export function httpPost(
  urlStr: string,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(new Error(`Invalid URL: ${urlStr}`));
      return;
    }

    const payload = JSON.stringify(body);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port
        ? parseInt(parsed.port, 10)
        : isHttps
          ? 443
          : 80,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...extraHeaders,
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer | string) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body: data });
      });
    });

    req.on("error", (err: Error) => reject(err));
    req.setTimeout(10_000, () => {
      req.destroy(new Error("HTTP request timeout"));
    });

    req.write(payload);
    req.end();
  });
}
