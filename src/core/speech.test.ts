import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendError } from "../vision/visionBackend.js";
import { answerToSpeech, backendErrorToSpeech, composeAnswerSpeech, fallbackNote } from "./speech.js";

test("answerToSpeech reads single and announces multi-select count", () => {
  assert.equal(answerToSpeech("A"), "答えは、A");
  assert.equal(answerToSpeech("A, C"), "答えは2つ。AとC");
  assert.equal(answerToSpeech("A, C, D"), "答えは3つ。A、C、D");
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

test("fallbackNote flags an opus→haiku downgrade only", () => {
  assert.equal(fallbackNote("opus", "claude-haiku-4-5-20251001"), "ハイクで回答");
  assert.equal(fallbackNote("opus", "claude-opus-4-8"), null); // no downgrade
  assert.equal(fallbackNote("haiku", "claude-haiku-4-5-20251001"), null); // requested haiku
  assert.equal(fallbackNote("sonnet", "unknown-model"), null);
});

test("composeAnswerSpeech appends note on downgrade, skips it for '?'", () => {
  assert.equal(
    composeAnswerSpeech("A", "opus", "claude-haiku-4-5-20251001", true),
    "答えは、A。ハイクで回答",
  );
  assert.equal(composeAnswerSpeech("A", "opus", "claude-opus-4-8", true), "答えは、A");
  assert.equal(composeAnswerSpeech("A", "opus", "claude-haiku-4-5-20251001", false), "答えは、A");
  assert.match(composeAnswerSpeech("?", "opus", "claude-haiku-4-5-20251001", true), /解答できません/);
});
