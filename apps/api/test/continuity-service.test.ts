import { beforeEach, describe, expect, it, vi } from "vitest";

// 用内存假数据替换 Prisma 单例，专注验证服务的“冻结日期 + 引擎装配”口径。
const rollups: Array<{
  userId: string;
  practiceLocalDate: Date;
  practiceCount: number;
  totalDurationMs: bigint;
  annotationCount: number;
}> = [];
const sessions: Array<{
  id: string;
  userId: string;
  status: string;
  instrument: string;
  startedAt: Date;
  actualDurationMs: bigint;
  practiceLocalDate: Date | null;
  practiceLocalTimezone: string | null;
  annotationCount: number;
}> = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    dailyPracticeRollup: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        rollups.filter((row) => row.userId === where.userId),
      ),
    },
    practiceSession: {
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; instrument?: string } }) =>
          sessions
            .filter(
              (row) =>
                row.userId === where.userId &&
                row.status === "COMPLETED" &&
                (!where.instrument || row.instrument === where.instrument),
            )
            .map((row) => ({ ...row, _count: { annotations: row.annotationCount } })),
      ),
    },
  },
}));

import {
  columnToLocalDate,
  freezePracticeLocalDate,
  getContinuity,
  localDateToColumn,
} from "../src/services/continuity-service.js";

const USER = "11111111-1111-1111-1111-111111111111";

describe("local date column helpers", () => {
  it("round-trips YYYY-MM-DD through the DATE column", () => {
    const column = localDateToColumn("2026-10-04");
    expect(column.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(columnToLocalDate(column)).toBe("2026-10-04");
  });

  it("freezes a late-night Shanghai practice onto its local day", () => {
    // 22:30 UTC = 次日 06:30 上海 -> 归到 10-04
    const frozen = freezePracticeLocalDate(new Date("2026-10-03T22:30:00Z"), "Asia/Shanghai");
    expect(columnToLocalDate(frozen.practiceLocalDate)).toBe("2026-10-04");
    expect(frozen.practiceLocalTimezone).toBe("Asia/Shanghai");
  });
});

describe("getContinuity from daily rollups", () => {
  beforeEach(() => {
    rollups.length = 0;
    sessions.length = 0;
  });

  it("identifies gap, break and resumption by frozen local days", async () => {
    rollups.push(
      { userId: USER, practiceLocalDate: localDateToColumn("2026-10-01"), practiceCount: 1, totalDurationMs: 600_000n, annotationCount: 0 },
      { userId: USER, practiceLocalDate: localDateToColumn("2026-10-02"), practiceCount: 1, totalDurationMs: 600_000n, annotationCount: 0 },
      { userId: USER, practiceLocalDate: localDateToColumn("2026-10-04"), practiceCount: 2, totalDurationMs: 1_200_000n, annotationCount: 3 },
      { userId: USER, practiceLocalDate: localDateToColumn("2026-10-07"), practiceCount: 1, totalDurationMs: 600_000n, annotationCount: 1 },
    );

    const report = await getContinuity(USER, {
      timezone: "Asia/Shanghai",
      breakThresholdDays: 2,
      graceDays: 0,
    });

    expect(report.gaps).toEqual([
      { kind: "gap", fromDate: "2026-10-02", toDate: "2026-10-04", missedDays: 1 },
    ]);
    expect(report.breaks).toEqual([
      { kind: "break", fromDate: "2026-10-04", toDate: "2026-10-07", missedDays: 2 },
    ]);
    expect(report.resumptionCount).toBe(1);
    // 10-04 当天两场练习已在汇总层合并为一个练习日、两次计数。
    expect(report.totalPracticeDays).toBe(4);
    expect(report.totalSessions).toBe(5);
    expect(report.totalAnnotationCount).toBe(4);
  });

  it("does not rewrite frozen days when the caller timezone changes", async () => {
    sessions.push({
      id: "s1",
      userId: USER,
      status: "COMPLETED",
      instrument: "Piano",
      startedAt: new Date("2026-10-03T22:30:00Z"),
      actualDurationMs: 600_000n,
      // 冻结在上海本地 10-04。
      practiceLocalDate: localDateToColumn("2026-10-04"),
      practiceLocalTimezone: "Asia/Shanghai",
      annotationCount: 0,
    });

    const underUtc = await getContinuity(USER, {
      timezone: "UTC",
      instrument: "Piano",
      breakThresholdDays: 2,
      graceDays: 0,
    });
    // 即便调用方改成 UTC，历史练习仍归在冻结的 10-04，不被重算到 10-03。
    expect(underUtc.days.map((day) => day.date)).toEqual(["2026-10-04"]);
  });
});
