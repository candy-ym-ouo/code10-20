import { Prisma, type PrismaClient } from "@prisma/client";
import {
  analyzeContinuity,
  groupEventsByDay,
  localDateKey,
  type ContinuityReport,
  type PracticeDay,
  type PracticeEvent,
} from "@practice/contracts";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { isIanaTimezone } from "../lib/validation.js";

export interface ContinuityQuery {
  from?: Date;
  to?: Date;
  timezone: string;
  instrument?: string;
  breakThresholdDays: number;
  graceDays: number;
}

type TransactionClient = Prisma.TransactionClient | PrismaClient;

/** 本地自然日（YYYY-MM-DD）-> Postgres DATE 列使用的 UTC 午夜时刻。 */
export function localDateToColumn(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** Postgres DATE 列 -> YYYY-MM-DD（驱动按 UTC 午夜返回，直接截取即可）。 */
export function columnToLocalDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * 在练习“完成时刻”冻结其本地自然日与时区。
 * 以练习开始时间（而非复盘完成时间）归属自然日：晚上 23:50 开始的练习算当天。
 * 冻结后用户修改时区不会改动这两列，历史连续性不重算。
 */
export function freezePracticeLocalDate(
  startedAt: Date,
  timezone: string,
): { practiceLocalDate: Date; practiceLocalTimezone: string } {
  return {
    practiceLocalDate: localDateToColumn(localDateKey(startedAt, timezone)),
    practiceLocalTimezone: timezone,
  };
}

/**
 * 从源表整体重算若干个本地自然日的汇总，并幂等写回。
 * 迟到上传、跨日修正、归档、恢复、删除都只需要对受影响日期调用本函数：
 * 每次都以 COMPLETED 练习全量重算该日，重复执行不会重复计数。
 */
export async function refreshDailyRollups(
  tx: TransactionClient,
  userId: string,
  dates: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const uniqueDates = [...new Set(dates)].filter((value): value is string => Boolean(value));
  for (const date of uniqueDates) {
    const column = localDateToColumn(date);
    const sessions = await tx.practiceSession.findMany({
      where: { userId, status: "COMPLETED", practiceLocalDate: column },
      select: {
        id: true,
        actualDurationMs: true,
        _count: { select: { annotations: true } },
      },
    });

    if (sessions.length === 0) {
      await tx.dailyPracticeRollup.deleteMany({
        where: { userId, practiceLocalDate: column },
      });
      continue;
    }

    const totalDurationMs = sessions.reduce<bigint>(
      (sum, session) => sum + session.actualDurationMs,
      0n,
    );
    const annotationCount = sessions.reduce(
      (sum, session) => sum + session._count.annotations,
      0,
    );

    await tx.dailyPracticeRollup.upsert({
      where: { userId_practiceLocalDate: { userId, practiceLocalDate: column } },
      create: {
        userId,
        practiceLocalDate: column,
        practiceCount: sessions.length,
        totalDurationMs,
        annotationCount,
      },
      update: {
        practiceCount: sessions.length,
        totalDurationMs,
        annotationCount,
      },
    });
  }
}

interface ContinuitySessionRow {
  id: string;
  startedAt: Date;
  actualDurationMs: bigint;
  practiceLocalDate: Date | null;
  practiceLocalTimezone: string | null;
  instrument: string;
  _count: { annotations: number };
}

function toPracticeEvent(row: ContinuitySessionRow, fallbackTimezone: string): PracticeEvent {
  return {
    sessionId: row.id,
    startedAt: row.startedAt,
    // 冻结日期优先（不随当前时区重算）；仅迁移前的理论遗留行走回退。
    localDate: row.practiceLocalDate ? columnToLocalDate(row.practiceLocalDate) : undefined,
    localTimezone: row.practiceLocalTimezone ?? fallbackTimezone,
    actualDurationMs: row.actualDurationMs,
    annotationCount: row._count.annotations,
    instrument: row.instrument,
  };
}

/**
 * 连续性分析主读路径。
 * - 默认从 daily_practice_rollups 读（O(天数)，已是去重后的权威日汇总）；
 * - 指定乐器时日汇总无该维度，改从练习源表取事件，交给纯引擎按日幂等合并。
 */
export async function getContinuity(
  userId: string,
  query: ContinuityQuery,
): Promise<ContinuityReport & { timezone: string; generatedAt: Date }> {
  if (!isIanaTimezone(query.timezone)) {
    throw new AppError(400, "VALIDATION_ERROR", "timezone 不是有效的 IANA 时区");
  }
  if (query.from && query.to && query.from > query.to) {
    throw new AppError(400, "VALIDATION_ERROR", "统计开始时间不能晚于结束时间");
  }

  // 区间绝对端点换算成“本地自然日”端点；连续性只与本地日期比较，不重算历史。
  const fromLocal = query.from ? localDateKey(query.from, query.timezone) : undefined;
  const toLocal = query.to ? localDateKey(query.to, query.timezone) : undefined;
  const today = localDateKey(new Date(), query.timezone);

  const dateWhere = {
    ...(fromLocal ? { gte: localDateToColumn(fromLocal) } : {}),
    ...(toLocal ? { lte: localDateToColumn(toLocal) } : {}),
  };

  let days: Map<string, PracticeDay>;

  if (query.instrument) {
    const sessions = await prisma.practiceSession.findMany({
      where: {
        userId,
        status: "COMPLETED",
        instrument: query.instrument,
        ...(fromLocal || toLocal ? { practiceLocalDate: dateWhere } : {}),
      },
      select: {
        id: true,
        startedAt: true,
        actualDurationMs: true,
        practiceLocalDate: true,
        practiceLocalTimezone: true,
        instrument: true,
        _count: { select: { annotations: true } },
      },
      orderBy: { practiceLocalDate: "asc" },
    });
    days = groupEventsByDay(
      sessions.map((row) => toPracticeEvent(row, query.timezone)),
      query.timezone,
    );
  } else {
    const rows = await prisma.dailyPracticeRollup.findMany({
      where: {
        userId,
        ...(fromLocal || toLocal ? { practiceLocalDate: dateWhere } : {}),
      },
      orderBy: { practiceLocalDate: "asc" },
    });
    // 日汇总已是权威去重结果；sessionIds 对分析非必需，留空数组。
    days = new Map(
      rows.map((row) => {
        const date = columnToLocalDate(row.practiceLocalDate);
        return [
          date,
          {
            date,
            practiceCount: row.practiceCount,
            sessionIds: [],
            totalDurationMs: Number(row.totalDurationMs),
            totalAnnotationCount: row.annotationCount,
          },
        ];
      }),
    );
  }

  const report = analyzeContinuity(days, {
    today,
    breakThresholdDays: query.breakThresholdDays,
    graceDays: query.graceDays,
  });

  return { ...report, timezone: query.timezone, generatedAt: new Date() };
}
