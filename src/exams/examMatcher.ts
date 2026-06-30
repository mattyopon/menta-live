/**
 * 音声コマンド認識 — 表示なし機では MenuActivity (視覚メニュー) を音声で置換する。
 *
 * 文字起こしテキスト (日本語/英語まじり) を受け取り、Command に写像する。
 * ASR の癖に強く依存するため、ここが本アプリ最大のチューニングポイント。
 * 別言語/別 ASR に載せ替える際は alias を足すだけで拡張できるよう純関数に隔離した。
 */

import { EXAMS } from "./examPrompts.js";

export type Command =
  | { readonly kind: "selectExam"; readonly code: string; readonly display: string }
  | { readonly kind: "capture" } // 撮影トリガ (通常はボタンだが音声でも可)
  | { readonly kind: "repeat" } // 直前の解答をもう一度読み上げ
  | { readonly kind: "cost" } // セッションコストを読み上げ
  | { readonly kind: "toggleMode" } // 高精度 ⇔ 節約 を切替
  | { readonly kind: "setMode"; readonly profile: "high" | "save" } // 明示指定
  | { readonly kind: "listExams" } // 試験一覧を読み上げ
  | { readonly kind: "help" } // 使い方を読み上げ
  | { readonly kind: "diagnostics" } // 音声/デバイスのセルフテスト
  | { readonly kind: "stop" }; // 待機/終了

/** NFKC 正規化 + 小文字化 + 記号/空白除去。全角英数や半角カナを吸収する。 */
function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　・,.\-、。!！?？「」『』]/g, "");
}

/** A→エー など、コードを 1 文字ずつ読んだカナ列を作る (例 "SAA" → "エスエーエー")。 */
const LETTER_KANA: Readonly<Record<string, string>> = {
  a: "エー", b: "ビー", c: "シー", d: "ディー", e: "イー", f: "エフ", g: "ジー",
  h: "エイチ", i: "アイ", j: "ジェー", k: "ケー", l: "エル", m: "エム", n: "エヌ",
  o: "オー", p: "ピー", q: "キュー", r: "アール", s: "エス", t: "ティー", u: "ユー",
  v: "ブイ", w: "ダブリュー", x: "エックス", y: "ワイ", z: "ゼット",
};

function spellCodeKana(code: string): string {
  return normalize(
    [...code.toLowerCase()].map((ch) => LETTER_KANA[ch] ?? ch).join(""),
  );
}

/** 試験ごとの名称エイリアス (正規化前の素の文字列で記述、内部で normalize する)。 */
const NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  CLF: ["クラウドプラクティショナー", "プラクティショナー", "クラウドプラクティ", "cloudpractitioner"],
  AIF: ["aiプラクティショナー", "エーアイプラクティショナー", "aipractitioner"],
  SAA: ["ソリューションアーキテクトアソシエイト", "アーキテクトアソシエイト", "solutionsarchitectassociate"],
  MLA: ["mlエンジニア", "エムエルエンジニア", "機械学習エンジニア", "mlengineer"],
  SOA: ["クラウドオプス", "シスオプス", "sysops", "cloudops"],
  DEA: ["データエンジニア", "dataengineer"],
  DVA: ["デベロッパーアソシエイト", "デベロッパー", "開発者", "developerassociate"],
  SAP: ["ソリューションアーキテクトプロフェッショナル", "アーキテクトプロフェッショナル", "アーキテクトプロ", "saプロ"],
  AIP: ["生成aiデベロッパー", "ジェネレーティブai", "生成ai", "genai", "generativeai"],
  DOP: ["デブオプス", "devops", "デボップス"],
  MLS: ["mlスペシャリティ", "機械学習スペシャリティ", "エムエルスペシャリティ", "mlspecialty"],
  SCS: ["セキュリティスペシャリティ", "セキュリティ", "security"],
  ANS: ["アドバンストネットワーキング", "ネットワーキング", "ネットワーク", "advancednetworking", "networking"],
};

interface Alias {
  readonly code: string;
  readonly needle: string;
}

/** (code, 正規化済みエイリアス) を長い順に並べた検索表。長い一致を優先して誤爆を減らす。 */
const EXAM_ALIASES: readonly Alias[] = buildAliasTable();

function buildAliasTable(): Alias[] {
  const out: Alias[] = [];
  for (const { code } of EXAMS) {
    const cands = new Set<string>();
    cands.add(normalize(code)); // "saa"
    cands.add(spellCodeKana(code)); // "エスエーエー"
    for (const a of NAME_ALIASES[code] ?? []) cands.add(normalize(a));
    for (const needle of cands) {
      if (needle) out.push({ code, needle });
    }
  }
  // 長い needle を先に試す (例 SAP の "...プロフェッショナル" を SAA の "...アーキテクト" より優先)
  out.sort((a, b) => b.needle.length - a.needle.length);
  return out;
}

const DISPLAY_OF: Readonly<Record<string, string>> = Object.fromEntries(
  EXAMS.map((e) => [e.code, e.display]),
);

/**
 * 文字起こし 1 発話を Command へ。認識できなければ null。
 * コマンド動詞 → 試験選択 の順で評価する。
 */
export function recognizeCommand(text: string): Command | null {
  const raw = text;
  const n = normalize(text);
  if (!n) return null;

  // --- コマンド動詞 ---
  if (/撮影|撮って|とって|解いて|シャッター|こたえて|答えて/.test(raw)) {
    return { kind: "capture" };
  }
  if (/もう一度|もういちど|リピート|繰り返|くりかえ/.test(raw) || /repeat/.test(n)) {
    return { kind: "repeat" };
  }
  if (/コスト|料金|費用|いくら/.test(raw) || /cost/.test(n)) {
    return { kind: "cost" };
  }
  if (/高精度|精度|オーパス/.test(raw) || /opus/.test(n)) {
    return { kind: "setMode", profile: "high" };
  }
  if (/節約|セーブ|ハイク/.test(raw) || /haiku|save/.test(n)) {
    return { kind: "setMode", profile: "save" };
  }
  if (/モード切替|モード切り替え|モードきりかえ|切り替え|きりかえ/.test(raw)) {
    return { kind: "toggleMode" };
  }
  if (/一覧|リスト|どんな試験|試験を教え/.test(raw) || /list/.test(n)) {
    return { kind: "listExams" };
  }
  if (/診断|セルフテスト|動作確認/.test(raw) || /diagnos|selftest/.test(n)) {
    return { kind: "diagnostics" };
  }
  if (/ヘルプ|使い方|つかいかた/.test(raw) || /help/.test(n)) {
    return { kind: "help" };
  }
  if (/終了|やめ|ストップ|待機/.test(raw) || /stop|quit/.test(n)) {
    return { kind: "stop" };
  }

  // --- 試験選択 (長い一致を優先) ---
  for (const { code, needle } of EXAM_ALIASES) {
    // 2 文字以下の needle (理論上は無いが保険) は単独語境界を要求せず includes で十分
    if (n.includes(needle)) {
      return { kind: "selectExam", code, display: DISPLAY_OF[code] ?? code };
    }
  }
  return null;
}

/** help / listExams の読み上げ素材。 */
export function examListSpeech(): string {
  const names = EXAMS.map((e) => e.display.split("·")[1]?.trim() ?? e.code);
  return `対応試験は、${names.join("、")} です。試験コードか名前を言ってください。`;
}
