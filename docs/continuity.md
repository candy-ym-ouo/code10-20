# 练习连续性分析引擎

连续性回答三个问题：**间隔（gap）**、**中断（break）** 和 **恢复（resumption）**。
本文件是连续性的口径权威，接口字段与数据库设计都以它为准。

## 1. 本地自然日

- 一切连续性判断都落在用户的**本地自然日**（`YYYY-MM-DD`，IANA 时区，如 `Asia/Shanghai`），
  不使用 UTC 日，也不使用“最近 24 小时”这类滑动窗口。
- 一场练习归属到它**开始时刻**所在的本地自然日：晚上 23:50 开始、跨过午夜的练习算当天。
- UTC 绝对时刻到本地日的换算由纯函数 `localDateKey(instant, timezone)` 完成，
  内部用 `Intl.DateTimeFormat("en-CA", …)` 取日期，自动正确处理夏令时。

## 2. 时区变更不重算历史

- 练习在“完成复盘”的那一刻，用用户**当时的时区**冻结两列：
  `practice_local_date`（DATE）与 `practice_local_timezone`（VARCHAR）。
- 冻结后这两列不再随用户设置变化。用户之后改成别的时区：
  - 历史练习仍归在冻结的本地日，**连续性历史不重算**；
  - 只有新完成的练习按新时区冻结。
- 迁移前的历史已完成练习由数据迁移一次性冻结（用各用户当前时区），此后同样不可变。
  纯引擎在 `localDate` 缺失时才用 `startedAt + 回退时区` 即时计算，仅作为理论兜底。

## 3. 迟到数据合并不重复计数

两条防线：

1. **领域层（纯函数）**：事件按 `sessionId` 幂等去重。
   - 同一自然日多场不同练习：合并成一个练习日，场次计数为 N。
   - 同一场练习迟到重放：先移除旧快照再写入，永远只计一次。
   - 迟到的版本更旧时（`version` 更小）直接忽略；版本相同或更新才替换。
   - 迟到修正把练习从一天挪到另一天时，旧日剔除、新日加入，两天都不会重复。
2. **持久层（日汇总）**：`daily_practice_rollups` 以 `(user_id, practice_local_date)` 为主键。
   - 完成、归档、恢复、删除都调用“整日重算”：以该日剩余的 `COMPLETED` 练习为唯一事实来源，
     重新 `upsert`（该日无练习则删除汇总行）。
   - 因此完成请求重放、删除任务重试、迟到归档等，重复执行结果都一致（幂等）。

## 4. 间隔、中断、恢复与连续

给定按本地日升序的练习日序列，对相邻两个练习日：

- `missedDays = 后一个练习日 - 前一个练习日 - 1`
- `missedDays === 0`：连续；
- `1 <= missedDays < breakThresholdDays`：**间隔 gap**（默认阈值 2，即缺 1 天）；
- `missedDays >= breakThresholdDays`：**中断 break**（默认缺 2 天及以上）；
- 每个中断后的**第一个练习日**记一次**恢复 resumption**。

连续打卡（streak）：

- 默认 `graceDays = 0`，严格按自然日，缺一天即断签；
- `graceDays > 0` 时，缺失天数不超过宽限的相邻练习日仍算同一段连续；
- `longestStreak` 是历史最长的一段（含已结束的）；
- `currentStreak` 只在它仍“活着”时返回，否则为 `null`。

当前状态（需要 `today`，由调用方按用户当前时区传入）：

| 距最近练习日 | state |
|---|---|
| 最近练习就是今天 | `PRACTICED_TODAY` |
| 相差 1 ~ `graceDays + 1` 天 | `AT_RISK` |
| 超过 `graceDays + 1` 天 | `BROKEN`，`currentStreak` 置空 |
| 一条练习都没有 | `NO_DATA` |

## 5. 接口

`GET /api/v1/statistics/continuity`

Query：

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `timezone` | 否 | `Asia/Shanghai` | IANA 时区，只用于换算区间端点和“今天”，不改写冻结历史 |
| `from` / `to` | 否 | 全部历史 | ISO 时间，内部换算为本地自然日端点 |
| `instrument` | 否 | 全部 | 按乐器过滤（该路径从练习源表实时按日合并） |
| `breakThresholdDays` | 否 | `2` | 间隔/中断阈值（连续缺失天数 >= 该值为中断） |
| `graceDays` | 否 | `0` | 连续打卡宽限缺失天数 |

响应在引擎 `ContinuityReport` 基础上附加 `timezone` 与 `generatedAt`，
包含：`days`、`currentStreak`、`longestStreak`、`gaps`、`breaks`、`resumptions`、
`state`、`daysSinceLastPractice`、`practicedToday`、各项总计、`breakCount`、`resumptionCount`。

## 6. 代码位置

- 纯引擎与口径：`packages/contracts/src/continuity.ts`（无 I/O，含完整单测）。
- 请求约束：`continuityQuerySchema`（`packages/contracts/src/index.ts`）。
- 冻结 / 日汇总重算 / 读路径：`apps/api/src/services/continuity-service.ts`。
- 完成、归档、恢复时维护日汇总：`apps/api/src/services/session-service.ts`。
- 硬删练习后维护日汇总：`apps/worker/src/lib/rollup.ts`。
- 表结构与回填：`apps/api/prisma/schema.prisma`、`prisma/migrations/202610040001_continuity_rollup/`。
