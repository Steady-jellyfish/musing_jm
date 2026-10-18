# 프론트엔드 → 백엔드 데이터 요구사항

> `/process`, `/cancel`, `/health` API를 기준으로 Front가 준비해야 하는 데이터를 정리합니다.

---

## 1. `/process` — 질의 처리

### 요청 필드별 책임 주체

| 필드 | 타입 | 필수 | 생성 주체 | 설명 |
|------|------|------|----------|------|
| `question` | `string` | ✅ | 사용자 입력 | 채팅창에서 사용자가 직접 입력한 자연어 질문 |
| `memberId` | `string` | ✅ | **Front 발급/보관** | 로그인 시 발급된 회원사 ID. 세션/쿠키에서 읽어야 함 |
| `requestId` | `string` | ✅ | **Front 발급** | 요청마다 프론트가 새로 생성하는 고유 ID (cuid/uuid 등) |
| `sessionId` | `string` | 선택 | **Back 발급 후 Front 보관** | 첫 요청은 없이 보내고, 응답에서 받은 값을 이후 요청에 포함 |
| `answers` | `Record<string, string>` | 선택 | 사용자 입력 | `waiting_input` 응답에서 받은 질문에 대한 사용자 선택. `{ 질문 텍스트: 선택한 라벨 }` 형식 |

### `requestId` 발급 규칙

- 요청마다 **새로 생성**해야 합니다.
- 취소(Cancel)를 위해 Front가 보관해야 합니다.
- 추천 라이브러리: `cuid2` (`@paralleldrive/cuid2`) 또는 `uuid`

```typescript
// 예시
import { createId } from '@paralleldrive/cuid2';
const requestId = createId(); // "clx8f3k2j0001qzrm9x8a7b2c"
```

- **재시도 시**: 동일 `requestId`로 재전송하면 서버가 **중복 요청으로 차단**합니다.  
  재시도는 반드시 **새 `requestId`를 생성**해서 보내야 합니다.

### `sessionId` 관리 규칙

```
[첫 질문]
Front → POST /process { question, memberId, requestId }   // sessionId 없음
Back  → { sessionId: "abc-123", ... }                    // sessionId 발급
Front → localStorage 또는 상태에 sessionId 저장

[후속 질문 또는 되묻기 응답]
Front → POST /process { question, memberId, requestId, sessionId: "abc-123", answers?: {...} }
Back  → { sessionId: "abc-123", ... }                    // 동일 sessionId 반환
```

- 하나의 채팅방 = 하나의 `sessionId`
- 페이지 새로고침 또는 채팅방 전환 시 새 채팅은 `sessionId` 없이 보내면 됩니다.
- `sessionId`가 없는 첫 요청은 서버가 자동으로 새 세션을 생성합니다.

### `answers` 구성 규칙

`waiting_input` 응답을 받으면, Front는 UI에 질문과 선택지를 표시하고 사용자 선택을 수집합니다.

응답 예시:
```json
{
  "status": "waiting_input",
  "questions": [
    {
      "question": "어느 기준으로 조회한 결과인가요?",
      "options": [
        { "label": "지사 소계", "description": "지사 단위로 합산한 화면 기준" },
        { "label": "개인별 내역", "description": "설계사 개인 단위 명세 기준" }
      ],
      "multiSelect": false
    }
  ]
}
```

사용자가 "지사 소계"를 선택했을 때 재요청:
```json
{
  "question": "지사수수료계가 0원입니다. 왜 그런가요?",
  "memberId": "hll",
  "sessionId": "clx8f3k2j0002qzrm4d1e9f3a",
  "requestId": "clx8f3k2j0001NEW",
  "answers": {
    "어느 기준으로 조회한 결과인가요?": "지사 소계"
  }
}
```

> `answers`의 키는 `questions[].question` 텍스트 그대로, 값은 `options[].label` 중 선택한 값입니다.

---

## 2. `/cancel` — 요청 취소

### 요청 필드별 책임 주체

| 필드 | 타입 | 필수 | 생성 주체 | 설명 |
|------|------|------|----------|------|
| `requestId` | `string` | ✅ | **Front 보관** | 취소할 요청의 requestId. `/process` 호출 시 사용한 값과 동일 |
| `sessionId` | `string` | 선택 | Front 보관 | 세션 컨텍스트 제공용 (현재 서버에서 취소 로직에 사용하지 않음) |

### 취소 타이밍

- `/process` 호출 후 응답을 기다리는 중에 사용자가 취소 버튼을 누르면 호출
- 이미 완료된 요청에 취소를 보내면 `{ "canceled": false }` 반환 (정상 동작)

---

## 3. `/health` — 상태 확인

- 요청 파라미터 없음 (GET 요청)
- Front에서 운영 모니터링 화면 또는 연결 상태 표시에 사용

---

## 4. 응답 처리 분기 로직

Front는 `status` 필드를 기준으로 UI를 분기합니다.

```typescript
type ProcessResponse = {
  status: "done" | "waiting_input" | "failed";
  sessionId: string;
  type?: "LOGIC_REVIEW" | "ERROR_CAUSE";

  // status === "done"
  answer?: string;
  references?: { locator: string; description: string }[];
  trace?: { label: string; detail?: string; elapsedMs: number }[];
  usage?: { elapsedMs: number; tokens?: number; filesRead?: number; dbQueries?: number };

  // status === "waiting_input"
  questions?: {
    question: string;
    options: { label: string; description: string }[];
    multiSelect: boolean;
  }[];

  // status === "failed"
  error?: string;
};
```

| `status` | Front 동작 |
|---------|----------|
| `done` | `answer` 표시, `references` 링크, `trace`/`usage` 선택 표시 |
| `waiting_input` | `questions`로 선택 UI 렌더링 → 사용자 선택 후 `answers`와 함께 재요청 |
| `failed` | `error` 메시지 표시, 재시도 버튼 제공 |

---

## 5. Front에서 보관해야 할 상태 목록

| 상태 | 보관 위치 | 설명 |
|------|----------|------|
| `memberId` | 로그인 세션 (쿠키/JWT) | 매 요청마다 포함 필요 |
| `sessionId` | 채팅방 상태 (useState 등) | 채팅방별로 관리 |
| `requestId` | 현재 진행 중인 요청 상태 | 취소 시 필요 |
| `waiting_input` 시의 `questions` | 채팅방 상태 | 재요청 시 `answers` 구성에 필요 |

---

## 6. API 호출 순서 다이어그램

```
사용자 입력
    │
    ▼
[requestId 생성]
    │
    ▼
POST /process { question, memberId, requestId }
    │
    ├── status: "done"         → 답변 표시 후 종료
    │
    ├── status: "waiting_input" → 질문 UI 표시
    │                              사용자 선택
    │                              POST /process { ..., sessionId, answers }
    │                              (새 requestId 필수)
    │
    └── status: "failed"       → 에러 표시 + 재시도 버튼
                                  재시도 시 새 requestId 생성
```
