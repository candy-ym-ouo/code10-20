-- 练习连续性分析引擎：
-- 1. practice_sessions 增加完成时刻冻结的“本地自然日 + 时区”，用户后续改时区不重算历史。
-- 2. daily_practice_rollups 以 (user_id, practice_local_date) 为主键，
--    迟到/修正数据通过整日重算合并，数据库层面保证不重复计数。

-- AlterTable
ALTER TABLE "practice_sessions"
  ADD COLUMN "practice_local_date" DATE,
  ADD COLUMN "practice_local_timezone" VARCHAR(64);

-- 一次性回填历史已完成练习：用其完成时刻（UTC）在“用户当前时区”下的本地自然日冻结。
-- 新练习在完成时按“练习开始时刻”归属自然日；历史行没有可复用的统一口径，这里以完成时刻冻结，
-- 同样只冻结一次——之后用户再改时区也不会变动。
UPDATE "practice_sessions" s
SET
  "practice_local_date" = (s."completed_at" AT TIME ZONE u."timezone")::date,
  "practice_local_timezone" = u."timezone"
FROM "users" u
WHERE s."user_id" = u."id"
  AND s."status" = 'COMPLETED'
  AND s."completed_at" IS NOT NULL;

-- CreateTable
CREATE TABLE "daily_practice_rollups" (
    "user_id" UUID NOT NULL,
    "practice_local_date" DATE NOT NULL,
    "practice_count" INTEGER NOT NULL,
    "total_duration_ms" BIGINT NOT NULL DEFAULT 0,
    "annotation_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_practice_rollups_pkey" PRIMARY KEY ("user_id", "practice_local_date")
);

-- 一次性从已完成练习构建日汇总：以冻结本地日期分组，场次/时长/标记都按组聚合。
INSERT INTO "daily_practice_rollups"
  ("user_id", "practice_local_date", "practice_count", "total_duration_ms", "annotation_count", "updated_at")
WITH completed AS (
  SELECT
    s."id",
    s."user_id",
    s."practice_local_date" AS local_date,
    s."actual_duration_ms",
    (SELECT COUNT(*) FROM "annotations" a WHERE a."session_id" = s."id")::int AS annotation_count
  FROM "practice_sessions" s
  WHERE s."status" = 'COMPLETED'
    AND s."practice_local_date" IS NOT NULL
)
SELECT
  "user_id",
  "local_date",
  COUNT(*)::int,
  COALESCE(SUM("actual_duration_ms"), 0)::bigint,
  COALESCE(SUM("annotation_count"), 0)::int,
  CURRENT_TIMESTAMP
FROM completed
GROUP BY "user_id", "local_date"
ON CONFLICT ("user_id", "practice_local_date") DO NOTHING;

-- Index
CREATE INDEX "daily_practice_rollups_user_date_idx"
  ON "daily_practice_rollups" ("user_id", "practice_local_date" DESC);

CREATE INDEX "practice_sessions_user_local_date_idx"
  ON "practice_sessions" ("user_id", "practice_local_date");

-- ForeignKey
ALTER TABLE "daily_practice_rollups"
  ADD CONSTRAINT "daily_practice_rollups_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

