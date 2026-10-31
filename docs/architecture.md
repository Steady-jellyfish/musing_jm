# musing_jm 동작 방식

> "매출액이 왜 0원이에요?" 라는 질문 하나가 들어왔을 때, 내부에서 무슨 일이 벌어지는가.

---

## 등장인물 먼저 파악하기

이 시스템에는 4명의 플레이어가 있습니다.

| 플레이어 | 실제 정체 | 하는 일 |
|---------|----------|--------|
| **클라이언트** | 브라우저 / 앱 | 질문을 보내고, 답변을 화면에 표시 |
| **우리 서버** | Node.js + Fastify | 요청을 받아서 Claude에게 일을 시키는 중간 관리자 |
| **Claude** | Anthropic AI 모델 | 실제로 "생각"하는 주체. 뭘 조회할지 판단하고, 최종 답변 작성 |
| **MCP 서버** | Git/DB 조회 도구 | Claude가 "이 파일 보여줘", "이 쿼리 실행해줘" 할 때 실제로 움직이는 도구 |

> **핵심 포인트**: 코드베이스나 DB를 직접 뒤지는 건 Claude가 아닙니다.  
> Claude는 "어떤 파일을 봐야겠다"고 **판단**하고, 실제 조회는 **MCP 서버**가 합니다.  
> Claude는 그 결과를 받아서 **해석**합니다.

---

## 전체 흐름 한눈에 보기

```
사용자가 질문을 입력
        │
        ▼
  [클라이언트]  ──── POST /process 요청 ────▶  [우리 서버]
                                                    │
                                         AgentRunner가 Claude 호출
                                                    │
                                                    ▼
                                               [Claude]
                                              (생각 중...)
                                           "파일을 봐야겠어"
                                                    │
                                      도구 호출 요청 (MCP call)
                                                    │
                                                    ▼
                                  [MCP 서버: erp-git / erp-db]
                                  실제로 Git에서 파일 읽거나
                                  DB에 SELECT 쿼리 실행
                                                    │
                                       조회 결과를 Claude에게 전달
                                                    │
                                                    ▼
                                               [Claude]
                                         결과를 읽고 분석
                                         "아, 이 로직 때문이구나"
                                                    │
                                        최종 답변 텍스트 작성
                                                    │
                                                    ▼
  [클라이언트]  ◀──── SSE 스트림으로 실시간 전달 ────  [우리 서버]
```

---

## Claude의 명령을 실제로 실행하는 주체는?

Claude가 "매출 계산 로직이 어디 있는지 먼저 찾아야겠어" 라고 판단하면, **말(텍스트)로 명령을 내뱉는다.**  
그 명령을 받아서 실제로 움직이는 건 Claude가 아니다.

```
Claude (Anthropic 서버에서 실행 — 외부에 직접 접근 불가)
  │
  │  "이 도구 써야겠다"
  │  → tool_use 메시지 출력
  │    { type: "tool_use", name: "searchCode", input: { query: "매출 계산" } }
  │
  ▼
Agent SDK  ← 우리 서버(Node.js) 안에서 실행
  │
  │  tool_use 메시지 해석 → 해당 MCP 서버로 라우팅
  │
  ▼
MCP 서버 (erp-git / erp-db)
  │
  │  실제로 파일 읽기 / DB 쿼리 실행
  │
  ▼
Agent SDK
  │
  │  결과를 tool_result로 포장 → Claude에게 다시 전달
  │
  ▼
Claude  →  "결과 받았어. 다음은 readFileRange 호출해줘"  →  반복
```

**결론:**  
Claude는 Anthropic 서버에서 실행되고, 파일·DB에 **직접 손댈 수 없다.**  
오직 `tool_use` 텍스트를 출력할 뿐이고, 그걸 받아서 실제로 움직이는 주체가 **Agent SDK**다.

```
Claude     = 판단하고 지시하는 팀장  (but 직접 움직이지 못함)
Agent SDK  = 지시를 받아 실행하는 팀원  (라우팅 + 실행 조율)
MCP 서버   = 실무 담당자  (실제 파일 읽기, DB 쿼리)
```

---

## Claude가 "생각"하는 방식 — 도구 루프

Claude는 한 번에 답을 뱉지 않습니다. 필요한 정보를 **직접 찾아가며** 답변을 완성합니다.  
이 과정을 **도구 루프(Tool Loop)** 라고 부릅니다.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   [Claude에게 질문 전달]                                         │
│         │                                                       │
│         ▼                                                       │
│   Claude가 응답 생성                                             │
│         │                                                       │
│         ├─── "답 알겠음. 설명할게요" ──▶ 루프 종료, 최종 답변    │
│         │                                                       │
│         └─── "이 파일 봐야 알 것 같은데?" ──▶ 도구 호출 요청    │
│                       │                                         │
│                       ▼                                         │
│            MCP 서버가 파일/DB 조회 실행                          │
│                       │                                         │
│                       ▼                                         │
│            결과를 Claude에게 다시 전달                           │
│                       │                                         │
│                       ▼                                         │
│   Claude가 응답 생성 ◀──────────────────────────── (반복)       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**예시로 보기:**

```
질문: "매출액이 왜 0원이에요?"

1회전: Claude → "매출 계산 로직이 어디 있는지 먼저 찾아야겠어"
        └─▶ MCP erp-git: searchCode("매출 계산")
        └─▶ 결과: ["src/sale/calc.ts", "src/report/monthly.ts"]

2회전: Claude → "calc.ts 파일 내용을 봐야겠어"
        └─▶ MCP erp-git: readFileRange("src/sale/calc.ts", 100~150줄)
        └─▶ 결과: 해당 코드 내용

3회전: Claude → "코드에서 조건이 있네. DB 실제 데이터도 봐야겠어"
        └─▶ MCP erp-db: executeQuery("SELECT amount FROM sales WHERE ...")
        └─▶ 결과: 조회된 데이터

4회전: Claude → "이제 알겠다. WHERE 조건에 필터가 잘못 걸려서 0이 나오는 거네"
        └─▶ 최종 답변 작성, 루프 종료
```

이 루프를 자동으로 처리해주는 게 **Agent SDK**입니다.  
우리가 `query()`를 한 번 호출하면, 도구 루프 전체를 알아서 돌려줍니다.

---

## MCP 서버란?

MCP(Model Context Protocol)는 Claude가 외부 도구를 사용하기 위한 표준 규격입니다.  
쉽게 말해, **Claude와 도구 사이의 공통 언어**입니다.

이 프로젝트에서 운영하는 MCP 서버는 3개입니다.

### erp-git (Git 코드 탐색)
```
Claude가 요청         MCP 서버가 실행          결과 반환
──────────────────────────────────────────────────────
listFiles(path)   →  실제 디렉토리 목록 조회  →  파일 목록
searchCode(query) →  코드베이스 전체 텍스트 검색 →  검색 결과
readFileRange(path, start, end) → 파일 특정 줄 읽기 → 코드 내용
```

### erp-db (DB 조회)
```
Claude가 요청            MCP 서버가 실행       결과 반환
──────────────────────────────────────────────────────
listTables()      →  SHOW TABLES 실행       →  테이블 목록
describeTable(t)  →  DESCRIBE 테이블 실행   →  컬럼 구조
executeQuery(sql) →  SELECT 쿼리 실행       →  조회 결과
```

> **중요**: executeQuery는 **SELECT만** 허용됩니다. Claude가 데이터를 수정하는 건 불가능합니다.

### musing-core (우리가 만든 내부 도구)
Claude가 분석을 시작하기 전에 반드시 거쳐야 하는 관문 역할입니다.

```
set_query_type("LOGIC_REVIEW")
  → "이건 로직 확인 질문이구나" 라고 분류 먼저 하게 강제
  → 클라이언트에 trace 이벤트 실시간 전송

request_clarification([질문 목록])
  → "이 질문은 정보가 부족해서 모르겠어요" 라고 Claude가 선언
  → 사용자에게 선택지 제시 후 분석 중단
```

---

## SSE — 실시간으로 진행상황 보내기

기존 HTTP 방식은 "다 끝나면 한 번에 보냄"이었습니다.  
Claude가 10초 동안 분석하면, 클라이언트는 10초 동안 빈 화면을 봐야 했습니다.

**SSE(Server-Sent Events)** 는 서버가 결과를 만들 때마다 실시간으로 보내는 방식입니다.

```
클라이언트 화면에 표시되는 순서:

0.1초 후  → "분석을 시작합니다..." (connected 이벤트)
1.2초 후  → "질문 유형 파악 완료: 오류 원인 확인" (trace 이벤트)
3.4초 후  → "코드 탐색 중: src/sale/calc.ts" (trace 이벤트)
6.8초 후  → "DB 조회 중: sales 테이블" (trace 이벤트)
9.1초 후  → 최종 답변 전체 (done 이벤트)
```

화면에서 로딩 상태를 보여주거나, "지금 DB 조회 중입니다" 같은 프로그레스를 표시할 수 있습니다.

---

## 채팅형 연속 대화

`sessionId` 하나로 대화를 계속 이어갈 수 있습니다.

```
첫 번째 질문
  클라이언트 → { question: "매출 로직이 어떻게 되나요?", memberId: "HANWHA" }
  서버 ←       { event: "connected", data: { sessionId: "abc-123" } }
  서버 ←       { event: "trace", ... }
  서버 ←       { event: "done", data: { answer: "매출은 sales 테이블의..." } }

두 번째 질문 (같은 맥락 유지)
  클라이언트 → { question: "그럼 세금은요?", sessionId: "abc-123" }
                                              ↑ 이 sessionId 덕분에
                                                Claude가 앞 대화를 기억함
  서버 ←       { event: "done", data: { answer: "세금은 같은 테이블에서..." } }

되묻기가 필요한 경우
  클라이언트 → { question: "매출이 왜 0원이죠?", sessionId: "abc-123" }
  서버 ←       { event: "clarification", data: { questions: [
                  { question: "어느 기간 얘기인가요?",
                    options: [{ label: "2026년 1월" }, { label: "2026년 2월" }] }
                ]}}

되묻기 답변
  클라이언트 → { sessionId: "abc-123", answers: { "어느 기간 얘기인가요?": "2026년 1월" } }
  서버 ←       { event: "done", data: { answer: "2026년 1월 데이터에서..." } }
```

**어떻게 대화를 기억하나요?**  
Agent SDK 내부에 `agentSessionId`라는 대화 기록 키가 있습니다.  
다음 요청 때 이 키를 `resume` 옵션으로 넘기면, 이전 대화 전체가 Claude 컨텍스트에 복원됩니다.

---

## 취소 처리

```
클라이언트가 [취소] 버튼 클릭
        │
        ▼
POST /cancel  { requestId: "req-xyz" }
        │
        ▼
실행 중인 Claude 도구 루프 강제 종료
(내부적으로 AsyncGenerator.return() 호출)
        │
        ▼
SSE 스트림 자동 종료
```

---

## 주요 파일 지도

```
src/
├── server/
│   ├── routes/process.ts     ← HTTP 요청 받기, SSE 스트림 내보내기
│   └── schemas/process.ts    ← 요청/응답 타입 정의
│
├── agent/
│   ├── agent-runner.ts       ← Claude 호출, 도구 루프 실행, 이벤트 emit
│   └── session-store.ts      ← 대화 세션 상태 보관, 취소 관리
│
└── mcp-servers/
    ├── erp-git/index.ts      ← Git 코드 탐색 도구 (Claude가 호출)
    └── erp-db/index.ts       ← DB SELECT 도구 (Claude가 호출)
```

---

## 세션 상태 변화

```
처음 질문이 들어오면
        │
        ▼
     [active]  ← 분석 중
        │
        ├── Claude가 "모르겠어요, 추가 정보 주세요" → [waiting_input]
        │           │
        │           └── 사용자가 답변 제공 → [active] → [done]
        │
        ├── Claude가 답변 완성 → [done]
        │           │
        │           └── 사용자가 추가 질문 → [active] → [done]  (무한 반복 가능)
        │
        └── 오류 발생 → [failed]
```
