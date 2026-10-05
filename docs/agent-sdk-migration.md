# Agent SDK 마이그레이션 가이드

## 개요

이 문서는 `musing_jm` 프로젝트를 **Anthropic SDK 직접 호출 방식**에서  
**`@anthropic-ai/claude-agent-sdk` 방식**으로 전환한 내용을 설명합니다.

---

## 변경 전 vs 변경 후 요약

| 항목 | 변경 전 | 변경 후 |
|---|---|---|
| Claude 호출 방식 | `anthropic.messages.create()` 수동 루프 | `query()` 자동 루프 |
| MCP 서버 관리 | `McpClientManager` (앱 시작 시 연결) | Agent SDK가 요청 단위로 서브프로세스 생성 |
| API 엔드포인트 | `POST /api/v1/inquiry` | `POST /process` |
| 응답 상태 | `SUCCESS \| FAILED \| REJECTED` | `done \| waiting_input \| failed` |
| 되묻기(멀티턴) | 미구현 | `waiting_input` 상태 + 세션 재개 |
| 취소 API | 없음 | `POST /cancel` |
| 헬스체크 형식 | MCP 연결 상태 반환 | 처리 중/대기 건수 반환 |

---

## 1. 패키지 추가

```bash
npm install @anthropic-ai/claude-agent-sdk --legacy-peer-deps
```

`package.json` 의존성:

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^...",
    "@anthropic-ai/sdk": "^0.128.0"   // 기존 유지 (MCP 서버 내부에서 사용)
  }
}
```

---

## 2. 핵심 변경: Orchestrator → AgentRunner

### 변경 전 (`src/orchestrator/index.ts`)

```typescript
// Anthropic SDK 직접 사용
import Anthropic from "@anthropic-ai/sdk";

class Orchestrator {
  private anthropic: Anthropic;

  async initialize() {
    // 앱 시작 시 MCP 서버 서브프로세스를 연결하고 유지
    await mcpManager.initialize();
  }

  private async processInternal(classifiedQuery, options) {
    const messages: MessageParam[] = [
      { role: "user", content: buildUserMessage(classifiedQuery) },
    ];

    // 수동 tool_use 루프 (최대 10회 반복)
    for (let loop = 0; loop <= env.claudeMaxToolLoops; loop++) {
      const response = await this.anthropic.messages.create({
        model: env.claudeModel,
        max_tokens: 4096,
        system: systemPrompt,
        tools: mcpManager.getTools(),   // 미리 변환해둔 Anthropic 형식 도구
        messages,
      });

      if (response.stop_reason === "end_turn") break;

      // tool_use 블록 처리
      for (const toolUse of toolUseBlocks) {
        const result = await mcpManager.callTool(toolUse.name, toolUse.input);
        toolResults.push({ type: "tool_result", ... });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }
}
```

### 변경 후 (`src/agent/agent-runner.ts`)

```typescript
// Agent SDK 사용
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

class AgentRunner {
  async run(req: ProcessRequest): Promise<ProcessResult> {
    // 1. 커스텀 인프로세스 MCP 도구 생성
    const customServer = createSdkMcpServer({
      name: "musing-core",
      tools: [setQueryTypeTool, requestClarificationTool],
    });

    // 2. 도구 호출 추적 Hook
    const trackToolUse: HookCallback = async (hookInput) => {
      // references / trace 수집
      return {};
    };

    // 3. query() 로 에이전트 실행 — tool_use 루프는 SDK가 자동 처리
    const gen = query({
      prompt,
      options: {
        systemPrompt,
        model: env.claudeModel,
        mcpServers: {
          "erp-git": { command: "npx", args: ["tsx", "src/mcp-servers/erp-git/index.ts"] },
          "erp-db":  { command: "npx", args: ["tsx", "src/mcp-servers/erp-db/index.ts"] },
          "musing-core": customServer,   // 인프로세스 커스텀 도구
        },
        maxTurns: env.claudeMaxToolLoops + 1,
        hooks: {
          PostToolUse: [{ matcher: ".*", hooks: [trackToolUse] }],
        },
        resume: session?.agentSessionId,  // 세션 재개 (되묻기 답변 시)
      },
    });

    // 4. 결과 수신
    for await (const message of gen) {
      if ("result" in message) finalAnswer = message.result;
    }
  }
}
```

---

## 3. 주요 차이점 설명

### 3-1. tool_use 루프 자동화

| 구분 | 변경 전 | 변경 후 |
|---|---|---|
| 루프 관리 | `for` 루프 수동 작성 | `query()` 내부에서 자동 처리 |
| 도구 실행 | `mcpManager.callTool()` 수동 호출 | Agent SDK가 MCP 서버에 직접 전달 |
| 응답 파싱 | `tool_use` 블록 직접 파싱 | SDK가 처리, Hook으로 결과 관찰 |

### 3-2. MCP 서버 생명주기

- **변경 전**: 앱 시작 시 `McpClientManager.initialize()` 로 모든 MCP 서버를 연결하고 앱 종료 시까지 유지
- **변경 후**: `query()` 호출 시 `mcpServers` 옵션에 따라 Agent SDK가 서브프로세스를 관리. 앱 수준의 초기화 불필요

### 3-3. 커스텀 인프로세스 MCP 도구

Agent SDK의 `createSdkMcpServer` + `tool()` API를 사용해 서브프로세스 없이  
인프로세스에서 동작하는 커스텀 도구를 정의할 수 있습니다.

**추가된 커스텀 도구:**

```typescript
// 질의 유형 선언 도구
const setQueryTypeTool = tool(
  "set_query_type",
  "분석 시작 시 질의 유형을 선언합니다.",
  { type: z.enum(["LOGIC_REVIEW", "ERROR_CAUSE"]) },
  async (args) => {
    queryType = args.type;  // 클로저로 캡처
    return { content: [{ type: "text", text: `유형: ${args.type}` }] };
  }
);

// 되묻기 요청 도구
const requestClarificationTool = tool(
  "request_clarification",
  "질의가 모호할 때 사용자에게 추가 정보를 요청합니다.",
  {
    questions: z.array(z.object({
      question: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string() })),
      multiSelect: z.boolean(),
    }))
  },
  async (args) => {
    pendingClarification = args.questions;  // 클로저로 캡처
    return { content: [{ type: "text", text: "추가 정보 요청됨" }] };
  }
);
```

### 3-4. 도구 호출 추적 (Hooks)

Hook을 사용해 에이전트의 도구 호출을 비침습적으로 관찰합니다.

```typescript
options: {
  hooks: {
    PostToolUse: [
      {
        matcher: ".*",          // 모든 도구 대상
        hooks: [trackToolUse],
      },
    ],
  },
}

const trackToolUse: HookCallback = async (hookInput) => {
  const { tool_name, tool_input } = hookInput as any;

  // readFileRange 호출 → CODE 참조 생성
  if (tool_name.includes("readFileRange")) {
    references.push({
      locator: `${tool_input.path}:${tool_input.lineStart}`,
      description: `파일 읽기: ${tool_input.path}`,
    });
  }

  // executeQuery 호출 → DB 참조 생성
  if (tool_name.includes("executeQuery")) {
    references.push({
      locator: tool_input.table,
      description: `DB 조회: ${tool_input.table}`,
    });
  }

  return {};
};
```

### 3-5. 세션 재개 (되묻기 지원)

Agent SDK의 `resume` 옵션으로 이전 대화 컨텍스트를 유지하며 이어갈 수 있습니다.

```
[1차 요청] question: "지사수수료계가 0원입니다."
  → Claude가 request_clarification 호출
  → 응답: { status: "waiting_input", sessionId: "xxx", questions: [...] }

[2차 요청] sessionId: "xxx", answers: { "기준?": "지사 소계" }
  → session.agentSessionId 로 resume
  → prompt: "이전 추가 정보에 대한 사용자 응답: ..."
  → Agent SDK가 이전 대화를 포함해 계속 분석
  → 응답: { status: "done", answer: "...", references: [...] }
```

---

## 4. API 스펙 변경

### 4-1. 질의 처리: `POST /process`

**Request:**
```json
{
  "question": "지사수수료계가 0원입니다. 왜 그런가요?",
  "memberId": "hll",
  "requestId": "clx8f3k2j0001qzrm9x8a7b2c",
  "sessionId": "optional-for-resume",
  "answers": { "어느 기준?": "지사 소계" }
}
```

**Response (done):**
```json
{
  "status": "done",
  "sessionId": "clx8f3k2j0002qzrm4d1e9f3a",
  "type": "ERROR_CAUSE",
  "answer": "지급규정 개정이 원인입니다...",
  "references": [
    { "locator": "PKG_SU_CALC:412", "description": "파일 읽기: PKG_SU_CALC" },
    { "locator": "TB_SU_JISA_RATE", "description": "DB 조회: TB_SU_JISA_RATE" }
  ],
  "trace": [
    { "label": "유형 판별", "detail": "오류 원인 확인", "elapsedMs": 400 },
    { "label": "저장소 탐색", "detail": "7개 파일", "elapsedMs": 21700 },
    { "label": "DB 조회", "detail": "4건", "elapsedMs": 31400 },
    { "label": "응답 작성", "elapsedMs": 52800 }
  ],
  "usage": { "elapsedMs": 107400, "filesRead": 7, "dbQueries": 4 }
}
```

**Response (waiting_input):**
```json
{
  "status": "waiting_input",
  "sessionId": "clx8f3k2j0002qzrm4d1e9f3a",
  "type": "LOGIC_REVIEW",
  "questions": [
    {
      "question": "어느 기준으로 조회한 결과인가요?",
      "options": [
        { "label": "지사 소계", "description": "지사 단위 합산" },
        { "label": "개인별 내역", "description": "설계사 개인 단위" }
      ],
      "multiSelect": false
    }
  ],
  "trace": [
    { "label": "유형 판별", "detail": "로직 문의", "elapsedMs": 400 }
  ]
}
```

### 4-2. 취소: `POST /cancel`

```json
// Request
{ "requestId": "clx8f3k2j0001qzrm9x8a7b2c", "sessionId": "..." }

// Response
{ "canceled": true }
```

### 4-3. 헬스체크: `GET /health`

```json
{ "ok": true, "running": 1, "queued": 3 }
```

---

## 5. 파일 구조 변경

```
변경 전                              변경 후
──────────────────────────────────   ──────────────────────────────────
src/
├── orchestrator/
│   ├── index.ts        (삭제)       src/
│   ├── mcp-client.ts   (삭제)       ├── agent/
│   ├── prompt-builder.ts (삭제)     │   ├── agent-runner.ts  ← NEW
│   └── types.ts        (삭제)       │   └── session-store.ts ← NEW
├── preprocess/                      ├── server/
│   └── classifier.ts   (유지)       │   ├── routes/
├── auth/                            │   │   └── process.ts   ← NEW
│   └── permission.ts   (유지)       │   └── schemas/
├── server/                          │       └── process.ts   ← NEW
│   ├── routes/                      ├── git-sync/           (유지)
│   │   └── inquiry.ts  (대체)       ├── mcp-servers/        (유지)
│   └── schemas/                     └── config/             (유지)
│       └── inquiry.ts  (대체)
├── git-sync/           (유지)
├── mcp-servers/        (유지)
└── config/             (유지)
```

---

## 6. 환경변수 변경사항

추가/변경된 환경변수 없음. 기존 `.env` 그대로 사용 가능합니다.

```env
# 기존과 동일
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-6
CLAUDE_MAX_TOOL_LOOPS=10
CLAUDE_TIMEOUT_MS=60000

ERP_GIT_URL=https://...
ERP_GIT_CACHE_DIR=./.cache/repos

ERP_DB_HOST=...
ERP_DB_NAME=...
ERP_DB_USER=...
ERP_DB_PASSWORD=...
```

---

## 7. 주의사항

### MCP 서버 env 전달

Agent SDK의 `mcpServers` 옵션의 `env` 필드 지원 여부에 따라,  
MCP 서버 서브프로세스는 부모 프로세스(Node.js 서버)의 `process.env`를 상속합니다.  
DB 접속 정보 등 환경변수는 서버 실행 전에 `.env` 또는 시스템 환경변수로 설정하세요.

### 세션 인메모리 저장

현재 `SessionStore`는 인메모리(Map)로 구현되어 있습니다.  
서버 재시작 시 세션이 초기화됩니다. 프로덕션 환경에서는 Redis 등 외부 저장소로 교체를 권장합니다.

### 취소 동작

`POST /cancel`은 `gen.return()`으로 제너레이터를 종료합니다.  
Agent SDK 내부에서 진행 중인 Claude API 호출은 즉시 중단되지 않을 수 있으며,  
현재 처리 단계가 완료된 후 루프가 종료됩니다.
