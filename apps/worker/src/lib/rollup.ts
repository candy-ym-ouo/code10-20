import { prisma } from "./prisma.js";

/**
 * 删除练习后重算受影响的本地自然日汇总。
 * worker 是独立包，不能引用 api 的服务层，这里复刻同一份“整日重算”口径：
 * 无论删除任务重放多少次，都以该日剩余 COMPLETED 练习为唯一事实来源，不重复计数。
 */
export async function refreshDailyRollupsAfterDelete(
  userId: string,
  localDates: ReadonlyArray<Date | null | undefined>,
): Promise<void> {
  const unique = [...new Set(localDates.filter((value): value is Date => value instanceof Date))];
  for (const practiceLocalDate of unique) {
    const sessions = await prisma.practiceSession.findMany({
      where: { userId, status: "COMPLETED", practiceLocalDate },
      select: { id: true, actualDurationMs: true, _count: { select: { annotations: true } } },
    });

    if (sessions.length === 0) {
      await prisma.dailyPracticeRollup.deleteMany({ where: { userId, practiceLocalDate } });
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
    await prisma.dailyPracticeRollup.upsert({
      where: { userId_practiceLocalDate: { userId, practiceLocalDate } },
      create: {
        userId,
        practiceLocalDate,
        practiceCount: sessions.length,
        totalDurationMs,
        annotationCount,
      },
      update: { practiceCount: sessions.length, totalDurationMs, annotationCount },
    });
  }
}
