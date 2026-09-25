/**
 * 저장소 동기화 상태 변경 알림 훅
 *
 * 현재는 stderr 로그만 출력합니다.
 * Slack, PagerDuty, 이메일 등 외부 알림 연동은 이 파일에 추가합니다.
 *
 * 호출 시점:
 * - sync_failed  : synced → stale (최신화 실패, 기존 캐시 사용) 또는 → missing (캐시 없음)
 * - sync_recovered: stale/missing → synced (동기화 복구)
 *
 * 저장소 상태가 실제로 바뀔 때만 한 번 호출됩니다 (요청마다 호출하지 않음).
 */

export type NotifyEvent = "sync_failed" | "sync_recovered";

export async function notify(
  event: NotifyEvent,
  details: Record<string, unknown>
): Promise<void> {
  const level = event === "sync_failed" ? "WARN" : "INFO";
  process.stderr.write(
    `${level} [notify] ${event}: ${JSON.stringify(details)}\n`
  );

  // TODO: 외부 알림 연동 예시 (환경변수로 활성화)
  // if (process.env.SLACK_WEBHOOK_URL) {
  //   await fetch(process.env.SLACK_WEBHOOK_URL, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({ text: `[musing_jm] ${event}: ${JSON.stringify(details)}` }),
  //   });
  // }
}
