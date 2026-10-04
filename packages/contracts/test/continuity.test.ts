import { describe, expect, it } from "vitest";
import {
  analyzeContinuity,
  diffLocalDays,
  groupEventsByDay,
  isValidLocalDate,
  localDateKey,
  mergeDayIndexes,
  mergeEventIntoDays,
  shiftLocalDate,
  type PracticeEvent,
} from "../src/continuity.js";

const event = (partial: Partial<PracticeEvent> & { sessionId: string }): PracticeEvent => ({
  ...partial,
});

// 固定一批练习日：10/01、10/02、10/04（02→04 缺 1 天 = 间隔），10/07（04→07 缺 2 天 = 中断）
const baseEvents: PracticeEvent[] = [
  event({ sessionId: "s1", localDate: "2026-10-01" }),
  event({ sessionId: "s2", localDate: "2026-10-02" }),
  event({ sessionId: "s3", localDate: "2026-10-04" }),
  event({ sessionId: "s4", localDate: "2026-10-07" }),
];

describe("local date key", () => {
  it("maps an instant to the local natural day in the requested timezone", () => {
    // 2026-10-03 22:30 UTC = 2026-10-04 06:30 上海
    const instant = new Date("2026-10-03T22:30:00Z");
    expect(localDateKey(instant, "Asia/Shanghai")).toBe("2026-10-04");
    expect(localDateKey(instant, "UTC")).toBe("2026-10-03");
    expect(localDateKey(instant, "America/Los_Angeles")).toBe("2026-10-03");
  });

  it("validates and walks calendar dates including month boundaries", () => {
    expect(isValidLocalDate("2026-02-29")).toBe(false); // 2026 非闰年
    expect(isValidLocalDate("2024-02-29")).toBe(true);
    expect(shiftLocalDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(diffLocalDays("2026-10-01", "2026-10-07")).toBe(6);
  });
});

describe("gaps, breaks and resumptions", () => {
  it("classifies a single missed day as gap and >=2 missed days as break + resumption", () => {
    const report = analyzeContinuity(baseEvents, { today: "2026-10-07" });
    expect(report.gaps).toEqual([
      { kind: "gap", fromDate: "2026-10-02", toDate: "2026-10-04", missedDays: 1 },
    ]);
    expect(report.breaks).toEqual([
      { kind: "break", fromDate: "2026-10-04", toDate: "2026-10-07", missedDays: 2 },
    ]);
    expect(report.resumptions).toEqual([
      { date: "2026-10-07", previousDate: "2026-10-04", missedDays: 2 },
    ]);
    expect(report.breakCount).toBe(1);
    expect(report.resumptionCount).toBe(1);
  });

  it("honours a custom break threshold", () => {
    const report = analyzeContinuity(baseEvents, { today: "2026-10-07", breakThresholdDays: 3 });
    expect(report.gaps).toHaveLength(2);
    expect(report.breaks).toHaveLength(0);
    expect(report.resumptions).toHaveLength(0);
  });
});

describe("streaks", () => {
  it("breaks the streak on any missed day under strict calendar-day semantics", () => {
    const report = analyzeContinuity(baseEvents, { today: "2026-10-07" });
    expect(report.longestStreak).toMatchObject({ startDate: "2026-10-01", endDate: "2026-10-02", lengthDays: 2, practiceDays: 2 });
    expect(report.currentStreak).toMatchObject({ startDate: "2026-10-07", endDate: "2026-10-07", lengthDays: 1 });
    expect(report.state).toBe("PRACTICED_TODAY");
    expect(report.practicedToday).toBe(true);
  });

  it("marks state AT_RISK after one missed day and BROKEN beyond the grace window", () => {
    const yesterday = analyzeContinuity(baseEvents, { today: "2026-10-08" });
    expect(yesterday.state).toBe("AT_RISK");
    expect(yesterday.daysSinceLastPractice).toBe(1);
    expect(yesterday.currentStreak, "宽限 +1 天内仍保留当前连续").not.toBeNull();

    const broken = analyzeContinuity(baseEvents, { today: "2026-10-09" });
    expect(broken.state).toBe("BROKEN");
    expect(broken.currentStreak, "超出宽限窗口后当前连续为 null").toBeNull();
  });

  it("keeps the streak across missed days within the grace window", () => {
    const report = analyzeContinuity(baseEvents, { today: "2026-10-07", graceDays: 2 });
    // 02→04（缺 1）与 04→07（缺 2）都落在 2 天宽限内，连续贯穿 10-01 ~ 10-07。
    expect(report.currentStreak).toMatchObject({ startDate: "2026-10-01", endDate: "2026-10-07", practiceDays: 4 });
    expect(report.currentStreak?.lengthDays).toBe(7);
  });
});

describe("late-arriving data is merged without double counting", () => {
  it("deduplicates the same session replayed twice", () => {
    const days = groupEventsByDay([
      event({ sessionId: "s1", localDate: "2026-10-01", actualDurationMs: 1000, annotationCount: 2 }),
      event({ sessionId: "s1", localDate: "2026-10-01", actualDurationMs: 1000, annotationCount: 2 }),
    ]);
    const day = days.get("2026-10-01")!;
    expect(day.practiceCount).toBe(1);
    expect(day.sessionIds).toEqual(["s1"]);
    expect(day.totalDurationMs).toBe(1000);
    expect(day.totalAnnotationCount).toBe(2);
  });

  it("counts multiple distinct sessions on the same natural day as one practice day", () => {
    const days = groupEventsByDay([
      event({ sessionId: "s1", localDate: "2026-10-01", actualDurationMs: 1000 }),
      event({ sessionId: "s2", localDate: "2026-10-01", actualDurationMs: 2000 }),
    ]);
    const day = days.get("2026-10-01")!;
    expect(day.practiceCount).toBe(2);
    expect(day.totalDurationMs).toBe(3000);
    const report = analyzeContinuity(days, { today: "2026-10-01" });
    expect(report.totalPracticeDays).toBe(1);
    expect(report.totalSessions).toBe(2);
  });

  it("replaces the stale snapshot when a later version arrives and moves it across days", () => {
    let internal = new Map();
    const first = mergeEventIntoDays(
      internal,
      event({ sessionId: "s1", localDate: "2026-10-01", actualDurationMs: 1000, version: 1 }),
    );
    internal = first.days;
    // 迟到修正：开始时间落在了次日，版本更高。
    const corrected = mergeEventIntoDays(
      internal,
      event({ sessionId: "s1", localDate: "2026-10-02", actualDurationMs: 1500, version: 2 }),
    );
    expect(corrected.previousDate).toBe("2026-10-01");
    expect(corrected.date).toBe("2026-10-02");
    expect(corrected.days.has("2026-10-01")).toBe(false);
    expect(corrected.days.get("2026-10-02")!.practiceCount).toBe(1);
  });

  it("ignores an older version arriving late", () => {
    let internal = mergeEventIntoDays(
      new Map(),
      event({ sessionId: "s1", localDate: "2026-10-01", actualDurationMs: 9000, version: 5 }),
    ).days;
    const stale = mergeEventIntoDays(
      internal,
      event({ sessionId: "s1", localDate: "2026-10-01", actualDurationMs: 1000, version: 4 }),
    );
    expect(stale.ignored).toBe(true);
    expect(stale.days.get("2026-10-01")!.totalDurationMs).toBe(9000);
  });

  it("merges two sharded day indexes without counting a shared session twice", () => {
    const left = groupEventsByDay([event({ sessionId: "s1", localDate: "2026-10-01", actualDurationMs: 1000 })]);
    const right = groupEventsByDay([
      event({ sessionId: "s1", localDate: "2026-10-01", actualDurationMs: 1000 }),
      event({ sessionId: "s2", localDate: "2026-10-02", actualDurationMs: 2000 }),
    ]);
    const merged = mergeDayIndexes(left, right);
    expect(merged.get("2026-10-01")!.practiceCount).toBe(1);
    expect(merged.get("2026-10-02")!.practiceCount).toBe(1);
  });
});

describe("timezone changes never rewrite history", () => {
  it("keeps a frozen localDate even when a different timezone would shift it", () => {
    // 同一场练习：冻结在上海本地 10-04；即便用户改到 UTC，也不重算。
    const frozen = event({
      sessionId: "s1",
      localDate: "2026-10-04",
      localTimezone: "Asia/Shanghai",
      startedAt: new Date("2026-10-03T22:30:00Z"),
    });
    const days = groupEventsByDay([frozen], "UTC");
    expect([...days.keys()]).toEqual(["2026-10-04"]);

    // 没有冻结日期的旧数据才按回退时区即时计算。
    const legacy = event({ sessionId: "s2", startedAt: new Date("2026-10-03T22:30:00Z") });
    const legacyDays = groupEventsByDay([legacy], "UTC");
    expect([...legacyDays.keys()]).toEqual(["2026-10-03"]);
  });
});

describe("empty input", () => {
  it("returns a NO_DATA report", () => {
    const report = analyzeContinuity([], { today: "2026-10-04" });
    expect(report.state).toBe("NO_DATA");
    expect(report.currentStreak).toBeNull();
    expect(report.longestStreak).toBeNull();
    expect(report.totalPracticeDays).toBe(0);
  });
});
