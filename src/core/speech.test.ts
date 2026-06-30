import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendError } from "../vision/visionBackend.js";
import { answerToSpeech, backendErrorToSpeech } from "./speech.js";

test("answerToSpeech reads single and multi-select symbols", () => {
  assert.equal(answerToSpeech("A"), "答えは、A");
  assert.equal(answerToSpeech("A, C"), "答えは、A、C");
});

test("answerToSpeech handles '?' (unsolvable) and empty", () => {
  assert.match(answerToSpeech("?"), /もう一度撮影/);
  assert.match(answerToSpeech("   "), /応答がありません/);
});

test("backendErrorToSpeech maps kinds and http codes", () => {
  assert.match(backendErrorToSpeech(new BackendError("dns", "x")), /見つかりません/);
  assert.match(backendErrorToSpeech(new BackendError("read_timeout", "x")), /タイムアウト/);
  assert.match(backendErrorToSpeech(new BackendError("http", "x", 429)), /混み合って/);
  assert.match(backendErrorToSpeech(new BackendError("http", "x", 503)), /有効になっていません/);
});
