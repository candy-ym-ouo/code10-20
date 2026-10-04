-- 连续性分析：练习完成时冻结归属的本地自然日，时区变更不重算历史
ALTER TABLE "practice_sessions"
  ADD COLUMN "local_practice_date" DATE,
  ADD COLUMN "practice_timezone" VARCHAR(64);

CREATE INDEX "practice_sessions_user_id_local_practice_date_idx"
  ON "practice_sessions"("user_id", "local_practice_date");
