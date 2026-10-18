# API 설명 및 프로젝트 수정 가이드

> 각 API의 역할, 현재 구현 상태, 그리고 동작하도록 수정해야 할 사항을 정리합니다.

---

## 1. `/process` — 질의 처리 API

### 무슨 역할인가

사용자의 자연어 질문을 받아 ERP 코드베이스(Git 저장소)와 DB를 분석하고 답변을 반환합니다.  
내부적으로 Claude Agent SDK가 여러 MCP 도구를 조합하며 분석합니다.

**처리 흐름:**
1. 질의 유형 판별 (`LOGIC_REVIEW` | `ERROR_CAUSE`)
2. ERP Git 저장소 탐색 (`searchCode`, `readFileRange`)
3. ERP DB 조회 (`describeTable`, `executeQuery`)
4. 정보가 부족하면 사용자에게 되묻기 (`waiting_input`)
5. 최종 답변 반환 (`done`)

**세 가지 응답 상태:**

| status | 의미 | Front 동작 |
|--------|------|----------|
| `done` | 분석 완료, 답변 있음 | `answer` 표시 |
| `waiting_input` | 질문 모호, 추가 입력 요청 | `questions`로 선택 UI 표시 후 재요청 |
| `failed` | 분석 실패 (타임아웃, 저장소 오류 등) | `error` 표시 |

---

### 현재 구현 상태

| 항목 | 파일 | 상태 | 비고 |
|------|------|------|------|
| 라우트 핸들러 | `src/server/routes/process.ts` | 완료 | |
| TypeBox 스키마 | `src/server/schemas/process.ts` | 완료 | |
| AgentRunner 핵심 로직 | `src/agent/agent-runner.ts` | 완료 | |
| 세션 관리 | `src/agent/session-store.ts` | 완료 | |
| 질의 유형 판별 | `set_query_type` 커스텀 도구 | 완료 | |
| 되묻기 | `request_clarification` 커스텀 도구 | 완료 | |
| references 추적 | AgentRunner 내 Hook | 완료 | |
| trace 조립 | AgentRunner 내부 | 완료 | |
| `usage.tokens` 집계 | — | **미구현** | Agent SDK에서 추출 필요 |
| **앱 등록** | `src/server/app.ts` | **누락** | 아래 수정 필요 |

---

### 수정 사항 1: `app.ts`에 라우트 등록 (필수)

**파일**: `src/server/app.ts`

현재 `buildApp()`에 `processRoutes`가 등록되어 있지 않아 `/process`, `/cancel`, `/health`가 동작하지 않습니다.

```typescript
// 현재 (src/server/app.ts)
import { inquiryRoutes } from "./routes/inquiry.js";

// 변경 후
import { inquiryRoutes } from "./routes/inquiry.js";
import { processRoutes } from "./routes/process.js";   // ← 추가

// register 부분에
await app.register(inquiryRoutes);
await app.register(processRoutes);   // ← 추가
```

---

### 수정 사항 2: `/health` 경로 충돌 해소 (필수)

현재 두 라우트 파일 모두 `GET /health`를 등록합니다.

| 라우트 파일 | 경로 | 목적 |
|------------|------|------|
| `inquiry.ts` | `GET /health` | MCP 연결 상태 + Git 동기화 상태 (상세) |
| `process.ts` | `GET /health` | running/queued 건수 (스펙 정의, 운영 모니터링) |

Fastify는 중복 경로 등록 시 오류를 발생시킵니다.  
아래와 같이 경로를 분리하는 것을 권장합니다.

**방법 A: inquiry 경로를 변경 (권장)**

`src/server/routes/inquiry.ts`에서:
```typescript
// 변경 전
app.get("/health", ...)

// 변경 후
app.get("/health/system", ...)
```

**방법 B: prefix로 분리**

`src/server/app.ts`에서:
```typescript
await app.register(inquiryRoutes, { prefix: "/system" });
await app.register(processRoutes);
// GET /health → process (스펙)
// GET /system/health → inquiry (상세)
```

---

### 수정 사항 3: `usage.tokens` 집계 (선택, 중간 우선순위)

**파일**: `src/agent/agent-runner.ts`

현재 `usage.tokens`는 항상 `undefined`로 반환됩니다.  
Agent SDK 메시지 스트림에서 `usage` 필드를 파싱해야 합니다.

```typescript
// agent-runner.ts의 for await 루프 내 추가
let totalInputTokens = 0;
let totalOutputTokens = 0;

for await (const message of gen) {
  // 기존 코드 ...

  // usage 추출 (Agent SDK 메시지에 usage 포함 시)
  if (message && typeof message === "object" && "usage" in message) {
    const u = (message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    if (u) {
      totalInputTokens += u.input_tokens ?? 0;
      totalOutputTokens += u.output_tokens ?? 0;
    }
  }
}

// 반환 시
usage: {
  elapsedMs: totalElapsed,
  tokens: totalInputTokens + totalOutputTokens,  // ← 추가
  filesRead,
  dbQueries,
},
```

---

### Swagger 태그 추가 (선택)

`src/server/app.ts`의 tags 배열에 `process` 추가:

```typescript
tags: [
  { name: "inquiry", description: "문의 처리 엔드포인트" },
  { name: "process", description: "질의 처리 (Agent SDK)" },   // ← 추가
  { name: "system", description: "시스템 상태" },
  { name: "sandbox", description: "과제용 sandbox 엔드포인트" },
],
```

---

## 2. `/cancel` — 요청 취소 API

### 무슨 역할인가

실행 중인 `/process` 요청을 `requestId`로 식별해 취소합니다.  
취소는 Agent SDK의 AsyncGenerator에 `.return()`을 호출해 즉시 중단합니다.

**핵심 동작:**
- 동일 `requestId`로 여러 번 취소 요청 → 첫 번째만 `canceled: true`, 이후는 `false`
- 이미 완료된 요청의 취소 → `canceled: false` (정상 응답)
- 존재하지 않는 `requestId` → `canceled: false`

---

### 현재 구현 상태

| 항목 | 상태 | 비고 |
|------|------|------|
| 라우트 핸들러 | 완료 | `src/server/routes/process.ts` |
| 취소 로직 | 완료 | `SessionStore.cancelRequest()` |
| `sessionId` 필드 | 스펙 있음, 로직 미사용 | 현재 서버는 `requestId`만으로 취소 |
| **앱 등록** | **누락** | `app.ts` 수정 필요 (위 1번과 동일) |

---

### 수정 사항

`/process`와 동일하게 `app.ts`에 `processRoutes`를 등록하면 자동 해결됩니다.  
별도 수정 없음.

---

## 3. `/health` — 상태 확인 API

### 무슨 역할인가

현재 처리 중(`running`)이거나 대기 중(`queued`)인 `/process` 요청 수를 반환합니다.  
운영팀이 서버 부하를 실시간으로 모니터링하기 위한 엔드포인트입니다.

**반환 값:**
```json
{
  "ok": true,
  "running": 2,
  "queued": 0
}
```

- `ok`: 서버 정상 여부 (현재 항상 `true`)
- `running`: 현재 Agent SDK가 분석 중인 요청 수
- `queued`: 처리 대기 중인 요청 수 (현재 큐 없으므로 항상 `0`)

---

### 현재 구현 상태

| 항목 | 상태 | 비고 |
|------|------|------|
| 라우트 핸들러 | 완료 | `GET /health` in `process.ts` |
| `running` 집계 | 완료 | `SessionStore.runningCount` |
| `queued` 집계 | 부분 완료 | 항상 `0` (큐 미구현) |
| **앱 등록** | **누락** | `app.ts` 수정 필요 |

---

### 수정 사항

`app.ts` 등록 및 `/health` 경로 충돌 해소 (위 1번 참조).  
`queued`는 동시 요청이 많아지면 구현 필요 (현재는 무제한 동시 처리).

---

## 4. 전체 수정 체크리스트

```
[ ] src/server/app.ts
    - processRoutes import 추가
    - app.register(processRoutes) 추가
    - Swagger tags에 "process" 추가

[ ] src/server/routes/inquiry.ts
    - GET /health → GET /health/system 로 경로 변경
    (또는 app.ts에서 prefix로 분리)

[ ] src/agent/agent-runner.ts (선택)
    - for await 루프에서 usage.tokens 파싱 추가
    - 반환값 usage.tokens 채우기
```

---

## 5. 수정 후 동작 검증

라우트 등록 후 아래 명령으로 동작을 확인합니다.

```bash
# 서버 실행
npm run dev

# health 확인
curl http://localhost:3000/health

# process 요청
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{"question":"지사수수료계가 0원입니다","memberId":"hll","requestId":"test-001"}'

# cancel 요청
curl -X POST http://localhost:3000/cancel \
  -H "Content-Type: application/json" \
  -d '{"requestId":"test-001"}'

# Swagger UI
open http://localhost:3000/docs
```

---

## 6. 내부 도구 흐름 (참고)

Agent가 분석 시 사용하는 도구와 그 결과가 응답에 매핑되는 방식입니다.

| Agent 도구 | 역할 | 응답 반영 |
|-----------|------|---------|
| `set_query_type` | 질의 유형 선언 | `type` 필드 |
| `request_clarification` | 추가 정보 요청 | `status: waiting_input` + `questions` |
| `searchCode` | 코드 키워드 탐색 | `trace.저장소 탐색` |
| `readFileRange` | 파일 내용 읽기 | `references[].locator` (path:line), `usage.filesRead` |
| `listTables` / `describeTable` | DB 구조 파악 | `trace.DB 조회` |
| `executeQuery` | SELECT 쿼리 실행 | `references[].locator` (테이블명), `usage.dbQueries` |
