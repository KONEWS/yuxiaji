export type AiringScheduleTimeInput = { weekday: number; airTime: string; now?: Date };

export function getTokyoCalendarParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  const weekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[value("weekday")] || 1;
  return { year: Number(value("year")), month: Number(value("month")), day: Number(value("day")), weekday };
}

export function seasonForMonth(month: number) {
  if (month <= 3) return "winter";
  if (month <= 6) return "spring";
  if (month <= 9) return "summer";
  return "fall";
}

export function japaneseAirTimeOffset(value: string) {
  const match = String(value || "").trim().match(/^(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  return Math.floor(Number(match[1]) / 24);
}

/** Convert Japanese TV notation such as 26:00 to the user-facing 02:00. */
export function normalizeJapaneseAirTime(value: string) {
  const match = String(value || "").trim().match(/^(\d{1,2})(?::(\d{2}))?/);
  if (!match) return "";
  const minutes = Math.min(59, Number(match[2] || 0));
  const hour = Number(match[1]) % 24;
  return `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Convert a Tokyo wall-clock date/time to a UTC timestamp without relying on Node time zones. */
export function tokyoLocalToTimestamp(year: number, month: number, day: number, airTime: string) {
  const normalized = normalizeJapaneseAirTime(airTime);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(":").map(Number);
  const offsetDays = japaneseAirTimeOffset(airTime);
  return Date.UTC(year, month - 1, day + offsetDays, hour, minute) - 9 * 60 * 60 * 1000;
}

export function nextAirAtForSchedule({ weekday, airTime, now = new Date() }: AiringScheduleTimeInput) {
  const normalized = normalizeJapaneseAirTime(airTime);
  if (!normalized || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
  const current = getTokyoCalendarParts(now);
  const effectiveWeekday = ((weekday - 1 + japaneseAirTimeOffset(airTime)) % 7) + 1;
  let days = (effectiveWeekday - current.weekday + 7) % 7;
  // The effective weekday already includes the Japanese late-night offset, so
  // use the normalized wall-clock time here to avoid applying it twice.
  const candidate = tokyoLocalToTimestamp(current.year, current.month, current.day + days, normalized);
  if (candidate === null) return null;
  if (candidate <= now.getTime()) days += 7;
  const timestamp = tokyoLocalToTimestamp(current.year, current.month, current.day + days, normalized);
  return timestamp === null ? null : new Date(timestamp);
}

/** Recalculate a schedule whose stored weekday is the user-facing day. */
export function nextAirAtForStoredSchedule(input: AiringScheduleTimeInput) {
  if (!Number.isInteger(input.weekday) || input.weekday < 1 || input.weekday > 7) return null;
  const offset = japaneseAirTimeOffset(input.airTime);
  const baseWeekday = ((input.weekday - 1 - offset + 7) % 7) + 1;
  return nextAirAtForSchedule({ ...input, weekday: baseWeekday });
}

export function formatAiringCountdown(value: Date | string | number | null, now = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return "等待更新时间";
  const remaining = timestamp - now;
  if (remaining <= 0) return "即将更新";
  const minutes = Math.floor(remaining / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return days ? `${days}天 ${hours}小时后` : hours ? `${hours}小时 ${mins}分后` : `${Math.max(1, mins)}分后`;
}

export function formatWeekday(weekday: number) {
  return ["", "一", "二", "三", "四", "五", "六", "日"][weekday] || "";
}

/** Treat schedules beyond a normal cour as long-running. The provider data
 * does not expose one universal flag, so use the known episode total or the
 * next episode number as stable signals. */
export function isLongRunningSchedule(metadata: Record<string, unknown> | null | undefined, nextEpisode?: number | null) {
  const totalEpisodes = Number(metadata?.totalEpisodes);
  const upcomingEpisode = Number(nextEpisode);
  return (Number.isFinite(totalEpisodes) && totalEpisodes > 24)
    || (Number.isFinite(upcomingEpisode) && upcomingEpisode > 24);
}
