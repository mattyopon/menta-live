import assert from "node:assert/strict";
import { test } from "node:test";
import { recognizeCommand } from "./examMatcher.js";

test("recognizes exam by code letters", () => {
  assert.deepEqual(recognizeCommand("SAA"), {
    kind: "selectExam",
    code: "SAA",
    display: "SAA · Solutions Architect Assoc.",
  });
  assert.equal(recognizeCommand("scs を選んで")?.kind === "selectExam" ? "SCS" : null, "SCS");
});

test("disambiguates SAP (professional) from SAA via longer alias", () => {
  const cmd = recognizeCommand("ソリューションアーキテクトプロフェッショナル");
  assert.equal(cmd?.kind, "selectExam");
  assert.equal((cmd as { code: string }).code, "SAP");
});

test("recognizes exam by Japanese name keyword", () => {
  assert.equal((recognizeCommand("セキュリティ") as { code?: string }).code, "SCS");
  assert.equal((recognizeCommand("ネットワーク") as { code?: string }).code, "ANS");
});

test("recognizes command verbs", () => {
  assert.equal(recognizeCommand("撮影して")?.kind, "capture");
  assert.equal(recognizeCommand("もう一度")?.kind, "repeat");
  assert.equal(recognizeCommand("コストは？")?.kind, "cost");
  assert.equal(recognizeCommand("高精度で")?.kind, "setMode");
  assert.equal(recognizeCommand("ヘルプ")?.kind, "help");
});

test("returns null for arbitrary speech (must not react)", () => {
  assert.equal(recognizeCommand("今日はいい天気ですね"), null);
  assert.equal(recognizeCommand(""), null);
});
