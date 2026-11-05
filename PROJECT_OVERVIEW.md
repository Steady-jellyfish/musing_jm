# musing_sonar — 프로젝트 전체 구조 및 동작 흐름

> 한화라이프랩 ERP 시스템의 **로직·사유 확인 문의를 처리하는 AI 미들웨어 백엔드**

---

## 1. 프로젝트 개요

**musing_sonar**은 사용자의 자연어 질문을 받아서 Claude AI가 ERP Git 저장소와 MariaDB를 직접 조회하고, 근거 있는 답변을 생성하는 오케스트레이션 서버입니다.

### 핵심 가치

- **근거 기반 답변** — 추측 없이 실제 코드/DB 조회 결과만 인용
- **보안 우선** — 읽기 전용, PII 마스킹, 경로 순회(path traversal) 차단
- **실시간 스트림** — SSE로 분석 진행 상황을 실시간으로 클라이언트에 전달
- **멀티턴 대화** — 세션 기반으로 이전 맥락을 유지하며 연속 질문 가능

### 기술 스택

| 영역 | 기술 |
|------|------|
| 런타임 | Node.js + TypeScript |
| HTTP 서버 | Fastify v5 |
| AI 엔진 | Anthropic Claude API + Agent SDK |
| 도구 프로토콜 | MCP (Model Context Protocol) |
| 데이터베이스 | MariaDB (mysql2 드라이버) |
| 스키마/검증 | TypeBox + Zod |
| API 문서 | Swagger (OpenAPI 자동 생성) |

---

## 2. 디렉토리 구조

```
musing_sonar/
├── config/
│   └── repos.json              # 회원사 ID × 시스템 → Git 저장소 매핑
├── docs/                       # 세부 기술 문서 (12개)
├── src/
│   ├── index.ts                # 진입점 (Git 동기화 → Fastify 기동)
│   ├── config/
│   │   ├── env.ts              # 환경변수 파싱
│   │   └── types.ts            # 공용 타입
│   ├── server/
│   │   ├── app.ts              # Fastify 앱 팩토리 (플러그인·라우트 등록)
│   │   ├── routes/
│   │   │   ├── inquiry.ts      # /api/v1/inquiry  (레거시 · 단일 응답)
│   │   │   └── process.ts      # /process         (신규 · SSE 스트림)
│   │   └── schemas/            # TypeBox 요청·응답 스키마
│   ├── git-sync/
│   │   ├── repo-manager.ts     # Clone/Fetch, 재시도, 상태 관리
│   │   ├── types.ts            # RepoConfig, RepoStatus
│   │   └── notify.ts           # 상태 전환 알림
│   ├── preprocess/
│   │   ├── classifier.ts       # queryType 검증·보정
│   │   └── types.ts            # InquiryRequest, ClassifiedQuery
│   ├── auth/
│   │   └── permission.ts       # 역할 기반 권한 확인 (Mock)
│   ├── orchestrator/           # 레거시 경로 (Phase 2)
│   │   ├── index.ts            # Claude API + tool_use 루프
│   │   ├── mcp-client.ts       # MCP 클라이언트 매니저
│   │   ├── prompt-builder.ts   # 시스템·사용자 프롬프트 구성
│   │   └── types.ts            # OrchestratorResult 등
│   ├── agent/                  # 현재 활성 경로 (Phase 5)
│   │   ├── agent-runner.ts     # Agent SDK + SSE 스트림 제어
│   │   └── session-store.ts    # 세션 상태 관리
│   └── mcp-servers/            # MCP 도구 서버 (stdio 프로세스)
│       ├── erp-git/            # Git 읽기 전용 도구
│       ├── erp-db/             # DB SELECT 전용 도구
│       ├── member-db/          # 회원사 정보 (Mock)
│       ├── knowledge-base/     # 지식베이스 (Mock)
│       └── history/            # 처리 이력 (Mock)
├── .env.example
├── .mcp.json                   # MCP 서버 설정 (Claude.ai 클라이언트용)
├── package.json
└── PROJECT_OVERVIEW.md         # 이 문서
```

---

## 3. 전체 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                    클라이언트 / Gateway                   │
│              (1차 필터링 · 라우팅 — 별도 프로젝트)          │
└────────────────────┬────────────────────────────────────┘
                     │  HTTP 요청
         ┌───────────▼───────────┐
         │      musing_sonar        │
         │   Fastify HTTP Server │
         │     :3000             │
         └───┬───────────────┬───┘
             │               │
     레거시 경로          신규 경로
  POST /api/v1/inquiry   POST /process
             │               │
     ┌───────▼───┐   ┌───────▼────────┐
     │Orchestrator│   │  Agent Runner  │
     │(Claude API │   │ (Agent SDK     │
     │ tool_use   │   │  + SSE 스트림) │
     │ 루프)      │   └───────┬────────┘
     └───────┬───┘           │
             └───────┬───────┘
                     │  MCP 도구 호출 (stdio)
         ┌───────────▼──────────────┐
         │       MCP 서버들          │
         ├──────────┬───────────────┤
         │ erp-git  │   erp-db      │
         │ ─────── │   ─────────── │
         │listFiles │ listTables    │
         │searchCode│ describeTable │
         │readFile  │ executeQuery  │
         │  Range   │  (SELECT만)   │
         └────┬─────┴───────┬───────┘
              │             │
     ┌────────▼──┐   ┌──────▼──────┐
     │  .cache/  │   │  MariaDB    │
     │  repos/   │   │ (읽기 전용) │
     │ (Git clone│   │  계정)      │
     │  캐시)    │   └─────────────┘
     └───────────┘
```

---

## 4. 요청 처리 흐름

### 4-A. 신규 경로: `POST /process` (SSE 스트림)

```
클라이언트                    musing_sonar                     Claude + MCP
    │                            │                               │
    │── POST /process ──────────>│                               │
    │                            │ 세션 생성 (sessionId)          │
    │<── event: connected ───────│                               │
    │   {"sessionId":"..."}      │                               │
    │                            │── query(시스템 프롬프트 + 질문)──>│
    │                            │                               │ 도구 선택
    │                            │<── tool_call: searchCode ─────│
    │                            │── tool_result ───────────────>│
    │<── event: trace ───────────│   (도구 실행 중 상황 전달)       │
    │   {"label":"코드 검색",...} │                               │ 분석
    │                            │<── tool_call: executeQuery ───│
    │                            │── tool_result ───────────────>│
    │<── event: trace ───────────│                               │
    │                            │                               │ 최종 답변
    │<── event: done ────────────│<── text 응답 ─────────────────│
    │   {"answer":"...","references":[...]}
    │
```

**이벤트 종류:**

| 이벤트 | 설명 | 데이터 예시 |
|--------|------|------------|
| `connected` | 세션 연결 완료 | `{"sessionId":"abc123"}` |
| `trace` | 도구 호출 진행 상황 | `{"label":"코드 검색","detail":"...","elapsedMs":500}` |
| `clarification` | 추가 정보 요청 | `{"question":"어떤 화면에서 발생했나요?"}` |
| `done` | 분석 완료 | `{"answer":"...","references":[...],"usage":{...}}` |
| `error` | 오류 발생 | `{"code":"TIMEOUT","message":"..."}` |

**멀티턴 대화:** 동일 `sessionId`로 재요청하면 이전 맥락이 유지됩니다.

---

### 4-B. 레거시 경로: `POST /api/v1/inquiry` (단일 응답)

```
1. 저장소 결정    — config/repos.json에서 memberId + targetSystem으로 조회
2. 저장소 상태    — syncing / synced / stale / missing 판정
3. 권한 확인      — checkPermission(memberId, role)
4. 쿼리 분류      — classifyQuery() → queryType 검증
5. Orchestrator   — 시스템 프롬프트 생성 → Claude API + tool_use 루프
6. 응답 반환      — { requestId, status, answer, references, meta }
```

---

## 5. Git 동기화

### 초기화 흐름

```
서버 기동
    └─ repoSyncManager.initialize()
           ├─ repos.json 파싱
           └─ 저장소별 비동기 clone 시작 (서버 기동 차단 안 함)
                  ├─ 성공: status = "synced"
                  ├─ 실패(캐시 있음): status = "stale" (기존 캐시로 서비스)
                  └─ 실패(캐시 없음): status = "missing" (요청 거부)
```

### 저장소 상태

| 상태 | 의미 | 요청 처리 |
|------|------|----------|
| `syncing` | Clone/Fetch 진행 중 | 기존 캐시 있으면 허용 |
| `synced` | 최신 상태 | 허용 |
| `stale` | 동기화 실패, 기존 캐시 사용 중 | 허용 (meta.codeBaseAt 포함) |
| `missing` | 환경변수 없음 또는 캐시 없음 | 거부 (GIT_UNAVAILABLE) |

**캐시 경로:** `.cache/repos/{repo-id}/`

**인증:** 코드에 자격증명 미포함, OS의 Git Credential Manager 사용

---

## 6. MCP 도구 서버

### 6-1. erp-git (Git 읽기 전용)

| 도구 | 설명 | 제한 |
|------|------|------|
| `listFiles(repo?, path, maxDepth?)` | 디렉토리 구조 조회 | 최대 깊이 3, 최대 500 항목 |
| `searchCode(repo?, query, regex?)` | 키워드/정규식 검색 | 최대 50 결과, 파일 1MB 제한 |
| `readFileRange(repo, path, lineStart, lineEnd)` | 특정 라인 범위 읽기 | 최대 200줄 |

**보안:** 모든 경로를 `GIT_CACHE_DIR` 하위로 제한 (경로 순회 차단)

### 6-2. erp-db (DB SELECT 전용)

| 도구 | 설명 |
|------|------|
| `listTables()` | 테이블 목록 조회 |
| `describeTable(table)` | 컬럼명, 타입, 코멘트 조회 |
| `executeQuery(query, table?)` | SELECT 쿼리 실행 |

**이중 보안:**

- **코드 레벨:** SELECT/WITH/EXPLAIN SELECT만 허용, 멀티 스테이트먼트 차단, 자동 LIMIT 추가(최대 100행), PII 컬럼 마스킹(주민번호·전화·계좌·비밀번호 등)
- **DB 레벨:** 읽기 전용 계정으로 접속

### 6-3. Mock 서버

| 서버 | 역할 |
|------|------|
| `member-db` | 회원사 정보 및 권한 |
| `knowledge-base` | 도메인 지식베이스 |
| `history` | 처리 이력 조회 |

---

## 7. API 엔드포인트 목록

### 신규 경로 (Agent SDK)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/health` | 운영 상태 (running/queued 건수) |
| `POST` | `/process` | 자연어 문의 처리 (SSE 스트림) |
| `POST` | `/cancel` | 처리 중 요청 취소 |

### 레거시 경로 (Orchestrator)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/health/system` | MCP 연결 + Git 동기화 상태 (상세) |
| `POST` | `/api/v1/inquiry` | 자연어 문의 처리 (단일 응답) |

**Swagger 문서:** `http://localhost:3000/docs`

---

## 8. 환경변수

```bash
# 서버
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Claude AI
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-haiku-4-5-20251001
CLAUDE_MAX_TOOL_LOOPS=15
CLAUDE_TIMEOUT_MS=30000

# Git 동기화
GIT_CACHE_DIR=./.cache/repos
GIT_SYNC_RETRY_INTERVAL_MS=300000   # 5분
GIT_SYNC_MAX_RETRIES=3

# 회원사별 Git 저장소 (회원사 추가 시 패턴 확장)
HANWHA_ERP_GIT_URL=https://github.com/.../hanwha-erp.git
HANWHA_ERP_GIT_BRANCH=main

# 회원사별 DB (미설정 시 erp-db MCP 서버 비활성화)
HANWHA_ERP_DB_HOST=localhost
HANWHA_ERP_DB_PORT=3306
HANWHA_ERP_DB_NAME=erp_db
HANWHA_ERP_DB_USER=erp_read_only
HANWHA_ERP_DB_PASSWORD=...

# 개발 옵션
USE_MOCK_CONTEXT=false
ENABLE_SANDBOX=false
```

---

## 9. 저장소 설정 (`config/repos.json`)

```json
[
  {
    "id": "hanwha-erp",
    "memberId": "HANWHA_LIFELAB",
    "system": "ERP",
    "urlEnv": "HANWHA_ERP_GIT_URL",
    "branchEnv": "HANWHA_ERP_GIT_BRANCH",
    "description": "한화라이프랩 ERP 메인 저장소"
  }
]
```

새 회원사 추가 시: 이 파일에 항목 추가 + `.env`에 대응 환경변수 추가

---

## 10. 프롬프트 전략

### 쿼리 유형별 역할

| queryType | 역할 |
|-----------|------|
| `LOGIC_CHECK` | ERP Git에서 로직 구현 위치·흐름 설명 |
| `REASON_CHECK` | ERP DB에서 데이터 상태·처리 이력 확인 |

### 프롬프트 원칙

- 도구 호출로 확인한 파일 경로·라인번호·쿼리를 반드시 인용
- 근거 없는 추측 금지
- 개인정보 답변 재인용 금지

### 사용자 메시지 구조

```
[문의 유형] LOGIC_CHECK
[회원사] HANWHA_LIFELAB
[요청자] user-123 (role: developer)
[화면 ID] SCR-001
[메뉴] 수수료 계산

[질의]
PKG_SU_CALC 로직이 어디에 구현되어 있나요?
```

---

## 11. 아키텍처 전환 현황

### Phase 2 (레거시 — Orchestrator)
- 경로: `/api/v1/inquiry`
- 직접 Claude API 호출, tool_use 루프 수동 관리
- 단일 요청/응답 (HTTP JSON)

### Phase 5 (현재 주력 — Agent SDK)
- 경로: `/process`
- Agent SDK가 MCP 핸들링 자동화
- SSE 실시간 스트림
- 멀티턴 대화 (세션 기반)
- 요청 취소 지원

**현재:** 두 경로 모두 활성 상태 (마이그레이션 진행 중)

---

## 12. 개발 명령어

```bash
# 개발 서버 실행
npm run dev             # 전체 서버 (HTTP + Agent SDK)
npm run dev:test        # HTTP 서버 없이 단독 테스트

# MCP 서버 개별 실행 (디버깅용)
npm run dev:erp-git     # erp-git MCP 서버
npm run dev:erp-db      # erp-db MCP 서버
npm run dev:kb          # knowledge-base MCP 서버
npm run dev:member      # member-db MCP 서버

# 빌드 및 운영
npm run build           # TypeScript → dist/ 빌드
npm run start           # 빌드된 dist 실행
```

---

## 13. 동작 예시

**질문:** "매출액 합산이 왜 0원으로 나오나요?"

```
1. POST /process  →  세션 생성
2. event: connected {"sessionId":"s_xxx"}
3. Claude → "DB 조회가 필요하다"
4. MCP erp-db → describeTable("sales")  →  컬럼 정보 반환
5. event: trace {"label":"테이블 구조 확인","elapsedMs":300}
6. Claude → executeQuery("SELECT SUM(amount) FROM sales WHERE ...")
7. event: trace {"label":"데이터 조회","elapsedMs":800}
8. Claude → 결과 분석 → 최종 답변 작성
9. event: done {"answer":"sales 테이블의 amount 컬럼이...","references":[{"type":"DB","table":"sales","query":"..."}]}
```

---

*문서 생성일: 2026-11-04*
