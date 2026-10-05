# GET /pompompurin 요청-응답 원리

브라우저 주소창에 `http://localhost:3000/pompompurin`을 입력하면 JSON 텍스트가 화면에 표시되기까지의 흐름입니다.

---

## 전체 흐름 (5단계)

```
[브라우저]  ──HTTP GET /pompompurin──▶  [Fastify 서버]  ──JSON──▶  [브라우저 화면]
```

### 1단계. 서버 기동 — 라우트 등록

```
npm run dev
  → src/index.ts (진입점)
    → buildApp()  (src/server/app.ts)
      → env.enableSandbox === true ?
          YES → import("../sandbox/pompompurin.route.js")
                → app.register(sandboxRoutes)
                → "GET /pompompurin" 경로가 Fastify에 등록됨
          NO  → 스킵 (404 반환)
```

- `.env` 파일에 `ENABLE_SANDBOX=true`가 있어야 등록됩니다.
- `dotenv/config`가 `.env` 파일을 읽어 `process.env`에 넣고, `src/config/env.ts`에서 파싱합니다.

### 2단계. 브라우저가 HTTP 요청을 보냄

```
GET /pompompurin HTTP/1.1
Host: localhost:3000
```

- 브라우저 주소창에 URL을 입력하면 브라우저가 자동으로 **GET** 요청을 보냅니다.
- 서버는 `0.0.0.0:3000`에서 수신 중이므로, localhost(자기 PC)든 같은 네트워크의 다른 PC든 접속 가능합니다.

### 3단계. Fastify가 라우트를 찾아 핸들러 실행

Fastify 내부 동작:

```
수신된 요청: GET /pompompurin
  → 등록된 라우트 테이블에서 "GET /pompompurin" 검색
  → 매칭되는 핸들러 함수 실행
```

핸들러 코드 (`src/sandbox/pompompurin.route.ts`):

```typescript
async () => {
  return {
    message: "Yes",
    from: "musing_jm",
    timestamp: new Date().toISOString(),   // 현재 시각
  };
}
```

- 인증, 권한 확인, DB 조회 등 **아무것도 하지 않습니다**.
- 단순히 JavaScript 객체를 return합니다.

### 4단계. Fastify가 객체를 JSON 문자열로 변환

```
return { message: "Yes", ... }
  → Fastify 내부: JSON.stringify()
  → Content-Type: application/json 헤더 자동 설정
  → HTTP 응답 전송
```

Fastify는 핸들러가 **객체를 return**하면 자동으로:
1. `JSON.stringify()`로 문자열 변환
2. `Content-Type: application/json` 헤더 설정
3. HTTP 200 상태코드로 응답

### 5단계. 브라우저가 JSON을 화면에 표시

```json
{"message":"Yes","from":"musing_jm","timestamp":"2026-09-28T09:00:00.000Z"}
```

브라우저는 `Content-Type: application/json`을 보고 JSON 텍스트를 그대로 화면에 렌더링합니다.

---

## 관련 파일 요약

| 파일 | 역할 |
|------|------|
| `.env` | `ENABLE_SANDBOX=true` 설정 |
| `src/config/env.ts` | `.env` 읽어서 `env.enableSandbox` 값으로 변환 |
| `src/server/app.ts` | `enableSandbox`가 true일 때 sandbox 라우트를 Fastify에 등록 |
| `src/sandbox/pompompurin.route.ts` | GET /pompompurin 핸들러 정의 (Fastify 플러그인) |
| `src/index.ts` | 서버 진입점. `buildApp()` 호출 후 `0.0.0.0:3000`에서 listen |

---

## Swagger UI에서 확인

`http://localhost:3000/docs` 접속 시 **sandbox** 태그 아래에 `GET /pompompurin`이 표시됩니다.
Swagger UI에서 "Try it out" 버튼을 눌러 직접 호출해볼 수도 있습니다.

---

## 기존 inquiry 라우트와의 차이

| 항목 | POST /api/v1/inquiry | GET /pompompurin |
|------|---------------------|-----------------|
| 인증/권한 | memberId, role 검증 | 없음 |
| DB 조회 | MariaDB SELECT | 없음 |
| Git 연동 | ERP 저장소 탐색 | 없음 |
| Claude API | tool_use 루프 실행 | 없음 |
| 응답 생성 | AI가 동적 생성 | 하드코딩된 고정값 |
