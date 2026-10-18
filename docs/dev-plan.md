# musing_jm 개발 계획서

> Front API 스펙 기준 | 작성일: 2026-10-18

---

## 1. 현재 상태 요약

API 스펙에서 요구하는 세 가지 엔드포인트(`/process`, `/cancel`, `/health`)는 **이미 구현되어 있습니다.**  
단, 현재 `buildApp()`에서 해당 라우트가 등록되지 않아 **서버가 떠도 외부에서 접근 불가**한 상태입니다.

| 구분 | 파일 | 상태 |
|------|------|------|
| 라우트 정의 | `src/server/routes/process.ts` | 완료 |
| TypeBox 스키마 | `src/server/schemas/process.ts` | 완료 |
| AgentRunner (핵심 로직) | `src/agent/agent-runner.ts` | 완료 |
| SessionStore (세션/취소) | `src/agent/session-store.ts` | 완료 |
| **앱에 라우트 등록** | `src/server/app.ts` | **누락** |
| tokens 사용량 집계 | `src/agent/agent-runner.ts` | 미구현 |
| queued 카운트 | `src/agent/session-store.ts` | 항상 0 (큐 없음) |

---

## 2. 즉시 해야 할 작업 (필수 Fix)

### 2-1. `app.ts`에 processRoutes 등록

`src/server/app.ts`의 `buildApp()` 함수에 아래 한 줄을 추가해야 합니다.

```typescript
// 추가 필요
import { processRoutes } from "./routes/process.js";

// register 부분에
await app.register(processRoutes);
```

> **주의**: 현재 `/health`가 `inquiry.ts`에도 등록되어 있어 라우트 충돌이 발생합니다.  
> `process.ts`의 `/health`는 운영 모니터링 전용이므로 `/health/agent`로 경로를 분리하거나,  
> `inquiry.ts`의 `/health`를 `/health/system`으로 이동하는 것을 권장합니다.

---

## 3. 단계별 개발 계획

### Phase 1: 라우트 연결 (즉시)

- [ ] `src/server/app.ts`에 `processRoutes` import 및 register 추가
- [ ] `/health` 라우트 경로 충돌 해소
  - `process.ts` → `GET /health` (운영용, 스펙 유지)
  - `inquiry.ts` → `GET /health/system` (시스템 상세 상태)
- [ ] Swagger 태그에 `process` 추가

### Phase 2: tokens 사용량 집계

현재 `usage.tokens` 필드가 항상 `undefined`로 반환됩니다.  
Agent SDK의 `PostToolUse` 훅 또는 메시지 스트림에서 토큰 정보를 추출해야 합니다.

- [ ] Agent SDK 메시지 스트림에서 `usage` 필드 파싱
- [ ] `AgentRunner`의 `run()` 반환값 `usage.tokens` 채우기

### Phase 3: 큐 시스템 (선택, 트래픽 증가 시)

현재 `health.queued`는 항상 `0`입니다.  
동시 요청이 많아지면 큐 기반 처리를 추가해야 합니다.

- [ ] `SessionStore`에 pending 큐 추가
- [ ] `AgentRunner`에서 동시 실행 수 제한 로직 추가
- [ ] `queuedCount` getter 실제 값 반환

### Phase 4: 회원사별 MCP 서버 분리

현재 모든 회원사가 동일한 MCP 서버 설정을 공유합니다.  
`memberId` 기반으로 Git URL / DB 접속 정보를 동적으로 분기해야 합니다.

- [ ] `config/repos.json` 패턴으로 회원사별 환경변수 매핑
- [ ] `AgentRunner.run()`에서 `memberId`로 MCP 서버 설정 결정
- [ ] 접근 권한 없는 저장소 요청 시 `failed` 반환

---

## 4. 데이터 흐름 요약

```
[Front] POST /process
  → processRoutes (라우트 핸들러)
  → AgentRunner.run()
    → SessionStore.createSession() 또는 getSession()   // sessionId 관리
    → query() 제너레이터 시작                          // Agent SDK
      → set_query_type 호출                           // type 결정
      → searchCode / readFileRange / executeQuery      // ERP MCP 도구
      → [필요 시] request_clarification               // waiting_input 분기
    → trace / references / usage 조립
  → { status, sessionId, type, answer, ... } 반환
[Front] 응답 수신
```

---

## 5. 환경변수 체크리스트

서비스 정상 동작을 위해 반드시 설정해야 하는 환경변수입니다.

| 변수 | 필수 | 설명 |
|------|------|------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API 인증 키 |
| `CLAUDE_MODEL` | 권장 | 기본값 `claude-sonnet-4-6` |
| `CLAUDE_MAX_TOOL_LOOPS` | 선택 | 기본값 10 |
| `CLAUDE_TIMEOUT_MS` | 선택 | 기본값 60000 |
| `ERP_GIT_URL` | 회원사별 | Git MCP 활성화 조건 |
| `ERP_GIT_BRANCH` | Git 사용 시 | 브랜치명 |
| `ERP_GIT_CACHE_DIR` | 선택 | 기본값 `./.cache/repos` |
| `ERP_DB_HOST` | DB 사용 시 | MariaDB 호스트 |
| `ERP_DB_NAME` | DB 사용 시 | DB명 |
| `ERP_DB_USER` | DB 사용 시 | 읽기 전용 계정 |
| `ERP_DB_PASSWORD` | DB 사용 시 | 비밀번호 |

---

## 6. 기술 부채 목록

| 항목 | 우선순위 | 비고 |
|------|---------|------|
| processRoutes 미등록 | 긴급 | Phase 1에서 즉시 처리 |
| /health 경로 충돌 | 긴급 | Phase 1에서 즉시 처리 |
| tokens 미집계 | 중간 | Front에서 표시 필요 시 |
| queued 항상 0 | 낮음 | 트래픽 증가 후 처리 |
| SessionStore 영속화 없음 | 낮음 | 서버 재시작 시 세션 소멸 |
| Mock MCP 서버들 | 중간 | member-db, knowledge-base, history |
