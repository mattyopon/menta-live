import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import { HttpVisionBackend } from "./httpVisionBackend.js";
import { BackendError } from "./visionBackend.js";

let server: Server;
let baseUrl: string;
let lastRequest: { fields: Record<string, string>; hasImage: boolean } | null = null;
let handler: (req: { fields: Record<string, string> }) => { status: number; body: string };

beforeEach(async () => {
  lastRequest = null;
  handler = () => ({
    status: 200,
    body: JSON.stringify({ request_id: "echo", text: "A", elapsed_ms: 12, model: "claude-haiku-4-5" }),
  });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("latin1");
      // 超簡易 multipart パーサ: name="x"\r\n\r\nvalue を拾う (テスト用途)
      const fields: Record<string, string> = {};
      const re = /name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        if (m[1] && m[1] !== "image") fields[m[1]] = m[2] ?? "";
      }
      lastRequest = { fields, hasImage: raw.includes('name="image"') };
      const out = handler({ fields });
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test("infer posts multipart fields and parses the JSON response", async () => {
  const be = new HttpVisionBackend({ baseUrl });
  const res = await be.infer({
    requestId: "rid-1",
    imageJpeg: new Uint8Array([0xff, 0xd8, 0xff]),
    prompt: "PROMPT",
    mode: "opus",
    authMode: "api_key",
  });
  assert.equal(res.text, "A");
  assert.equal(res.elapsedMs, 12);
  assert.equal(res.model, "claude-haiku-4-5");
  assert.equal(lastRequest?.fields.request_id, "rid-1");
  assert.equal(lastRequest?.fields.prompt, "PROMPT");
  assert.equal(lastRequest?.fields.mode, "opus");
  assert.equal(lastRequest?.fields.auth_mode, "api_key");
  assert.equal(lastRequest?.hasImage, true);
});

test("non-2xx maps to BackendError(http, code)", async () => {
  handler = () => ({ status: 429, body: "rate" });
  const be = new HttpVisionBackend({ baseUrl });
  await assert.rejects(
    () =>
      be.infer({
        requestId: "rid-2",
        imageJpeg: new Uint8Array([1]),
        prompt: "p",
        mode: "haiku",
        authMode: "api_key",
      }),
    (err: unknown) => err instanceof BackendError && err.kind === "http" && err.httpCode === 429,
  );
});

test("malformed JSON maps to BackendError(parse)", async () => {
  handler = () => ({ status: 200, body: "not json" });
  const be = new HttpVisionBackend({ baseUrl });
  await assert.rejects(
    () =>
      be.infer({
        requestId: "rid-3",
        imageJpeg: new Uint8Array([1]),
        prompt: "p",
        mode: "haiku",
        authMode: "api_key",
      }),
    (err: unknown) => err instanceof BackendError && err.kind === "parse",
  );
});

test("health returns true on {status:ok}", async () => {
  handler = () => ({ status: 200, body: JSON.stringify({ status: "ok" }) });
  const be = new HttpVisionBackend({ baseUrl });
  assert.equal(await be.health(), true);
});
