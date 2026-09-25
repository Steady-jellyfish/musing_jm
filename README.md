# musing_jm

한화라이프랩 ERP **로직 확인 / 사유 확인** 문의를 처리하는 백엔드 서버입니다.  
Gateway로부터 정제된 문의를 HTTP로 수신하고, Claude API와 ERP 전용 MCP 도구를 통해 ERP Git 소스·MariaDB를 실제로 조회한 뒤 근거 있는 답변을 반환합니다.

## 시스템 아키텍처

```
Front-end
    ↓ 자연어 문의
Gateway (1차 필터링 — 별도 프로젝트)
    ↓ POST /api/v1/inquiry  (정제된 구조화 데이터)
musing_jm (본 저장소)
    ├─ 2차 가공: queryType 검증, 권한 확인
    ├─ Claude API + tool_use 루프
    │     ├─ erp-git MCP: ERP Git 소스 탐색/읽기
    │     └─ erp-db  MCP: ERP MariaDB SELECT 조회
    └─ HTTP 응답 반환 (answer + references + meta)
```

## 문의 유형

| queryType | 설명 |
|-----------|------|
| `LOGIC_CHECK` | ERP Git 저장소에서 로직 구현 위치·흐름을 찾아 설명 |
| `REASON_CHECK` | ERP DB에서 데이터 상태·처리 이력을 조회해 사유 확인 |

## 기술 스택

- **Runtime**: Node.js + TypeScript (`tsx` 개발 실행)
- **HTTP**: Fastify + TypeBox (요청/응답 스키마 검증)
- **API 문서**: Swagger UI (`/docs`)
- **AI**: Anthropic SDK (Claude, tool_use 루프)
- **MCP**: `@modelcontextprotocol/sdk` (erp-git, erp-db stdio 연결)
- **DB**: mysql2 (ERP MariaDB, SELECT 전용)

## 폴더 구조

```
src/
├── index.ts                    # 서버 진입점 (MCP 초기화 → Fastify 시작)
├── config/
│   ├── env.ts                  # 환경변수 파싱
│   └── types.ts                # 공용 타입 (QueryType, Reference, ResponseMeta 등)
├── server/
│   ├── app.ts                  # Fastify 앱 팩토리 (Swagger, TypeBox 플러그인)
│   ├── routes/inquiry.ts       # GET /health, POST /api/v1/inquiry
│   └── schemas/inquiry.ts      # TypeBox 요청/응답 스키마
├── auth/
│   └── permission.ts           # 회원사·역할 권한 확인 (인프로세스 Mock)
├── preprocess/
│   ├── types.ts                # InquiryRequest, ClassifiedQuery
│   └── classifier.ts           # queryType 검증·보정
├── orchestrator/
│   ├── index.ts                # Claude API 호출 + tool_use 루프
│   ├── mcp-client.ts           # MCP 클라이언트 매니저 (연결 상태 관리)
│   ├── prompt-builder.ts       # 시스템/사용자 메시지 구성
│   └── types.ts                # OrchestratorResult, OrchestratorError
└── mcp-servers/
    ├── erp-git/index.ts        # ERP Git 탐색 도구 (listFiles, searchCode, readFileRange)
    ├── erp-db/index.ts         # ERP DB 조회 도구 (listTables, describeTable, executeQuery)
    ├── member-db/index.ts      # 회원사 정보·권한 확인 (Mock)
    ├── knowledge-base/index.ts # 지식베이스 (Mock)
    └── history/index.ts        # 처리 이력 (Mock)
```

## 시작하기

```bash
# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일에 ANTHROPIC_API_KEY, ERP_GIT_ROOT, ERP_DB_* 등 실제 값 입력

# 개발 서버 실행
npm run dev
```

서버 기동 시 MCP 서버별 연결 상태가 stderr에 출력됩니다.

```
WARN [mcp-manager] erp-git: 건너뜀 (ERP_GIT_ROOT 없음)
WARN [mcp-manager] erp-db: 건너뜀 (ERP_DB_NAME, ERP_DB_USER 없음)
INFO [server] http://0.0.0.0:3000 에서 수신 중
INFO [server] Swagger UI: http://localhost:3000/docs
```

## 주요 환경변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `PORT` | HTTP 서버 포트 | `3000` |
| `ANTHROPIC_API_KEY` | Claude API 키 | 필수 |
| `CLAUDE_MODEL` | 사용할 Claude 모델 | `claude-sonnet-4-6` |
| `CLAUDE_MAX_TOOL_LOOPS` | tool_use 최대 반복 횟수 | `10` |
| `CLAUDE_TIMEOUT_MS` | 전체 처리 타임아웃 (ms) | `60000` |
| `ERP_GIT_ROOT` | 로컬 ERP Git 저장소 경로 | 미설정 시 erp-git 비활성 |
| `ERP_DB_HOST` | ERP MariaDB 호스트 | 미설정 시 erp-db 비활성 |
| `ERP_DB_NAME` | ERP MariaDB 데이터베이스명 | — |
| `ERP_DB_USER` | ERP MariaDB 사용자 (읽기 전용) | — |
| `ERP_DB_PASSWORD` | ERP MariaDB 비밀번호 | — |
| `USE_MOCK_CONTEXT` | Mock 데이터를 사전 컨텍스트로 주입 | `false` |

전체 목록은 `.env.example` 참조.

## API

### `GET /health`

서버 상태 및 MCP 연결 상태를 반환합니다.

```json
{
  "status": "ok",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "mcp": [
    { "name": "erp-git", "status": "connected", "tools": ["listFiles", "searchCode", "readFileRange"] },
    { "name": "erp-db",  "status": "skipped",   "reason": "ERP_DB_NAME, ERP_DB_USER 없음" }
  ]
}
```

### `POST /api/v1/inquiry`

ERP 문의를 처리하고 답변을 반환합니다.

**요청**
```json
{
  "requestId": "req-001",
  "memberId": "HANWHA_LIFELAB",
  "queryType": "LOGIC_CHECK",
  "question": "PKG_SU_CALC 로직이 어디에 구현되어 있나요?",
  "requester": { "userId": "user-123", "role": "developer" },
  "context": {
    "screenId": "SCR-001",
    "menuName": "수수료 계산",
    "keyValues": { "contractNo": "C-2024-001" }
  }
}
```

**응답**
```json
{
  "requestId": "req-001",
  "status": "SUCCESS",
  "answer": "PKG_SU_CALC는 com/example/calc/PkgSuCalcService.java:142에 구현되어 있으며...",
  "references": [
    { "type": "CODE", "repo": "erp", "path": "com/example/calc/PkgSuCalcService.java", "lineStart": 142, "lineEnd": 165 },
    { "type": "DB", "table": "PKG_CONFIG", "query": "SELECT * FROM PKG_CONFIG WHERE ..." }
  ],
  "meta": {
    "model": "claude-sonnet-4-6",
    "toolCallCount": 3,
    "inputTokens": 1200,
    "outputTokens": 450,
    "elapsedMs": 5300
  }
}
```

**응답 status 코드**

| status | error.code | 설명 |
|--------|-----------|------|
| `SUCCESS` | — | 정상 처리 |
| `FAILED` | `CLAUDE_API_ERROR` | Claude API 호출 실패 |
| `FAILED` | `MAX_TOOL_LOOPS_EXCEEDED` | tool_use 반복 상한 도달 |
| `FAILED` | `TIMEOUT` | 처리 시간 초과 |
| `REJECTED` | `PERMISSION_DENIED` | 권한 없음 |

## MCP 도구 보안 제약

**erp-git**
- 읽기 전용 (쓰기 도구 없음)
- `ERP_GIT_ROOT` 경로 밖 접근 차단 (path traversal 방지)
- `searchCode` 결과: 파일경로 + 라인번호 + 전후 2줄만 반환

**erp-db**
- SELECT/WITH/EXPLAIN SELECT만 허용, 나머지 구문 거부
- 결과 최대 100행 (LIMIT 자동 추가)
- 개인정보 컬럼(주민번호, 전화번호, 계좌번호, 비밀번호 등) 자동 마스킹(`***`)
- 쿼리 원문·결과 원문 로그 출력 금지

## 개발 스크립트

```bash
npm run dev          # 전체 서버 실행
npm run dev:test     # HTTP 서버 없이 단독 테스트 (dev-runner.ts)
npm run dev:erp-git  # erp-git MCP 서버 단독 실행
npm run dev:erp-db   # erp-db MCP 서버 단독 실행
npm run build        # TypeScript 빌드
```

## 관련 역할 분담

- Gateway (1차 필터링): 한상민
- 자연어 2차 가공 / Claude 오케스트레이션: 김지민 (본 저장소)
