/**
 * 练习连续性分析引擎（纯领域层，无 I/O）。
 *
 * 三条核心口径：
 * 1. 按“本地自然日”识别间隔、中断与恢复，时区用 IANA 名称（如 Asia/Shanghai）。
 * 2. 时区变更不重算历史：每个练习在“完成时刻”冻结其本地日期与所属时区，
 *    后续用户修改时区只影响新练习，历史练习的 localDate 保持不变。
 * 3. 迟到数据合并不重复计数：按 sessionId 幂等去重，同一自然日多场练习先合并再计数；
 *    同一会话再次到达时以更新版本替换旧快照。
 */

/** 一场已完成练习在连续性引擎里的最小投影。 */
export interface PracticeEvent {
  sessionId: string;
  /** 练习开始时刻（UTC 绝对时间）。仅在 localDate 缺失时用于回退计算。 */
  startedAt?: Date;
  /**
   * 完成时刻冻结下来的本地自然日，格式 YYYY-MM-DD。
   * 存在时一律以它为准——这是“时区变更不重算历史”的载体。
   */
  localDate?: string;
  /** 冻结本地日期时使用的 IANA 时区，仅用于审计与回退。 */
  localTimezone?: string;
  actualDurationMs?: number | bigint | null;
  annotationCount?: number;
  /** 乐观锁版本，迟到合并时取较大者；相同版本取后到达的。 */
  version?: number;
  instrument?: string | null;
}

/** 一个本地自然日合并后的结果。 */
export interface PracticeDay {
  date: string;
  practiceCount: number;
  /** 当日去重后的会话 ID（幂等合并的证据）。 */
  sessionIds: string[];
  totalDurationMs: number;
  totalAnnotationCount: number;
}

export interface ContinuityOptions {
  /**
   * 间隔（gap）与中断（break）的分界：连续缺失天数 >= 该值记为中断，否则记为间隔。
   * “缺失日”指两个相邻练习日之间没有任何练习的本地自然日。
   * 默认 2：缺 1 天是间隔，缺 2 天及以上是中断。
   */
  breakThresholdDays?: number;
  /**
   * 连续打卡允许的宽限缺失天数：回推连续时，缺失天数 <= 该值不折断。
   * 默认 0：严格按自然日，缺一天即断签。
   */
  graceDays?: number;
  /**
   * “今天”的本地自然日（YYYY-MM-DD），由调用方按用户当前时区传入。
   * 不传则不评估当前连续的状态。
   */
  today?: string;
}

export interface ContinuityGap {
  /** gap = 间隔（未达中断阈值），break = 中断。 */
  kind: "gap" | "break";
  /** 中断/间隔开始前的最后一个练习日。 */
  fromDate: string;
  /** 恢复练习日（与 fromDate 之间是缺失日）。 */
  toDate: string;
  /** 中间连续缺失的自然日天数。 */
  missedDays: number;
}

export interface ContinuityStreak {
  startDate: string;
  endDate: string;
  /** 连续跨越的自然日长度（含宽限缺失日）。 */
  lengthDays: number;
  /** 其中真正有练习的天数。 */
  practiceDays: number;
}

export type ContinuityState = "PRACTICED_TODAY" | "AT_RISK" | "BROKEN" | "NO_DATA";

export interface ContinuityReport {
  /** 参与分析的练习日（按日期升序，已幂等合并、去重计数）。 */
  days: PracticeDay[];
  /** 当前仍然“活着”的连续；已折断或无数据时为 null。 */
  currentStreak: ContinuityStreak | null;
  /** 历史最长连续（含已结束的）。 */
  longestStreak: ContinuityStreak | null;
  /** 所有间隔（缺 1 天，未达中断阈值）。 */
  gaps: ContinuityGap[];
  /** 所有中断（连续缺失达到阈值）。 */
  breaks: ContinuityGap[];
  /** 每一次“中断之后的恢复”（中断后第一个练习日）。 */
  resumptions: Array<{ date: string; previousDate: string; missedDays: number }>;
  /** 当前连续状态，需要 options.today。 */
  state: ContinuityState;
  /** 最近练习日到今天相差的自然日天数；无数据或未给 today 为 null。 */
  daysSinceLastPractice: number | null;
  /** 今天是否已练习（依据 options.today）。 */
  practicedToday: boolean;
  totalPracticeDays: number;
  totalSessions: number;
  totalDurationMs: number;
  totalAnnotationCount: number;
  /** 发生过中断的次数。 */
  breakCount: number;
  /** 中断后恢复的次数。 */
  resumptionCount: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParts(value: string): [number, number, number] {
  const [year, month, day] = value.split("-").map(Number);
  return [year ?? 0, month ?? 0, day ?? 0];
}

export function isValidLocalDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = parseDateParts(value);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * 把绝对时刻映射到某 IANA 时区下的本地自然日（YYYY-MM-DD）。
 * 用 en-CA 取自动补零的 YYYY-MM-DD，避免手写偏移在夏令日上出错。
 */
export function localDateKey(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const key = `${get("year")}-${get("month")}-${get("day")}`;
  if (!isValidLocalDate(key)) {
    throw new Error(`无法为时区 ${timezone} 计算本地自然日`);
  }
  return key;
}

/** 把 YYYY-MM-DD 当作 UTC 午夜安全地加减天数。 */
export function shiftLocalDate(date: string, deltaDays: number): string {
  const [year, month, day] = parseDateParts(date);
  const utc = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return localDateKey(utc, "UTC");
}

/** 两个 YYYY-MM-DD 之间相差的自然日天数（b - a，可为负）。 */
export function diffLocalDays(a: string, b: string): number {
  const [ay, am, ad] = parseDateParts(a);
  const [by, bm, bd] = parseDateParts(b);
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86_400_000);
}

function toFiniteNumber(value: number | bigint | null | undefined): number {
  if (value == null) return 0;
  const num = typeof value === "bigint" ? Number(value) : value;
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/** 内部日结构额外保留源事件，使再次合并时能精确剔除旧快照。 */
interface InternalDay extends PracticeDay {
  versions: number[];
  events: PracticeEvent[];
}

function newInternalDay(date: string, events: PracticeEvent[]): InternalDay {
  return {
    date,
    events,
    versions: events.map((event) => event.version ?? 0),
    sessionIds: events.map((event) => event.sessionId),
    practiceCount: events.length,
    totalDurationMs: events.reduce((sum, event) => sum + toFiniteNumber(event.actualDurationMs), 0),
    totalAnnotationCount: events.reduce((sum, event) => sum + (event.annotationCount ?? 0), 0),
  };
}

function resolveDate(event: PracticeEvent, fallbackTimezone?: string): string {
  const date =
    event.localDate ??
    localDateKey(event.startedAt ?? new Date(), event.localTimezone ?? fallbackTimezone ?? "UTC");
  if (!isValidLocalDate(date)) throw new Error(`非法本地自然日: ${date}`);
  return date;
}

function toPublicDay(day: InternalDay): PracticeDay {
  return {
    date: day.date,
    practiceCount: day.practiceCount,
    sessionIds: [...day.sessionIds],
    totalDurationMs: day.totalDurationMs,
    totalAnnotationCount: day.totalAnnotationCount,
  };
}

/**
 * 把一场练习幂等合并进“按本地自然日”的索引。
 * 同一 sessionId 已存在时（迟到重放/更新）：携带更旧版本直接忽略，
 * 否则先移除旧快照再写入新快照，因此同一天多场练习合并计数、同一场永远只算一次。
 * 不修改入参 Map。previousDate 为旧快照所在日（跨日修正时与 date 不同）。
 */
export function mergeEventIntoDays(
  days: ReadonlyMap<string, InternalDay>,
  event: PracticeEvent,
  fallbackTimezone?: string,
): { days: Map<string, InternalDay>; previousDate?: string; date: string; ignored: boolean } {
  const date = resolveDate(event, fallbackTimezone);
  const next = new Map(days);
  let previousDate: string | undefined;

  for (const [existingDate, day] of next) {
    const index = day.sessionIds.indexOf(event.sessionId);
    if (index === -1) continue;
    if (event.version != null && event.version < (day.versions[index] ?? 0)) {
      return { days: next, date: existingDate, ignored: true };
    }
    previousDate = existingDate;
    const surviving = day.events.filter((item) => item.sessionId !== event.sessionId);
    if (surviving.length === 0) next.delete(existingDate);
    else next.set(existingDate, newInternalDay(existingDate, surviving));
    break;
  }

  const merged = [...(next.get(date)?.events ?? []), event];
  next.set(date, newInternalDay(date, merged));
  return { days: next, ...(previousDate ? { previousDate } : {}), date, ignored: false };
}

/** 批量把事件流折叠成按日索引：重复 sessionId 自动去重，迟到会话以新换旧。 */
export function groupEventsByDay(
  events: Iterable<PracticeEvent>,
  fallbackTimezone?: string,
): Map<string, PracticeDay> {
  let internal = new Map<string, InternalDay>();
  for (const event of events) {
    internal = mergeEventIntoDays(internal, event, fallbackTimezone).days;
  }
  return new Map([...internal].map(([key, day]) => [key, toPublicDay(day)]));
}

/**
 * 合并两个已按日聚合的结果（分片/迟到批次到达场景）。
 * 跨片同会话不重复计数；若只有公开 PracticeDay（无源事件），按会话 ID 去重。
 */
export function mergeDayIndexes(
  left: ReadonlyMap<string, PracticeDay>,
  right: ReadonlyMap<string, PracticeDay>,
): Map<string, PracticeDay> {
  const seen = new Set<string>();
  const merged = new Map<string, PracticeDay>();

  for (const source of [left, right]) {
    for (const day of source.values()) {
      const fresh = day.sessionIds.filter((id) => !seen.has(id));
      if (fresh.length === 0) continue;
      fresh.forEach((id) => seen.add(id));
      const existing = merged.get(day.date);
      if (!existing) {
        merged.set(day.date, {
          date: day.date,
          practiceCount: fresh.length,
          sessionIds: [...fresh],
          // 无会话级明细时，总量只能按保留比例摊算（持久层路径会直接重算，不走这里）。
          totalDurationMs: Math.round((day.totalDurationMs / day.practiceCount) * fresh.length),
          totalAnnotationCount: Math.round(
            (day.totalAnnotationCount / day.practiceCount) * fresh.length,
          ),
        });
      } else {
        existing.practiceCount += fresh.length;
        existing.sessionIds.push(...fresh);
        existing.totalDurationMs += Math.round((day.totalDurationMs / day.practiceCount) * fresh.length);
        existing.totalAnnotationCount += Math.round(
          (day.totalAnnotationCount / day.practiceCount) * fresh.length,
        );
      }
    }
  }
  return merged;
}

function buildStreak(
  sorted: PracticeDay[],
  endIndex: number,
  graceDays: number,
): { streak: ContinuityStreak; nextIndex: number } {
  let startIndex = endIndex;
  let practiceDays = 1;
  let index = endIndex;
  while (index > 0) {
    const prev = sorted[index - 1]!;
    const current = sorted[index]!;
    const missed = diffLocalDays(prev.date, current.date) - 1;
    if (missed > graceDays) break;
    startIndex = index - 1;
    practiceDays += 1;
    index -= 1;
  }
  const first = sorted[startIndex]!;
  const last = sorted[endIndex]!;
  return {
    streak: {
      startDate: first.date,
      endDate: last.date,
      lengthDays: diffLocalDays(first.date, last.date) + 1,
      practiceDays,
    },
    nextIndex: startIndex - 1,
  };
}

/**
 * 连续性分析主入口。
 * 可直接传入事件流（自动幂等折叠），或传入 groupEventsByDay/mergeDayIndexes 的结果。
 * 乐器等维度过滤请在调用前作用于事件流，保证日级计数口径干净。
 */
export function analyzeContinuity(
  input: ReadonlyMap<string, PracticeDay> | Iterable<PracticeEvent>,
  options: ContinuityOptions = {},
): ContinuityReport {
  const breakThreshold = Math.max(1, options.breakThresholdDays ?? 2);
  const graceDays = Math.max(0, options.graceDays ?? 0);

  let dayMap: ReadonlyMap<string, PracticeDay>;
  if (input instanceof Map) {
    dayMap = input;
  } else {
    dayMap = groupEventsByDay(input as Iterable<PracticeEvent>);
  }
  const sorted = [...dayMap.values()]
    .filter((day) => day.practiceCount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const gaps: ContinuityGap[] = [];
  const breaks: ContinuityGap[] = [];
  const resumptions: ContinuityReport["resumptions"] = [];

  let longestStreak: ContinuityStreak | null = null;
  let currentStreak: ContinuityStreak | null = null;

  let index = sorted.length - 1;
  while (index >= 0) {
    const built = buildStreak(sorted, index, graceDays);
    if (!longestStreak || built.streak.lengthDays > longestStreak.lengthDays) {
      longestStreak = built.streak;
    }
    if (index === sorted.length - 1) currentStreak = built.streak;
    index = built.nextIndex;
  }

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const current = sorted[i]!;
    const missedDays = diffLocalDays(prev.date, current.date) - 1;
    if (missedDays <= 0) continue;
    if (missedDays >= breakThreshold) {
      breaks.push({ kind: "break", fromDate: prev.date, toDate: current.date, missedDays });
      resumptions.push({ date: current.date, previousDate: prev.date, missedDays });
    } else {
      gaps.push({ kind: "gap", fromDate: prev.date, toDate: current.date, missedDays });
    }
  }

  const lastDay = sorted.at(-1) ?? null;
  const daysSinceLastPractice =
    options.today && lastDay ? diffLocalDays(lastDay.date, options.today) : null;
  const practicedToday = Boolean(options.today && lastDay?.date === options.today);

  let state: ContinuityState = "NO_DATA";
  if (lastDay && options.today) {
    const distance = diffLocalDays(lastDay.date, options.today);
    if (distance <= 0) state = "PRACTICED_TODAY";
    else if (distance <= graceDays + 1) state = "AT_RISK";
    else state = "BROKEN";
    // 最近练习距今已超出“宽限 + 1 天”：当前连续已折断，只保留历史最长。
    if (distance > graceDays + 1) currentStreak = null;
  }

  const totals = sorted.reduce(
    (acc, day) => {
      acc.practiceDays += 1;
      acc.sessions += day.practiceCount;
      acc.duration += day.totalDurationMs;
      acc.annotations += day.totalAnnotationCount;
      return acc;
    },
    { practiceDays: 0, sessions: 0, duration: 0, annotations: 0 },
  );

  return {
    days: sorted.map((day) => ({
      date: day.date,
      practiceCount: day.practiceCount,
      sessionIds: [...day.sessionIds],
      totalDurationMs: day.totalDurationMs,
      totalAnnotationCount: day.totalAnnotationCount,
    })),
    currentStreak,
    longestStreak,
    gaps,
    breaks,
    resumptions,
    state,
    daysSinceLastPractice,
    practicedToday,
    totalPracticeDays: totals.practiceDays,
    totalSessions: totals.sessions,
    totalDurationMs: totals.duration,
    totalAnnotationCount: totals.annotations,
    breakCount: breaks.length,
    resumptionCount: resumptions.length,
  };
}
