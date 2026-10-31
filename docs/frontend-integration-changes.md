# 프론트 연동 변경 사항 — 2026-11-01

변경: `src/agent/agent-runner.ts`, `src/server/routes/process.ts`

---

## 1. 응답 방식 — HTTP → SSE 스트림

`POST /process` 가 단일 JSON 대신 **SSE 스트림**으로 응답합니다.  
`EventSource`는 GET 전용이므로 **`fetch` + ReadableStream** 으로 수신해야 합니다.

---

## 2. SSE 이벤트 종류

| event | data |
|-------|------|
| `connected` | `{ sessionId }` |
| `trace` | `{ label, detail?, elapsedMs }` |
| `clarification` | `{ questions, type? }` |
| `done` | `{ answer, references, type, usage }` |
| `error` | `{ sessionId, error }` |

---

## 3. 채팅 연속 대화 — sessionId 재사용

```
1번: { question, memberId, requestId }
     → connected 에서 sessionId 수신 저장

2번: { question, memberId, requestId, sessionId }

되묻기: { ..., sessionId, answers: {"질문": "선택라벨"} }
```

> `requestId` 요청마다 다른 값 필수 (중복 시 차단)

---

## 4. 프론트 구현 예시

```javascript
const res = await fetch('/process', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ question, memberId, requestId, sessionId })
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '', ev = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  for (const line of buf.split('\n')) {
    if (line.startsWith('event:')) ev = line.slice(6).trim();
    if (line.startsWith('data:')) {
      const d = JSON.parse(line.slice(5).trim());
      if (ev === 'connected')  saveSessionId(d.sessionId);
      if (ev === 'trace')      showProgress(d.label);
      if (ev === 'done')       showAnswer(d.answer);
      if (ev === 'clarification') showClarification(d.questions);
      if (ev === 'error')      showError(d.error);
    }
  }
  buf = buf.split('\n').pop();
}
```

---

## 5. 취소

```javascript
fetch('/cancel', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId })
});
```

`/cancel` · `/health` · `/api/v1/inquiry` 변경 없음.
