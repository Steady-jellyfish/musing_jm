# 토큰 스트리밍 구현 방식

> `token` SSE 이벤트로 Claude 답변을 글자 단위로 실시간 전달하는 방법

---

## 1. 왜 토큰 스트리밍인가

기존 방식은 Claude가 답변을 완성할 때까지 기다렸다가 `done` 이벤트 하나로 전체 텍스트를 전달했습니다.
답변이 길수록 클라이언트는 오랜 시간 빈 화면을 보게 됩니다.

토큰 스트리밍은 Claude가 텍스트를 생성하는 즉시 조각(토큰)을 SSE로 흘려보내므로,
클라이언트가 ChatGPT처럼 글자가 타이핑되는 UX를 구현할 수 있습니다.

---

## 2. SSE 이벤트 흐름

```
connected          → 세션 연결 확인
  │
  ├─ trace         → 도구 호출 진행 상황 (Git 탐색, DB 조회 등)
  │   ...
  │
  ├─ token         ← NEW: Claude가 텍스트를 생성할 때마다 즉시 전달
  ├─ token
  ├─ token
  │   ...
  │
  └─ done          → 메타데이터 (references, usage). answer = 모든 token 합산
```

### 이벤트 페이로드

```
event: token
data: {"text":"안녕하세요"}

event: token
data: {"text":", PKG_SU_CALC"}

event: token
data: {"text":" 패키지는"}

...

event: done
data: {
  "answer": "안녕하세요, PKG_SU_CALC 패키지는...",  ← 전체 누적 텍스트
  "references": [...],
  "usage": {"elapsedMs": 3200, "tokens": 410}
}
```

> `done.answer`는 모든 `token.text`를 순서대로 이어 붙인 값과 동일합니다.
> 토큰 스트리밍 클라이언트는 `done.answer`를 무시하고 직접 누적해도 됩니다.

---

## 3. 구현 위치

**파일:** `src/agent/agent-runner.ts`  
**클래스:** `AgentRunner.runStream()`  
**위치:** 에이전트 백그라운드 실행 → `for await (const message of agentGen)` 루프 내부

---

## 4. 3단계 우선순위 로직

Agent SDK가 어떤 형태로 메시지를 노출하느냐에 따라 세 가지 경로로 토큰을 수집합니다.

### 4-1. [1순위] `content_block_delta` — 토큰 단위 실시간 스트리밍

Claude API의 스트리밍 SSE 이벤트가 Agent SDK를 통해 그대로 노출될 때 동작합니다.
이 경로가 활성화되면 가장 세밀한 토큰 단위(보통 1~5 글자)로 실시간 전달됩니다.

```typescript
if (msg.type === "content_block_delta") {
  const delta = msg.delta as Record<string, unknown> | undefined;
  if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
    finalAnswer += delta.text;
    hasStreamedTokens = true;
    push({ event: "token", data: { text: delta.text } });
  }
}
```

**원리:**  
Anthropic API를 스트리밍 모드로 호출하면 서버에서 `content_block_delta` 이벤트를 차례로 전송합니다.
Agent SDK 내부에서 이를 async generator로 감싸 그대로 노출하면 각 delta를 즉시 `token` 이벤트로 변환합니다.

### 4-2. [2순위] `assistant` 완성 메시지 — 블록 단위 fallback

Agent SDK가 스트리밍 이벤트를 노출하지 않고 완성된 assistant 메시지를 한 번에 줄 때 동작합니다.
이 경우 텍스트 블록 전체를 하나의 `token` 이벤트로 emit합니다.

```typescript
if (msg.type === "assistant" && !hasStreamedTokens) {
  const assistantMsg = msg.message as
    | { content?: Array<{ type: string; text?: string }> }
    | undefined;
  if (assistantMsg?.content) {
    for (const block of assistantMsg.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        finalAnswer += block.text;
        hasStreamedTokens = true;
        push({ event: "token", data: { text: block.text } });
      }
    }
  }
}
```

### 4-3. [3순위] `result` 필드 — 최종 fallback

위 두 경로 모두에서 텍스트를 얻지 못했을 때만 사용합니다.
SDK가 최종 결과만 `result` 필드에 담아 반환하는 경우입니다.

```typescript
if ("result" in msg) {
  if (!hasStreamedTokens) {
    finalAnswer = String(msg.result);
    if (finalAnswer) {
      hasStreamedTokens = true;
      push({ event: "token", data: { text: finalAnswer } });
    }
  } else if (!finalAnswer) {
    finalAnswer = String(msg.result);  // 보정용
  }
}
```

---

## 5. `hasStreamedTokens` 플래그

세 경로 간 중복 emit을 막는 가드입니다.

| 상태 | 의미 |
|------|------|
| `false` | 아직 토큰을 emit하지 않음 → 2순위·3순위 경로 허용 |
| `true` | 이미 토큰을 emit 중 → 2순위·3순위 건너뜀 |

`content_block_delta`가 한 번이라도 도착하면 `true`로 설정되고, 이후 `assistant`나 `result` 메시지가 오더라도 추가 emit하지 않습니다.

---

## 6. `done` 이벤트와의 관계

`token` 이벤트가 도입된 후에도 `done` 이벤트는 그대로 유지됩니다.

| 필드 | 설명 |
|------|------|
| `done.answer` | 모든 token.text의 합산 (클라이언트가 직접 누적한 값과 동일) |
| `done.references` | 코드·DB 참조 목록 |
| `done.usage` | 경과 시간, 토큰 수, 파일 읽기 횟수, DB 조회 횟수 |

토큰 스트리밍 클라이언트는 `done.answer`를 화면 렌더링에 사용할 필요가 없지만,
스트리밍을 지원하지 않는 클라이언트는 `done.answer`만으로 답변을 얻을 수 있습니다.

---

## 7. 클라이언트 구현 예시

### JavaScript (EventSource)

```javascript
const es = new EventSource("/process"); // POST는 fetch + ReadableStream 사용

// 실제 POST 요청 시 fetch 사용
const response = await fetch("/process", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question, memberId, requestId }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let accumulatedAnswer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const data = JSON.parse(line.slice(6));

      if (currentEvent === "token") {
        accumulatedAnswer += data.text;
        renderText(data.text);           // 화면에 즉시 추가
      } else if (currentEvent === "trace") {
        showProgress(data.label);        // 진행 상황 표시
      } else if (currentEvent === "done") {
        showReferences(data.references); // 참조 표시
        showUsage(data.usage);           // 사용량 표시
      }
    }
  }
}
```

### React 예시 (핵심 부분)

```tsx
const [answer, setAnswer] = useState("");

// token 이벤트 수신 시
onToken(({ text }) => {
  setAnswer(prev => prev + text); // 글자가 하나씩 추가되는 효과
});
```

---

## 8. 흐름 다이어그램

```
Claude API (스트리밍)
    │
    │  content_block_delta {type:"text_delta", text:"안녕"}
    │  content_block_delta {type:"text_delta", text:"하세요"}
    │  content_block_delta {type:"text_delta", text:", 이"}
    │  ...
    ▼
Agent SDK query() generator
    │  for await (const message of agentGen)
    │
    ├─ msg.type === "content_block_delta" → push token "안녕"
    ├─ msg.type === "content_block_delta" → push token "하세요"
    ├─ msg.type === "content_block_delta" → push token ", 이"
    │  ...
    └─ msg.result 도착 → hasStreamedTokens=true이므로 token emit 생략
         → push done { answer: "안녕하세요, 이..." }
    │
    ▼
SSE 이벤트 큐 (push/yield 브릿지)
    │
    ▼
클라이언트
    event: token  data: {"text":"안녕"}
    event: token  data: {"text":"하세요"}
    event: token  data: {"text":", 이"}
    ...
    event: done   data: {"answer":"안녕하세요, 이...","references":[...],"usage":{...}}
```

---

## 9. 관련 파일

| 파일 | 역할 |
|------|------|
| `src/agent/agent-runner.ts` | 토큰 스트리밍 핵심 로직 (`SseEvent`, `runStream`, for-await 루프) |
| `src/server/routes/process.ts` | SSE 헤더 설정, `writeEvent` 헬퍼, Swagger 문서 |
| `src/server/schemas/process.ts` | TypeBox 스키마 (SSE 이벤트 타입 정의) |

---

*최초 작성: 2026-11-04*
