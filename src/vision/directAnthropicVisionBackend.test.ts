import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectAnthropicVisionBackend } from "./directAnthropicVisionBackend.js";
import { BackendError } from "./visionBackend.js";

const REQ = {
  requestId: "r1",
  imageJpeg: new Uint8Array([0xff, 0xd8, 0xff]),
  prompt: "p",
  mode: "haiku" as const,
  authMode: "api_key" as const,
};

/** internal Anthropic client を差し替えるヘルパ (private を test 用に上書き)。 */
function withStubClient(be: DirectAnthropicVisionBackend, create: () => Promise<unknown>): void {
  (be as unknown as { client: unknown }).client = { messages: { create } };
}

test("caller abort (APIUserAbortError) surfaces as a silent AbortError, not a spoken backend error", async () => {
  const be = new DirectAnthropicVisionBackend({ apiKey: "x" });
  withStubClient(be, () => Promise.reject(new Anthropic.APIUserAbortError()));
  await assert.rejects(
    () => be.infer({ ...REQ, requestId: "abort-1" }),
    (e: unknown) => e instanceof Error && e.name === "AbortError" && !(e instanceof BackendError),
  );
});

test("a real API error maps to BackendError(http, status)", async () => {
  const be = new DirectAnthropicVisionBackend({ apiKey: "x" });
  const apiErr = new Anthropic.BadRequestError(400, { type: "error" }, "bad", new Headers());
  withStubClient(be, () => Promise.reject(apiErr));
  await assert.rejects(
    () => be.infer({ ...REQ, requestId: "http-1" }),
    (e: unknown) => e instanceof BackendError && e.kind === "http" && e.httpCode === 400,
  );
});

test("happy path extracts the trailing text block and tallies usage", async () => {
  const be = new DirectAnthropicVisionBackend({ apiKey: "x" });
  withStubClient(be, () =>
    Promise.resolve({
      content: [{ type: "text", text: "A" }],
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  );
  const res = await be.infer({ ...REQ, requestId: "ok-1" });
  assert.equal(res.text, "A");
  assert.equal(res.model, "claude-haiku-4-5");
  const usage = await be.getUsageSession();
  assert.equal(usage.breakdown["claude-haiku-4-5"]?.calls, 1);
});

test("dedup: same request_id returns the cached result without a second call", async () => {
  const be = new DirectAnthropicVisionBackend({ apiKey: "x" });
  let calls = 0;
  withStubClient(be, () => {
    calls += 1;
    return Promise.resolve({
      content: [{ type: "text", text: "B" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  await be.infer({ ...REQ, requestId: "dup" });
  await be.infer({ ...REQ, requestId: "dup" });
  assert.equal(calls, 1, "second call with same request_id must hit the dedup cache");
});
