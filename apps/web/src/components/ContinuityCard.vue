<script setup lang="ts">
import { computed } from "vue";
import MetricCard from "./MetricCard.vue";

interface Streak { startDate: string; endDate: string; lengthDays: number; practiceDays: number }
interface Gap { kind: "gap" | "break"; fromDate: string; toDate: string; missedDays: number }
interface Resumption { date: string; previousDate: string; missedDays: number }

interface Continuity {
  days: Array<{ date: string; practiceCount: number; totalDurationMs: number; totalAnnotationCount: number }>;
  currentStreak: Streak | null;
  longestStreak: Streak | null;
  gaps: Gap[];
  breaks: Gap[];
  resumptions: Resumption[];
  state: "PRACTICED_TODAY" | "AT_RISK" | "BROKEN" | "NO_DATA";
  daysSinceLastPractice: number | null;
  practicedToday: boolean;
  totalPracticeDays: number;
  totalSessions: number;
  breakCount: number;
  resumptionCount: number;
}

const props = defineProps<{ continuity: Continuity }>();

const stateLabel = computed(() => {
  switch (props.continuity.state) {
    case "PRACTICED_TODAY":
      return "今天已练习";
    case "AT_RISK":
      return `已断 ${props.continuity.daysSinceLastPractice ?? 0} 天，尽快恢复`;
    case "BROKEN":
      return `连续已中断 ${props.continuity.daysSinceLastPractice ?? 0} 天`;
    default:
      return "暂无练习记录";
  }
});

const stateClass = computed(() => ({
  "state-ok": props.continuity.state === "PRACTICED_TODAY",
  "state-warn": props.continuity.state === "AT_RISK",
  "state-bad": props.continuity.state === "BROKEN",
}));

// 取最近一次中断后的恢复用于文案提示。
const latestResumption = computed(() => props.continuity.resumptions.at(-1) ?? null);
</script>

<template>
  <article class="card continuity-card">
    <div class="card-title">
      <h2>练习连续性</h2>
      <small>按本地自然日统计；间隔缺 1 天，连续缺 2 天及以上记为中断。时区修改不重算历史，迟到数据自动合并不重复计数。</small>
    </div>

    <div class="state-row" :class="stateClass">
      <strong>{{ stateLabel }}</strong>
      <span v-if="latestResumption">
        最近恢复：{{ latestResumption.date }}（此前中断 {{ latestResumption.missedDays }} 天）
      </span>
    </div>

    <div class="grid grid-4">
      <MetricCard
        label="当前连续"
        :value="continuity.currentStreak ? `${continuity.currentStreak.lengthDays} 天` : '—'"
        :hint="continuity.currentStreak ? `${continuity.currentStreak.practiceDays} 个练习日` : '连续已断'"
      />
      <MetricCard
        label="最长连续"
        :value="continuity.longestStreak ? `${continuity.longestStreak.lengthDays} 天` : '—'"
        :hint="continuity.longestStreak ? `${continuity.longestStreak.startDate} 起` : undefined"
      />
      <MetricCard label="中断次数" :value="`${continuity.breakCount} 次`" :hint="`${continuity.gaps.length} 次间隔`" />
      <MetricCard label="中断后恢复" :value="`${continuity.resumptionCount} 次`" :hint="`共 ${continuity.totalPracticeDays} 个练习日`" />
    </div>

    <div v-if="continuity.breaks.length" class="break-list">
      <h3>中断与恢复记录</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>上次练习</th><th>恢复练习</th><th>连续缺失</th></tr></thead>
          <tbody>
            <tr v-for="(item, index) in continuity.breaks" :key="`${item.fromDate}-${item.toDate}-${index}`">
              <td>{{ item.fromDate }}</td>
              <td>{{ item.toDate }}</td>
              <td>{{ item.missedDays }} 天</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-else class="empty"><strong>还没有发生过中断</strong><p>保持每天练习，连续缺 2 天及以上才会记为一次中断。</p></div>
  </article>
</template>

<style scoped>
.continuity-card { margin-top: 18px; }
.state-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px; margin-bottom: 16px; background: #f3f4f6; color: #374151; }
.state-row strong { font-size: 15px; }
.state-row span { font-size: 13px; }
.state-ok { background: #e7f5ee; color: #145c3d; }
.state-warn { background: #fdf2e3; color: #9a5a12; }
.state-bad { background: #fbe9e7; color: #a33a2f; }
.break-list h3 { margin: 16px 0 8px; font-size: 14px; }
</style>
