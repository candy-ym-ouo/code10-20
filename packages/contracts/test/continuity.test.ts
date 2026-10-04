import { describe, expect, it } from "vitest";
import {
  addDays,
  analyzeContinuity,
  collectPracticeDays,
  daysBetween,
  localDateKey,
  mergeLatePracticeEvents,
  type ContinuityEvent,
} from "../src/continuity.js";

const TZ = "Asia/Shanghai";

/** 在指定时区的本地自然日 12:00 构造一个绝对时间 */
function atLocalNoon(dateKey: string, tz = TZ): Date {
  const instantGuess = new Date(`${dateKey}T12:00:00Z`);
  // 找出使 localDateKey 等于 dateKey 的 UTC 偏移（处理时区偏移即可，不依赖历史 DST 边界精度）
  for (let offsetMin = -720; offsetMin <= 840; offsetMin += 15) {
    const candidate = new Date(instantGuess.getTime() - offsetMin * 60_000);
    if (localDateKey(candidate, tz) === dateKey) return candidate;
  }
  throw new Error(`无法为 ${dateKey} 构造时间`);
}

function event(sessionId: string, dateKey: string, opts: Partial<ContinuityEvent> = {}): ContinuityEvent {
  return {
    sessionId,
    startedAt: atLocalNoon(dateKey),
    frozenLocalDate: opts.frozenLocalDate === undefined ? dateKey : opts.frozenLocalDate,
    actualDurationMs: opts.actualDurationMs ?? 1_000,
    completedAt: opts.completedAt ?? atLocalNoon(dateKey),
  };
}

describe("localDateKey / date arithmetic", () => {
  it("按指定时区换算本地自然日", () => {
    // 2026-10-01 23:30 UTC = 上海 10-02 07:30
    expect(localDateKey(new Date("2026-10-01T23:30:00Z"), "Asia/Shanghai")).toBe("2026-10-02");
    // 同一时刻在 UTC-5 仍是 10-01
    expect(localDateKey(new Date("2026-10-01T23:30:00Z"), "America/New_York")).toBe("2026-10-01");
  });

  it("自然日加减与差值不依赖时区/DST", () => {
    expect(addDays("2026-10-01", 1)).toBe("2026-10-02");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(daysBetween("2026-10-01", "2026-10-04")).toBe(3);
  });
});

describe("按本地自然日识别", () => {
  it("跨 UTC 午夜但属于同一本地自然日的练习落在同一天", () => {
    const days = collectPracticeDays(
      [
        {
          sessionId: "a",
          startedAt: new Date("2026-10-01T16:30:00Z"), // 上海 10-02 00:30
          frozenLocalDate: null,
        },
        {
          sessionId: "b",
          startedAt: new Date("2026-10-01T17:30:00Z"), // 上海 10-02 01:30
          frozenLocalDate: null,
        },
      ],
      TZ,
    );
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe("2026-10-02");
    expect(days[0].practiceCount).toBe(2);
  });
});

describe("连续 / 间隔 / 中断 / 恢复", () => {
  it("相邻自然日构成连续段，没有间隔", () => {
    const result = analyzeContinuity(
      [event("s1", "2026-10-01"), event("s2", "2026-10-02"), event("s3", "2026-10-03")],
      { asOf: atLocalNoon("2026-10-03") },
    );
    expect(result.streaks).toHaveLength(1);
    expect(result.longestStreak?.lengthDays).toBe(3);
    expect(result.gaps).toEqual([]);
    expect(result.current.status).toBe("ACTIVE");
  });

  it("缺 1 天在宽限期内记为 REST 间隔，连续段断开但可随时恢复", () => {
    const result = analyzeContinuity(
      [event("s1", "2026-10-01"), event("s2", "2026-10-03")], // 缺 10-02 共 1 天
      { asOf: atLocalNoon("2026-10-03") },
    );
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ kind: "REST", status: "RECOVERED", missingDays: 1, recoveredAt: "2026-10-03" });
    expect(result.streaks.map((s) => s.lengthDays)).toEqual([1, 1]);
  });

  it("缺 2 天（宽限 1、阈值 3）的已闭合间隔记为 AT_RISK", () => {
    const result = analyzeContinuity(
      [event("s1", "2026-10-01"), event("s2", "2026-10-04")], // 缺 10-02/10-03 共 2 天
      { asOf: atLocalNoon("2026-10-04") },
    );
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ kind: "AT_RISK", status: "RECOVERED", missingDays: 2 });
  });

  it("最后练习日后缺 1 天为 GRACE，缺 2 天升级为 AT_RISK，缺 3 天中断", () => {
    const base = [event("s1", "2026-10-01"), event("s2", "2026-10-02")];

    // 10-02 -> asOf 10-03：今天还没练，缺 1 天，宽限期
    const grace = analyzeContinuity(base, { asOf: atLocalNoon("2026-10-03") });
    expect(grace.openGap).toMatchObject({ kind: "REST", missingDays: 1 });
    expect(grace.current.status).toBe("GRACE");

    // 缺 10-03 共 1 个自然日：超过宽限但未到中断阈值
    const atRisk = analyzeContinuity(base, { asOf: atLocalNoon("2026-10-04") });
    expect(atRisk.openGap).toMatchObject({ kind: "AT_RISK", missingDays: 2 });
    expect(atRisk.current.status).toBe("AT_RISK");

    // 缺 10-03/10-04 共 2 个自然日：达到中断阈值
    const broken = analyzeContinuity(base, { asOf: atLocalNoon("2026-10-05") });
    expect(broken.openGap).toMatchObject({ kind: "INTERRUPTION", missingDays: 3 });
    expect(broken.current.status).toBe("BROKEN");
  });

  it("缺失达到 breakAfterDays 天记为中断，再次练习记为恢复", () => {
    const result = analyzeContinuity(
      [
        event("s1", "2026-09-20"),
        event("s2", "2026-09-21"),
        event("s3", "2026-09-25"), // 缺 09-22/23/24 共 3 天
        event("s4", "2026-09-26"),
      ],
      { asOf: atLocalNoon("2026-09-26") },
    );
    const interruption = result.gaps.find((g) => g.kind === "INTERRUPTION");
    expect(interruption).toMatchObject({
      afterDate: "2026-09-21",
      beforeDate: "2026-09-25",
      missingDays: 3,
      recoveredAt: "2026-09-25",
    });
    expect(result.recoveries).toEqual([
      {
        resumedDate: "2026-09-25",
        interruptionDays: 3,
        afterDate: "2026-09-21",
        followingStreakDays: 2,
      },
    ]);
    expect(result.longestStreak?.lengthDays).toBe(2);
    expect(result.current.status).toBe("ACTIVE");
  });

  it("中断后未恢复：asOf 达到阈值时当前状态为 BROKEN 并产生开放中断", () => {
    const result = analyzeContinuity(
      [event("s1", "2026-10-01"), event("s2", "2026-10-02")],
      { asOf: atLocalNoon("2026-10-06") }, // 缺 10-03/04/05 共 3 个自然日
    );
    expect(result.openGap).toMatchObject({ kind: "INTERRUPTION", status: "OPEN", missingDays: 4 });
    expect(result.current.status).toBe("BROKEN");
    expect(result.current.streak).toBeNull();
  });

  it("阈值可配置：graceDays=2 时缺 2 天仍是 REST", () => {
    const result = analyzeContinuity(
      [event("s1", "2026-10-01"), event("s2", "2026-10-04")],
      { asOf: atLocalNoon("2026-10-04"), graceDays: 2, breakAfterDays: 7 },
    );
    expect(result.gaps[0].kind).toBe("REST");
  });

  it("非法阈值组合直接报错", () => {
    expect(() => analyzeContinuity([], { graceDays: 3, breakAfterDays: 3 })).toThrow(/breakAfterDays/);
  });
});

describe("时区变更不重算历史", () => {
  it("冻结日期优先，改时区后历史练习日保持不变", () => {
    // 会话在上海时区 10-02 凌晨完成并冻结；之后用户搬到纽约（UTC-5/-4）再分析
    const events = [
      {
        sessionId: "a",
        startedAt: new Date("2026-10-01T16:30:00Z"), // 上海 10-02 00:30
        frozenLocalDate: "2026-10-02",
      },
    ];
    const days = collectPracticeDays(events, "America/New_York");
    expect(days[0].date).toBe("2026-10-02");

    const result = analyzeContinuity(events, { timezone: "America/New_York", asOf: new Date("2026-10-05T12:00:00Z") });
    expect(result.firstPracticeDate).toBe("2026-10-02");
  });

  it("未冻结的历史遗留数据才用请求时区兜底换算", () => {
    const events = [
      {
        sessionId: "a",
        startedAt: new Date("2026-10-01T23:30:00Z"),
        frozenLocalDate: null,
      },
    ];
    expect(collectPracticeDays(events, "Asia/Shanghai")[0].date).toBe("2026-10-02");
    expect(collectPracticeDays(events, "UTC")[0].date).toBe("2026-10-01");
  });
});

describe("迟到数据合并不重复计数", () => {
  it("同一天补录第二条练习只增加次数、不增加练习天数", () => {
    const events = [event("s1", "2026-10-01", { completedAt: atLocalNoon("2026-10-01") })];
    const late = event("s2", "2026-10-01", { completedAt: atLocalNoon("2026-10-05") }); // 5 天后才同步
    const merged = mergeLatePracticeEvents(events, [late]);

    const days = collectPracticeDays(merged, TZ);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ date: "2026-10-01", practiceCount: 2 });

    const result = analyzeContinuity(merged, { asOf: atLocalNoon("2026-10-05") });
    expect(result.totalPracticeDays).toBe(1);
    expect(result.totalPractices).toBe(2);
  });

  it("迟到补到历史缺口的某一天会并入并延长此前的连续天数，不产生重复", () => {
    const events = [event("s1", "2026-10-01"), event("s2", "2026-10-03")];
    // 10-02 的练习在 10-05 才同步上来（设备离线）
    const late = event("s3", "2026-10-02", { completedAt: atLocalNoon("2026-10-05") });

    const before = analyzeContinuity(events, { asOf: atLocalNoon("2026-10-03") });
    expect(before.longestStreak?.lengthDays).toBe(1);

    const after = analyzeContinuity(mergeLatePracticeEvents(events, [late]), {
      asOf: atLocalNoon("2026-10-05"),
    });
    expect(after.totalPracticeDays).toBe(3);
    expect(after.totalPractices).toBe(3);
    expect(after.longestStreak?.lengthDays).toBe(3);
    expect(after.gaps.filter((g) => g.status === "RECOVERED")).toEqual([]);
  });

  it("同一 session 重复投递（重放）只计一次", () => {
    const original = event("s1", "2026-10-01");
    const replay = { ...event("s1", "2026-10-01"), actualDurationMs: 999 };
    const merged = mergeLatePracticeEvents([original], [replay, replay]);
    const days = collectPracticeDays(merged, TZ);
    expect(days).toHaveLength(1);
    expect(days[0].practiceCount).toBe(1);
    expect(days[0].totalDurationMs).toBe(1000);
  });

  it("接受乱序输入，输出按日期升序", () => {
    const days = collectPracticeDays(
      [event("s3", "2026-10-03"), event("s1", "2026-10-01"), event("s2", "2026-10-02")],
      TZ,
    );
    expect(days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });
});

describe("空数据", () => {
  it("没有任何练习时返回 NONE 状态而非抛错", () => {
    const result = analyzeContinuity([], { asOf: atLocalNoon("2026-10-04") });
    expect(result).toMatchObject({
      current: { status: "NONE", daysSinceLastPractice: 0, streak: null },
      totalPracticeDays: 0,
      firstPracticeDate: null,
      lastPracticeDate: null,
      openGap: null,
    });
  });
});
