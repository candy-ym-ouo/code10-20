/**
 * 练习连续性分析引擎（纯函数，无 IO，可被前后端与测试直接复用）。
 *
 * 统计口径（与 README / 项目文档一致）：
 * 1. 按本地自然日聚合：一次练习归属到“练习发生时（startedAt）在用户当时时区”的自然日。
 *    练习完成时该日期会被冻结落库（frozenLocalDate）。
 * 2. 时区变更不重算历史：分析时优先使用冻结日期；只有历史遗留、没有冻结日期的记录
 *    才用本次请求的 timezone 兜底换算。改时区只影响变更之后的新数据。
 * 3. 迟到数据合并不重复计数：同一天的多条练习记录合并成一个“练习日”，
 *    按 sessionId 去重；迟到补录只会并入既有日期或延长连续天数，不会重复计数。
 *
 * 连续性概念：
 * - 连续（streak）：相邻自然日均有练习的一段日期。
 * - 间隔（gap/REST）：相邻两个练习日之间缺失的自然日数不超过 graceDays（默认 1）。
 * - 中断（INTERRUPTION）：缺失自然日数达到 breakAfterDays（默认 3）及以上。
 * - 恢复（recovery）：一次中断之后再次出现练习日。
 */

export interface ContinuityEvent {
  /** 练习会话 ID，用于同一天迟到数据去重 */
  sessionId: string;
  /** 练习实际发生时间（绝对时间，timestamptz） */
  startedAt: Date;
  /** 完成时按当时时区冻结的本地自然日（YYYY-MM-DD）；历史数据可能为空 */
  frozenLocalDate?: string | null;
  actualDurationMs?: number | bigint | null;
  instrument?: string | null;
  completedAt?: Date | null;
}

/** 间隔的严重度分类 */
export type GapKind = "REST" | "AT_RISK" | "INTERRUPTION";
/** 间隔是否已闭合：已恢复 / 仍开放到 asOf */
export type GapStatus = "RECOVERED" | "OPEN";
/** 当前（截至 asOf）连续状态 */
export type CurrentStreakStatus = "ACTIVE" | "GRACE" | "AT_RISK" | "BROKEN" | "NONE";

export interface PracticeDay {
  /** 本地自然日，YYYY-MM-DD */
  date: string;
  /** 合并到该自然日的练习会话（迟到数据合并后的去重结果） */
  sessionIds: string[];
  /** 当天练习次数（多条记录合并计数一次天数，但次数可大于 1） */
  practiceCount: number;
  totalDurationMs: number;
}

export interface ContinuityGap {
  /** 0 起，按时间先后编号 */
  index: number;
  /** 间隔前最后一个练习日 */
  afterDate: string;
  /** 恢复后的第一个练习日；开放间隔为 null */
  beforeDate: string | null;
  /** 中间缺失的自然日数量（相差一天时为 0，不产生 gap） */
  missingDays: number;
  kind: GapKind;
  status: GapStatus;
  /** status === RECOVERED 时等于 beforeDate，否则为 null */
  recoveredAt: string | null;
}

export interface ContinuityStreak {
  startDate: string;
  endDate: string;
  lengthDays: number;
  practiceCount: number;
  totalDurationMs: number;
  /** 末端是否开放：endDate 是 asOf 之前最后一个练习日 */
  open: boolean;
}

export interface CurrentStreak {
  status: CurrentStreakStatus;
  /** 距离最后一个练习日的自然日数：0 表示今天练过 */
  daysSinceLastPractice: number;
  streak: ContinuityStreak | null;
}

export interface ContinuityRecovery {
  /** 恢复当天的日期 */
  resumedDate: string;
  /** 此前中断缺失的自然日数 */
  interruptionDays: number;
  /** 恢复前的练习日 */
  afterDate: string;
  /** 恢复后连续段截至 asOf 的长度 */
  followingStreakDays: number;
}

export interface ContinuityAnalysis {
  /** 本次分析实际使用的时区（仅用于未冻结的历史数据与 asOf 换算） */
  timezone: string;
  asOfDate: string;
  graceDays: number;
  breakAfterDays: number;
  totalPracticeDays: number;
  /** 合并去重后的练习会话总数（可能大于练习日数） */
  totalPractices: number;
  totalDurationMs: number;
  firstPracticeDate: string | null;
  lastPracticeDate: string | null;
  current: CurrentStreak;
  longestStreak: ContinuityStreak | null;
  streaks: ContinuityStreak[];
  gaps: ContinuityGap[];
  /** 已闭合的中断（每次中断后恢复） */
  recoveries: ContinuityRecovery[];
  /** 截至 asOf 仍在持续的开放间隔；没有练习记录时为 null */
  openGap: ContinuityGap | null;
  generatedAt: Date;
}

export interface ContinuityOptions {
  /** 只用于未冻结日期的兜底换算与 asOf，默认 Asia/Shanghai */
  timezone?: string;
  /** 评估“当前状态/开放间隔”的时间点，默认 new Date() */
  asOf?: Date;
  /** 间隔宽限自然日数：缺失天数 <= graceDays 视为普通休息间隔，默认 1 */
  graceDays?: number;
  /** 中断阈值：缺失自然日数达到该值视为中断，默认 3 */
  breakAfterDays?: number;
}

const DATE_KEY_LENGTH = 10;

/** 把绝对时间换算成指定 IANA 时区的本地自然日（YYYY-MM-DD） */
export function localDateKey(instant: Date, timezone: string): string {
  // en-CA 的日期格式就是 YYYY-MM-DD，避免手写各字段补零
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** YYYY-MM-DD -> UTC 0 点 Date（键本身不含时区，仅用于做日期运算） */
export function dateKeyToUtcDate(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new RangeError(`非法日期键: ${key}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function addDays(key: string, days: number): string {
  const utc = dateKeyToUtcDate(key);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, DATE_KEY_LENGTH);
}

/** 两个日期键相差的自然日数：b - a */
export function daysBetween(a: string, b: string): number {
  const millis = dateKeyToUtcDate(b).getTime() - dateKeyToUtcDate(a).getTime();
  return Math.round(millis / 86_400_000);
}

function effectiveLocalDate(event: ContinuityEvent, timezone: string): string {
  const frozen = event.frozenLocalDate;
  // 时区变更不重算历史：只要完成时冻结过本地日期，就永远沿用该日期
  if (typeof frozen === "string" && /^\d{4}-\d{2}-\d{2}$/.test(frozen)) return frozen;
  return localDateKey(event.startedAt, timezone);
}

function toFiniteNumber(value: number | bigint | null | undefined): number {
  if (value == null) return 0;
  return Number(value);
}

/**
 * 把练习事件按本地自然日合并。
 * - 接受乱序输入，输出按日期升序。
 * - 迟到数据（晚到的 completedAt）按 sessionId 去重，同一天合并，不重复计数。
 */
export function collectPracticeDays(events: Iterable<ContinuityEvent>, timezone: string): PracticeDay[] {
  const byDate = new Map<string, PracticeDay>();
  const seenSessions = new Set<string>();

  for (const event of events) {
    // 迟到数据可能重放：同一 sessionId 只计入一次，归属首次出现时解析出的自然日
    if (seenSessions.has(event.sessionId)) continue;
    seenSessions.add(event.sessionId);

    const date = effectiveLocalDate(event, timezone);
    let day = byDate.get(date);
    if (!day) {
      day = { date, sessionIds: [], practiceCount: 0, totalDurationMs: 0 };
      byDate.set(date, day);
    }
    day.sessionIds.push(event.sessionId);
    day.practiceCount += 1;
    day.totalDurationMs += toFiniteNumber(event.actualDurationMs);
  }

  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 合并迟到的练习事件：按 sessionId 去重后与既有事件合并。
 * 同一天迟到补录只合并计数一次；补到新的一天会延长连续天数。
 */
export function mergeLatePracticeEvents(
  existing: Iterable<ContinuityEvent>,
  lateEvents: Iterable<ContinuityEvent>,
): ContinuityEvent[] {
  const merged = new Map<string, ContinuityEvent>();
  for (const event of existing) merged.set(event.sessionId, event);
  for (const event of lateEvents) {
    if (!merged.has(event.sessionId)) merged.set(event.sessionId, event);
  }
  return [...merged.values()];
}

function resolveOptions(options: ContinuityOptions | undefined): Required<Omit<ContinuityOptions, "asOf">> & { asOf: Date } {
  const timezone = options?.timezone ?? "Asia/Shanghai";
  const asOf = options?.asOf ?? new Date();
  const graceDays = options?.graceDays ?? 1;
  const breakAfterDays = options?.breakAfterDays ?? 3;
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    throw new RangeError("graceDays 必须是非负整数");
  }
  if (!Number.isInteger(breakAfterDays) || breakAfterDays <= 0) {
    throw new RangeError("breakAfterDays 必须是正整数");
  }
  if (breakAfterDays <= graceDays) {
    throw new RangeError("breakAfterDays 必须大于 graceDays");
  }
  return { timezone, asOf, graceDays, breakAfterDays };
}

function classifyGap(missingDays: number, graceDays: number, breakAfterDays: number): GapKind {
  if (missingDays <= graceDays) return "REST";
  if (missingDays >= breakAfterDays) return "INTERRUPTION";
  return "AT_RISK";
}

/**
 * 连续性分析主入口。
 *
 * @param events 已按用户/乐器等维度过滤好的练习事件；乱序、迟到均可
 * @param options 时区、评估时点与阈值
 */
export function analyzeContinuity(
  events: Iterable<ContinuityEvent>,
  options?: ContinuityOptions,
): ContinuityAnalysis {
  const { timezone, asOf, graceDays, breakAfterDays } = resolveOptions(options);
  const asOfDate = localDateKey(asOf, timezone);
  const days = collectPracticeDays(events, timezone);
  const generatedAt = new Date();

  const base = {
    timezone,
    asOfDate,
    graceDays,
    breakAfterDays,
    totalPracticeDays: days.length,
    totalPractices: days.reduce((sum, day) => sum + day.practiceCount, 0),
    totalDurationMs: days.reduce((sum, day) => sum + day.totalDurationMs, 0),
    firstPracticeDate: days[0]?.date ?? null,
    lastPracticeDate: days[days.length - 1]?.date ?? null,
    generatedAt,
  };

  if (days.length === 0) {
    return {
      ...base,
      current: { status: "NONE", daysSinceLastPractice: 0, streak: null },
      longestStreak: null,
      streaks: [],
      gaps: [],
      recoveries: [],
      openGap: null,
    };
  }

  // 切分连续段与已闭合间隔
  const streaks: ContinuityStreak[] = [];
  const gaps: ContinuityGap[] = [];
  let streakStart = 0;

  const pushStreak = (startIndex: number, endIndex: number, open: boolean) => {
    const slice = days.slice(startIndex, endIndex + 1);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (!first || !last) return;
    streaks.push({
      startDate: first.date,
      endDate: last.date,
      lengthDays: slice.length,
      practiceCount: slice.reduce((sum, day) => sum + day.practiceCount, 0),
      totalDurationMs: slice.reduce((sum, day) => sum + day.totalDurationMs, 0),
      open,
    });
  };

  for (let i = 1; i < days.length; i += 1) {
    const previousDay = days[i - 1];
    const currentDay = days[i];
    if (!previousDay || !currentDay) continue;
    const distance = daysBetween(previousDay.date, currentDay.date);
    if (distance <= 1) continue; // 相邻自然日，连续

    // 连续段在 i-1 处结束
    pushStreak(streakStart, i - 1, false);
    const missingDays = distance - 1;
    gaps.push({
      index: gaps.length,
      afterDate: previousDay.date,
      beforeDate: currentDay.date,
      missingDays,
      kind: classifyGap(missingDays, graceDays, breakAfterDays),
      status: "RECOVERED",
      recoveredAt: currentDay.date,
    });
    streakStart = i;
  }
  pushStreak(streakStart, days.length - 1, true);

  // 开放间隔（最后练习日 -> asOf）
  const trailingStreak = streaks[streaks.length - 1] ?? null;
  const daysSinceLastPractice = daysBetween(base.lastPracticeDate!, asOfDate);
  let openGap: ContinuityGap | null = null;
  if (daysSinceLastPractice >= 1) {
    openGap = {
      index: gaps.length,
      afterDate: base.lastPracticeDate!,
      beforeDate: null,
      missingDays: daysSinceLastPractice,
      kind: classifyGap(daysSinceLastPractice, graceDays, breakAfterDays),
      status: "OPEN",
      recoveredAt: null,
    };
    gaps.push(openGap);
  }

  // 每次“中断后恢复”
  const recoveries: ContinuityRecovery[] = gaps
    .filter((gap) => gap.status === "RECOVERED" && gap.kind === "INTERRUPTION")
    .map((gap) => {
      const following = streaks.find((streak) => streak.startDate === gap.beforeDate);
      return {
        resumedDate: gap.beforeDate!,
        interruptionDays: gap.missingDays,
        afterDate: gap.afterDate,
        followingStreakDays: following?.lengthDays ?? 1,
      };
    });

  // 当前状态：今天练过 ACTIVE；宽限期内 GRACE；随后 AT_RISK；达到中断阈值 BROKEN
  let status: CurrentStreakStatus;
  if (daysSinceLastPractice === 0) status = "ACTIVE";
  else if (daysSinceLastPractice <= graceDays) status = "GRACE";
  else if (daysSinceLastPractice < breakAfterDays) status = "AT_RISK";
  else status = "BROKEN";

  const longestStreak = streaks.reduce<ContinuityStreak | null>(
    (longest, streak) => (longest === null || streak.lengthDays > longest.lengthDays ? streak : longest),
    null,
  );

  return {
    ...base,
    current: { status, daysSinceLastPractice, streak: status === "BROKEN" ? null : trailingStreak },
    longestStreak,
    streaks,
    gaps,
    recoveries,
    openGap,
  };
}
