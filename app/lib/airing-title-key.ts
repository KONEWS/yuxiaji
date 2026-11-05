// Broadcast-calendar merge keys.
//
// Different providers write the same season in different ways:
//   2nd Season / Season 2 / 第2期 / 第2季 / 第二季
// The old key only stripped spaces and punctuation, so those forms never
// matched and the same show stayed as two separate calendar rows. This
// module canonicalises the season marker to `season<N>` while keeping the
// base title and the season number, so Season 1 and Season 2 still never
// merge into each other.
const CHINESE_DIGITS: Record<string, number> = {
  "零": 0,
  "一": 1,
  "二": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
};

function chineseNumeralValue(text: string): number | null {
  if (!text) return null;
  if (text === "十") return 10;
  const tenIndex = text.indexOf("十");
  if (tenIndex >= 0) {
    const tensText = text.slice(0, tenIndex);
    const onesText = text.slice(tenIndex + 1);
    const tens = tensText ? CHINESE_DIGITS[tensText] : 1;
    const ones = onesText ? CHINESE_DIGITS[onesText] : 0;
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }
  if (text.length === 1) {
    const value = CHINESE_DIGITS[text];
    return value === undefined ? null : value;
  }
  return null;
}

function normalizeSeasonSuffix(stripped: string): string {
  let key = stripped;
  // Chinese numerals: 第二季 / 第十一期 -> season2 / season11.
  key = key.replace(/第([一二三四五六七八九十零]+)(期|季)/g, (_match, numerals: string) => {
    const value = chineseNumeralValue(numerals);
    return value === null ? _match : `season${value}`;
  });
  // Arabic numerals: 第2期 / 第2季 -> season2.
  key = key.replace(/第(\d+)(期|季)/g, "season$1");
  // Bare numerals: 2期 / 2季 -> season2.
  key = key.replace(/(\d+)(期|季)/g, "season$1");
  // Ordinals: 2ndseason / 3rdseason -> season2 / season3.
  key = key.replace(/(\d+)(?:st|nd|rd|th)season/g, "season$1");
  return key;
}

export function airingTitleKey(value: string): string {
  if (!value) return "";
  const stripped = value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  return normalizeSeasonSuffix(stripped);
}
