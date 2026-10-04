import { analyzeContinuity, localDateKey, type ContinuityEvent } from "@practice/contracts";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { isIanaTimezone } from "../lib/validation.js";

export interface ContinuityQuery {
  /** 只纳入 startedAt >= from 的练习；缺省表示全部历史 */
  from?: Date;
  /** 只纳入 startedAt <= to 的练习；缺省表示到当前 */
  to?: Date;
  /** 覆盖用户时区；仅用于未冻结历史数据与 asOf 换算 */
  timezone?: string;
  instrument?: string;
  graceDays?: number;
  breakAfterDays?: number;
}

/**
 * 连续性分析。
 *
 * 数据口径：
 * - 只取 COMPLETED 会话（归档/删除中的不算练习日）。
 * - 本地自然日优先取完成时冻结的 localPracticeDate；历史遗留为空时由纯引擎按
 *   当前 timezone 兜底换算，时区变更永远不重算已冻结的历史日期。
 * - 同一天多条会话（含迟到补录）由纯引擎按 sessionId 去重合并，不重复计数。
 */
export async function getContinuity(userId: string, query: ContinuityQuery) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = query.timezone ?? user.timezone;
  if (!isIanaTimezone(timezone)) throw new AppError(400, "VALIDATION_ERROR", "timezone 不是有效的 IANA 时区");
  if (query.from && query.to && query.from > query.to) {
    throw new AppError(400, "VALIDATION_ERROR", "统计开始时间不能晚于结束时间");
  }

  const sessions = await prisma.practiceSession.findMany({
    where: {
      userId,
      status: "COMPLETED",
      ...(query.instrument ? { instrument: query.instrument } : {}),
      startedAt: {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      },
    },
    select: {
      id: true,
      startedAt: true,
      completedAt: true,
      actualDurationMs: true,
      instrument: true,
      localPracticeDate: true,
    },
    orderBy: { startedAt: "asc" },
  });

  // Prisma 的 @db.Date 以 UTC 0 点 Date 返回，转成 YYYY-MM-DD 即为冻结的本地自然日
  const events: ContinuityEvent[] = sessions.map((session) => ({
    sessionId: session.id,
    startedAt: session.startedAt,
    frozenLocalDate: session.localPracticeDate
      ? session.localPracticeDate.toISOString().slice(0, 10)
      : null,
    actualDurationMs: session.actualDurationMs,
    instrument: session.instrument,
    completedAt: session.completedAt,
  }));

  const analysis = analyzeContinuity(events, {
    timezone,
    graceDays: query.graceDays,
    breakAfterDays: query.breakAfterDays,
  });

  return {
    ...analysis,
    // 口径说明，便于前端与审计直接展示
    scope: {
      from: query.from ?? null,
      to: query.to ?? null,
      instrument: query.instrument ?? null,
      timezoneOverridden: query.timezone !== undefined,
      sessionsConsidered: sessions.length,
    },
    denominatorExplanation:
      "连续天数按练习发生时冻结的本地自然日计算；缺失自然日数 <= graceDays 为休息间隔，达到 breakAfterDays 为中断；中断后再次练习记为恢复。迟到补录按会话去重合并到对应自然日。",
  };
}

/**
 * 仪表盘精简卡片：当前连续状态与最长连续。
 * 独立实现而非从全量结果裁剪，便于未来直接走聚合索引。
 */
export async function getContinuitySummary(userId: string, timezone: string) {
  if (!isIanaTimezone(timezone)) throw new AppError(400, "VALIDATION_ERROR", "timezone 不是有效的 IANA 时区");
  const sessions = await prisma.practiceSession.findMany({
    where: { userId, status: "COMPLETED" },
    select: {
      id: true,
      startedAt: true,
      completedAt: true,
      actualDurationMs: true,
      localPracticeDate: true,
    },
    orderBy: { startedAt: "asc" },
  });
  const events: ContinuityEvent[] = sessions.map((session) => ({
    sessionId: session.id,
    startedAt: session.startedAt,
    frozenLocalDate: session.localPracticeDate ? session.localPracticeDate.toISOString().slice(0, 10) : null,
    actualDurationMs: session.actualDurationMs,
    completedAt: session.completedAt,
  }));
  const analysis = analyzeContinuity(events, { timezone });
  return {
    status: analysis.current.status,
    daysSinceLastPractice: analysis.current.daysSinceLastPractice,
    currentStreakDays: analysis.current.streak?.lengthDays ?? 0,
    longestStreakDays: analysis.longestStreak?.lengthDays ?? 0,
    totalPracticeDays: analysis.totalPracticeDays,
    lastPracticeDate: analysis.lastPracticeDate,
    asOfDate: localDateKey(new Date(), timezone),
  };
}
