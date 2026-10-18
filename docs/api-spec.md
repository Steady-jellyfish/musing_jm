_# musing_jm API 명세서

> Base URL: `http://localhost:3000` (로컬) / 운영 URL은 배포 후 교체  
> 인증: 없음 (회원사 구분은 요청 본문의 `memberId`로 처리)  
> 응답 형식: 모든 응답은 HTTP 200 + JSON (오류도 200으로 반환, `status` 필드로 구분)

---

## 1. 질의 처리

### 기본 정보

| 항목 | 내용 |
|------|------|
| URL | `POST /process` |
| Content-Type | `application/json` |
| 응답 방식 | 동기 (분석 완료 후 한 번에 응답, 평균 30~90초) |

---

### Request

```json
{
  "question":  "string",                    // 필수. 사용자 자연어 질문
  "memberId":  "string",                    // 필수. 회원사 ID (예: "hll")
  "requestId": "string",                    // 필수. 요청 고유 ID (프론트 발급, cuid/uuid 권장)
  "sessionId": "string",                    // 선택. 이전 응답에서 받은 세션 ID (멀티턴 시 포함)
  "answers":   { "질문 텍스트": "선택 라벨" } // 선택. waiting_input 후 재요청 시 사용자 선택 값
}
```

**`requestId` 규칙**
- 요청마다 새로 생성 (재시도 포함)
- 동일 `requestId`로 재요청 시 서버가 중복으로 간주하고 `failed` 반환
- 취소(`/cancel`) 시 이 값으로 요청을 식별함

**`sessionId` 규칙**
- 첫 질문: 생략 → 서버가 새 세션 발급 후 응답에 포함
- 후속 질문 / 되묻기 응답: 이전 응답의 `sessionId` 그대로 포함

---

### Response — 공통 필드

| 필드 | 타입 | 항상 포함 | 설명 |
|------|------|----------|------|
| `status` | `"done" \| "waiting_input" \| "failed"` | ✅ | 처리 결과 상태 |
| `sessionId` | `string` | ✅ | 세션 ID (첫 요청 시 서버 발급) |
| `type` | `"LOGIC_REVIEW" \| "ERROR_CAUSE"` | 선택 | 엔진이 판별한 질의 유형 |
| `trace` | `TraceEntry[]` | ✅ | 처리 단계별 소요 시간 |

**TraceEntry 스키마**
```json
{
  "label":     "string",  // 단계명 (예: "유형 판별", "저장소 탐색", "DB 조회", "응답 작성")
  "detail":    "string",  // 선택. 단계 상세 (예: "7개 파일", "오류 원인 확인")
  "elapsedMs": 0          // 해당 단계 완료 시점의 누적 경과 시간 (ms)
}
```

---

### Response — `status: "done"` (정상 응답)

```json
{
  "status":    "done",
  "sessionId": "clx8f3k2j0002qzrm4d1e9f3a",
  "type":      "ERROR_CAUSE",
  "answer":    "지급규정 개정이 원인입니다. 2026년 7월 31일 적용된 개정으로 산출 기준이 바뀌었고, 해당 건은 개정 후 기준값이 등록되어 있지 않아 0원으로 산출됩니다.",
  "references": [
    { "locator": "PKG_SU_CALC:412",   "description": "합산 기준 분기" },
    { "locator": "TB_SU_JISA_RATE",   "description": "대상 지사 등록 행 없음" }
  ],
  "trace": [
    { "label": "유형 판별",  "detail": "오류 원인 확인", "elapsedMs": 400   },
    { "label": "저장소 탐색", "detail": "7개 파일",      "elapsedMs": 21700 },
    { "label": "DB 조회",    "detail": "4건",            "elapsedMs": 31400 },
    { "label": "응답 작성",                              "elapsedMs": 52800 }
  ],
  "usage": {
    "elapsedMs":  107400,
    "tokens":     38200,
    "filesRead":  7,
    "dbQueries":  4
  }
}
```

**추가 필드 스키마**

| 필드 | 타입 | 설명 |
|------|------|------|
| `answer` | `string` | Claude가 생성한 분석 답변 (마크다운 형식) |
| `references` | `Reference[]` | 답변 근거 목록 |
| `usage` | `Usage` | 리소스 사용량 |

**Reference 스키마**
```json
{
  "locator":     "string", // 코드: "파일경로:줄번호" / DB: "테이블명"
  "description": "string"  // 해당 위치의 역할 설명
}
```

**Usage 스키마**
```json
{
  "elapsedMs": 0, // 전체 처리 시간 (ms)
  "tokens":    0, // 사용된 총 토큰 수 (input + output)
  "filesRead": 0, // 읽은 파일 수
  "dbQueries": 0  // 실행한 DB 쿼리 수
}
```

---

### Response — `status: "waiting_input"` (되묻기)

질문이 모호하거나 분석 범위 확정이 필요할 때 반환됩니다.  
프론트는 `questions`로 선택 UI를 렌더링하고, 사용자 선택 후 `answers`에 담아 재요청합니다.

```json
{
  "status":    "waiting_input",
  "sessionId": "clx8f3k2j0002qzrm4d1e9f3a",
  "type":      "LOGIC_REVIEW",
  "questions": [
    {
      "question": "어느 기준으로 조회한 결과인가요?",
      "options": [
        { "label": "지사 소계",   "description": "지사 단위로 합산한 화면 기준" },
        { "label": "개인별 내역", "description": "설계사 개인 단위 명세 기준" }
      ],
      "multiSelect": false
    }
  ],
  "trace": [
    { "label": "유형 판별", "detail": "로직 문의",     "elapsedMs": 400  },
    { "label": "질문 분석", "detail": "조회 기준 불명확", "elapsedMs": 2800 }
  ]
}
```

**ClarificationQuestion 스키마**
```json
{
  "question":    "string",           // 사용자에게 보여줄 질문 텍스트
  "options": [
    {
      "label":       "string",       // 선택지 라벨 (answers의 값으로 사용)
      "description": "string"        // 선택지 설명
    }
  ],
  "multiSelect": false               // true: 복수 선택 허용 / false: 단일 선택
}
```

**되묻기 응답 후 재요청 예시**
```json
{
  "question":  "지사수수료계가 0원입니다. 왜 그런가요?",
  "memberId":  "hll",
  "sessionId": "clx8f3k2j0002qzrm4d1e9f3a",
  "requestId": "clx8f3k2j0003NEW",
  "answers": {
    "어느 기준으로 조회한 결과인가요?": "지사 소계"
  }
}
```
> `answers`의 키 = `questions[].question` 텍스트, 값 = `options[].label` 중 선택한 값

---

### Response — `status: "failed"` (실패)

```json
{
  "status":    "failed",
  "sessionId": "clx8f3k2j0002qzrm4d1e9f3a",
  "trace":     [],
  "error":     "저장소 접근 중 타임아웃이 발생했습니다"
}
```

**주요 오류 메시지 패턴**

| 오류 메시지 | 원인 |
|------------|------|
| `동일한 requestId로 이미 처리 중인 요청이 있습니다` | 같은 `requestId` 재사용 |
| `세션을 찾을 수 없습니다: {id}` | 잘못된 `sessionId` 또는 서버 재시작 |
| `Reached maximum number of turns` | 분석 중 최대 루프 초과 |
| `타임아웃` | 30초 내 분석 미완료 |

---

### 실제 응답 예시 (실측)

```json
{
  "status":    "done",
  "sessionId": "3259ba88-b59a-4303-9166-ab08cbefd334",
  "type":      "LOGIC_REVIEW",
  "answer":    "인사정보 조회 화면에서 다루는 개인정보를 insa-mapper.xml:383~582 의 selectInsaListSql 쿼리를 기준으로 분석했습니다.\n\n...(분석 내용)...",
  "references": [
    {
      "locator":     "src/main/resources/sqlmap/mapper/insa/insa-mapper.xml:383",
      "description": "파일 읽기: src/main/resources/sqlmap/mapper/insa/insa-mapper.xml"
    }
  ],
  "trace": [
    { "label": "유형 판별",  "detail": "로직 문의", "elapsedMs": 11918 },
    { "label": "저장소 탐색", "detail": "3개 파일", "elapsedMs": 25143 },
    { "label": "응답 작성",                         "elapsedMs": 60282 }
  ],
  "usage": {
    "elapsedMs":  60282,
    "tokens":     5601,
    "filesRead":  1,
    "dbQueries":  0
  }
}
```

---

## 2. 취소

### 기본 정보

| 항목 | 내용 |
|------|------|
| URL | `POST /cancel` |
| Content-Type | `application/json` |

---

### Request

```json
{
  "requestId": "string", // 필수. 취소할 요청의 requestId
  "sessionId": "string"  // 선택. 현재 서버 로직에서는 미사용 (향후 확장 예정)
}
```

---

### Response

```json
{
  "canceled": true
}
```

| `canceled` 값 | 의미 |
|--------------|------|
| `true` | 취소 성공 (실행 중이던 요청이 중단됨) |
| `false` | 취소 실패 (이미 완료됐거나 존재하지 않는 requestId) |

---

### 요청/응답 예시

**Request**
```json
{
  "requestId": "clx8f3k2j0001qzrm9x8a7b2c",
  "sessionId": "clx8f3k2j0002qzrm4d1e9f3a"
}
```

**Response**
```json
{
  "canceled": true
}
```

---

## 3. 상태 확인

### 기본 정보

| 항목 | 내용 |
|------|------|
| URL | `GET /health` |
| 용도 | 운영 모니터링. 처리 중인 요청 수 실시간 확인 |

---

### Request

없음 (파라미터 불필요)

---

### Response

```json
{
  "ok":      true,
  "running": 1,
  "queued":  0
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `ok` | `boolean` | 서버 정상 여부 (현재 항상 `true`) |
| `running` | `number` | 현재 분석 처리 중인 요청 수 |
| `queued` | `number` | 대기 중인 요청 수 (현재 큐 없음, 항상 `0`) |

---

## 부록. 전체 타입 정의 (TypeScript)

```typescript
// ── Request ────────────────────────────────────────────

interface ProcessRequest {
  question:   string;
  memberId:   string;
  requestId:  string;
  sessionId?: string;
  answers?:   Record<string, string>;
}

interface CancelRequest {
  requestId:  string;
  sessionId?: string;
}

// ── Response ───────────────────────────────────────────

type ProcessResponse =
  | DoneResponse
  | WaitingInputResponse
  | FailedResponse;

interface DoneResponse {
  status:      "done";
  sessionId:   string;
  type?:       "LOGIC_REVIEW" | "ERROR_CAUSE";
  answer:      string;
  references:  Reference[];
  trace:       TraceEntry[];
  usage:       Usage;
}

interface WaitingInputResponse {
  status:    "waiting_input";
  sessionId: string;
  type?:     "LOGIC_REVIEW" | "ERROR_CAUSE";
  questions: ClarificationQuestion[];
  trace:     TraceEntry[];
}

interface FailedResponse {
  status:    "failed";
  sessionId: string;
  trace:     TraceEntry[];
  error:     string;
}

// ── 공통 서브타입 ──────────────────────────────────────

interface Reference {
  locator:     string; // "파일경로:줄번호" 또는 "테이블명"
  description: string;
}

interface TraceEntry {
  label:      string;
  detail?:    string;
  elapsedMs:  number;
}

interface Usage {
  elapsedMs:   number;
  tokens?:     number;
  filesRead?:  number;
  dbQueries?:  number;
}

interface ClarificationQuestion {
  question:    string;
  options:     ClarificationOption[];
  multiSelect: boolean;
}

interface ClarificationOption {
  label:       string;
  description: string;
}

interface CancelResponse {
  canceled: boolean;
}

interface HealthResponse {
  ok:      boolean;
  running: number;
  queued:  number;
}
```

---

## 부록. 응답 처리 플로우

```
POST /process
      │
      ▼
  status?
  ├── "done"          → answer 렌더링, references 링크, trace/usage 표시
  │
  ├── "waiting_input" → questions로 선택 UI 렌더링
  │                     사용자 선택 완료
  │                     └─→ POST /process (새 requestId + 기존 sessionId + answers)
  │
  └── "failed"        → error 메시지 표시, 재시도 버튼 제공
                        재시도 시 새 requestId 생성 필수
```_
