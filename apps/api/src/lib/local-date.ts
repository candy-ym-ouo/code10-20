/**
 * 连续性分析的日期冻结工具。
 *
 * 练习归属的“本地自然日”在练习完成时一次性计算并落库：
 * 此后用户修改时区不会重算任何历史日期（见项目统计口径）。
 */

/** 把绝对时间换算为指定 IANA 时区的本地自然日，返回 YYYY-MM-DD */
export function localDateKey(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** YYYY-MM-DD -> UTC 0 点 Date，用于写入 Prisma 的 @db.Date 字段 */
export function dateKeyToUtcDate(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new RangeError(`非法日期键: ${key}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}
