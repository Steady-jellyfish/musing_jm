# 구현 내용 및 테스트 가이드

> 변경 이력: 2026-10-18 — Phase 1 (라우트 연결) 완료

---

## 1. 이번에 변경한 내용

### 변경 파일 3개

#### `src/server/app.ts` — processRoutes 등록 + 태그 추가

```diff
+ import { processRoutes } from "./routes/process.js";

  tags: [
+   { name: "process", description: "질의 처리 (Front API 스펙)" },
    { name: "inquiry", ... },
    { name: "system", ... },
  ]

- await app.register(inquiryRoutes);
+ await app.register(processRoutes);   // POST /process, POST /cancel, GET /health
+ await app.register(inquiryRoutes);   // GET /health/system, POST /api/v1/inquiry
```

#### `src/server/routes/inquiry.ts` — /health 경로 충돌 해소

```diff
- app.get("/health", ...)
+ app.get("/health/system", ...)
```

**이유**: `process.ts`와 `inquiry.ts` 양쪽에 `GET /health`가 있어 Fastify가 라우트 중복 오류를 내는 것을 방지합니다.  
Front API 스펙에서 `/health`는 운영 모니터링(running/queued)용으로 정의되어 있으므로 `process.ts`가 가져가고,  
MCP+Git 상세 상태는 `/health/system`으로 분리했습니다.

---

## 2. 현재 활성화된 엔드포인트 전체 목록

| 메서드 | 경로 | 설명 | 스펙 출처 |
|--------|------|------|---------|
| `POST` | `/process` | 질의 처리 (Agent SDK) | Front API 스펙 |
| `POST` | `/cancel` | 요청 취소 | Front API 스펙 |
| `GET` | `/health` | 운영 모니터링 (running/queued) | Front API 스펙 |
| `POST` | `/api/v1/inquiry` | 문의 처리 (Orchestrator) | 내부 Gateway 스펙 |
| `GET` | `/health/system` | MCP + Git 상태 상세 | 내부 운영용 |
| `GET` | `/docs` | Swagger UI | 자동 생성 |

---

## 3. 테스트 방법

### 사전 준비

```bash
# 의존성 설치 (최초 1회)
npm install

# .env 파일 생성 (ANTHROPIC_API_KEY 최소 필요)
cp .env.example .env
# .env 파일에서 ANTHROPIC_API_KEY 값 입력
```

### 서버 실행

```bash
npm run dev
```

정상 기동 시 출력:
```
INFO [server] musing_jm API listening at http://localhost:3000
INFO [server] Swagger UI: http://localhost:3000/docs
```

---

### 테스트 A: 상태 확인 (가장 먼저)

```bash
# 운영 모니터링 (Front API 스펙)
curl http://localhost:3000/health
```
기대 응답:
```json
{ "ok": true, "running": 0, "queued": 0 }
```

```bash
# MCP + Git 상세 상태
curl http://localhost:3000/health/system
```
기대 응답:
```json
{
  "status": "ok",
  "timestamp": "2026-10-18T...",
  "mcp": [...],
  "repos": [...]
}
```

---

### 테스트 B: 질의 처리 (`/process`)

#### B-1. 기본 질의 (첫 요청, sessionId 없음)

```bash
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{
    "question": "지사수수료계가 0원입니다. 왜 그런가요?",
    "memberId": "hll",
    "requestId": "test-req-001"
  }'
```

**응답 예시 (status: done)**:
```json
{
  "status": "done",
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "type": "ERROR_CAUSE",
  "answer": "...",
  "references": [...],
  "trace": [...],
  "usage": { "elapsedMs": 12000, "filesRead": 3, "dbQueries": 2 }
}
```

응답에서 `sessionId`를 저장해두세요. 후속 요청에 사용합니다.

#### B-2. 되묻기 응답 (`waiting_input` → 재요청)

`status: waiting_input`을 받은 경우:
```json
{
  "status": "waiting_input",
  "sessionId": "f47ac10b-...",
  "questions": [{
    "question": "어느 기준으로 조회한 결과인가요?",
    "options": [
      { "label": "지사 소계", "description": "..." },
      { "label": "개인별 내역", "description": "..." }
    ],
    "multiSelect": false
  }]
}
```

재요청 (새 requestId, 기존 sessionId 포함):
```bash
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{
    "question": "지사수수료계가 0원입니다. 왜 그런가요?",
    "memberId": "hll",
    "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "requestId": "test-req-002",
    "answers": {
      "어느 기준으로 조회한 결과인가요?": "지사 소계"
    }
  }'
```

#### B-3. 병렬 요청 테스트 (세션 분리 확인)

터미널 2개에서 동시에 실행:
```bash
# 터미널 1
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{"question": "PKG_SU_CALC 로직을 설명해주세요", "memberId": "hll", "requestId": "parallel-001"}'

# 터미널 2 (동시에)
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{"question": "지사수수료 계산 기준이 뭔가요?", "memberId": "hll", "requestId": "parallel-002"}'
```

두 응답의 `sessionId`가 다르면 세션 분리 정상입니다.

---

### 테스트 C: 취소 (`/cancel`)

```bash
# 1. 처리 시간이 긴 요청 실행 (백그라운드)
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{"question": "전체 수수료 계산 로직을 모두 설명해주세요", "memberId": "hll", "requestId": "cancel-test-001"}' &

# 2. 바로 취소
curl -X POST http://localhost:3000/cancel \
  -H "Content-Type: application/json" \
  -d '{"requestId": "cancel-test-001"}'
```

기대 응답:
```json
{ "canceled": true }
```

이미 완료된 요청 취소 시:
```json
{ "canceled": false }
```

---

### 테스트 D: Swagger UI (브라우저)

`http://localhost:3000/docs` 접속 후:
1. **process** 태그 — `/process`, `/cancel`, `/health` 확인
2. **system** 태그 — `/health/system` 확인
3. Try it out 버튼으로 인터랙티브 테스트 가능

---

## 4. 환경변수별 동작 차이

| 환경변수 | 없을 때 | 있을 때 |
|---------|--------|--------|
| `ANTHROPIC_API_KEY` | 서버 기동 시 오류 | Claude 호출 정상 |
| `ERP_GIT_URL` | Git MCP 서버 미연결 (코드 탐색 불가) | Git MCP 서버 자동 연결 |
| `ERP_DB_HOST` + `ERP_DB_NAME` + `ERP_DB_USER` | DB MCP 서버 미연결 (DB 조회 불가) | DB MCP 서버 자동 연결 |
| `USE_MOCK_CONTEXT` = `true` | — | 시스템 프롬프트에 Mock 데이터 주입 (개발 테스트용) |
| `ENABLE_SANDBOX` = `true` | — | `GET /pompompurin` 라우트 활성화 |

**MCP 서버 없이 테스트 시**: Claude가 답변을 생성하려 하지만 코드/DB 근거를 찾지 못해 "근거를 찾을 수 없습니다" 형태로 응답합니다. API 자체는 정상 동작합니다.

---

## 5. 에러 패턴 및 해결 방법

| 증상 | 원인 | 해결 |
|------|------|------|
| `Cannot POST /process` | processRoutes 미등록 (수정 전 상태) | `app.ts` 수정 완료로 해결됨 |
| `FST_ERR_DUPLICATED_ROUTE` | /health 경로 중복 | inquiry.ts `/health/system` 변경으로 해결됨 |
| `status: failed`, error: "동일한 requestId..." | 같은 requestId 재사용 | 재요청 시 새 requestId 생성 |
| `status: failed`, error: "세션을 찾을 수 없습니다" | sessionId 오기입 또는 서버 재시작 | 새 요청(sessionId 없이) 시작 |
| `ANTHROPIC_API_KEY` 관련 오류 | .env 미설정 | .env에 키 입력 |

---

## 6. 남은 작업 (Phase 2~4)

| 항목 | 우선순위 | 내용 |
|------|---------|------|
| `usage.tokens` 집계 | 중간 | Agent SDK 스트림에서 토큰 파싱 |
| 큐 시스템 | 낮음 | 동시 요청 N개 제한, `queued` 실제 값 |
| 회원사별 MCP 분기 | 높음 | `memberId`로 Git URL / DB 접속 정보 결정 |
| SessionStore TTL | 낮음 | 오래된 세션 자동 정리 |
| Mock MCP 서버 실제 연결 | 중간 | member-db, knowledge-base, history |
