# API 로컬 테스트 가이드

> 이 문서대로만 따라하면 됩니다. 순서대로 진행하세요.

---

## STEP 1. 패키지 설치

PowerShell에서 프로젝트 폴더로 이동 후 실행합니다.

```powershell
cd C:\00_Project\02_Business\00_Project\musing_jm
npm install
```

완료 메시지 예시:
```
added 123 packages in 5s
```

에러 없이 끝나면 다음 단계로 넘어갑니다.

---

## STEP 2. 서버 실행

```powershell
npm run dev
```

아래처럼 출력되면 정상입니다.

```
{"level":"info","msg":"Server listening at http://[::1]:3000"}
{"level":"info","msg":"Server listening at http://127.0.0.1:3000"}
```

> 이 터미널은 계속 켜두세요. 서버가 살아있는 동안만 요청을 처리합니다.

---

## STEP 3. 서버 상태 확인

**새 PowerShell 창을 열고** 아래를 실행합니다.

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/health" -Method GET
```

정상 응답:
```
ok      : True
running : 0
queued  : 0
```

이게 나오면 서버가 정상 기동된 겁니다.

---

## STEP 4. 질의 처리 테스트 (`/process`)

### 4-1. 기본 질문 보내기

아래를 **한 번에 복사해서 실행**합니다.

```powershell
$body = @{
    question  = "지사수수료계가 0원입니다. 왜 그런가요?"
    memberId  = "hll"
    requestId = "test-001"
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri "http://localhost:3000/process" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body
```

응답이 오는 데 **10~30초 정도** 걸립니다. Claude가 코드/DB를 분석하는 시간입니다.

---

### 응답 결과 해석

#### 정상 응답 (`status: done`)

```
status     : done
sessionId  : xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
type       : ERROR_CAUSE
answer     : 지급규정 개정이 원인입니다. ...
references : {@{locator=PKG_SU_CALC:412; description=...}, ...}
trace      : {@{label=유형 판별; elapsedMs=400}, ...}
usage      : @{elapsedMs=12000; tokens=8500; filesRead=3; dbQueries=2}
```

- `sessionId` → 이 값을 메모해두세요. 되묻기 응답 시 필요합니다.
- `type` → Claude가 판단한 질문 유형 (`LOGIC_REVIEW` 또는 `ERROR_CAUSE`)
- `answer` → 실제 분석 결과
- `usage.tokens` → 이번 요청에 사용된 토큰 수 (비용 추적용)

---

#### 되묻기 응답 (`status: waiting_input`)

질문이 모호하면 Claude가 추가 정보를 요청합니다.

```
status    : waiting_input
sessionId : xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
questions : {@{question=어느 기준으로 조회한 결과인가요?; options=...}}
```

이 경우 **4-2**로 이어서 진행합니다.

---

#### 실패 응답 (`status: failed`)

```
status : failed
error  : 저장소 접근 중 타임아웃이 발생했습니다
```

원인은 아래 **STEP 7. 문제 해결** 참고하세요.

---

### 4-2. 되묻기 응답 보내기 (waiting_input 이후)

`waiting_input` 응답을 받은 경우에만 실행합니다.  
`sessionId` 부분을 **4-1에서 받은 실제 값으로 교체**하고 실행합니다.

```powershell
$body2 = @{
    question  = "지사수수료계가 0원입니다. 왜 그런가요?"
    memberId  = "hll"
    sessionId = "여기에-4-1-응답의-sessionId-붙여넣기"
    requestId = "test-002"
    answers   = @{
        "어느 기준으로 조회한 결과인가요?" = "지사 소계"
    }
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri "http://localhost:3000/process" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body2
```

> `requestId`는 반드시 새 값(`test-002`)으로 바꿔야 합니다. 같은 값을 쓰면 중복 요청으로 차단됩니다.

---

## STEP 5. 취소 테스트 (`/cancel`)

처리 중인 요청을 취소하고 싶을 때 사용합니다.

### 5-1. 취소할 요청 먼저 백그라운드로 실행

```powershell
$cancelTestBody = @{
    question  = "전체 수수료 계산 로직을 처음부터 끝까지 모두 설명해주세요"
    memberId  = "hll"
    requestId = "cancel-test-001"
} | ConvertTo-Json -Compress

# 백그라운드로 실행 (응답 안 기다림)
Start-Job -ScriptBlock {
    Invoke-RestMethod -Uri "http://localhost:3000/process" `
        -Method POST `
        -ContentType "application/json" `
        -Body $using:cancelTestBody
}
```

### 5-2. 바로 취소 요청

```powershell
$cancelBody = @{
    requestId = "cancel-test-001"
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri "http://localhost:3000/cancel" `
    -Method POST `
    -ContentType "application/json" `
    -Body $cancelBody
```

정상 응답:
```
canceled : True
```

이미 완료된 요청이면 `canceled : False`가 반환됩니다.

---

## STEP 6. Swagger UI (브라우저)

브라우저에서 아래 주소를 엽니다.

```
http://localhost:3000/docs
```

화면에서 할 수 있는 것:
- **process** 태그 클릭 → `/process`, `/cancel`, `/health` 엔드포인트 목록
- **Try it out** 버튼 → 요청 파라미터 직접 입력 후 실행 가능
- 응답 스키마 확인

---

## STEP 7. 문제 해결

### 서버가 안 켜질 때

**증상**: `npm run dev` 실행 시 에러 발생

```powershell
# API Key 확인 (값이 비어있으면 .env 수정 필요)
Select-String -Path .env -Pattern "ANTHROPIC_API_KEY"
```

`.env` 파일에 `ANTHROPIC_API_KEY=sk-ant-...` 값이 있어야 합니다.

---

### `Cannot POST /process` 에러

서버가 실행 중인지 확인합니다.

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/health"
```

응답이 없으면 `npm run dev` 실행 중인 터미널을 확인하세요.

---

### `status: failed` — 타임아웃

현재 타임아웃이 **30초**로 설정되어 있습니다.  
복잡한 질문은 30초를 초과할 수 있습니다. `.env`에서 늘릴 수 있습니다.

```
CLAUDE_TIMEOUT_MS=60000
```

변경 후 서버 재시작 (`Ctrl+C` → `npm run dev`).

---

### `status: failed` — 동일한 requestId

재시도 시 **반드시 새 requestId**를 써야 합니다.

```powershell
# 매번 새 ID 생성하는 방법
$newRequestId = [System.Guid]::NewGuid().ToString()
Write-Host "requestId: $newRequestId"
```

---

### Git 저장소 / DB 없이 테스트할 때

ERP Git URL과 DB 설정이 없어도 API 자체는 동작합니다.  
Claude가 코드/DB 없이 답변하므로 "근거를 찾을 수 없습니다" 형태로 응답합니다.

---

## 빠른 참고

| 항목 | 값 |
|------|---|
| 서버 주소 | `http://localhost:3000` |
| Swagger UI | `http://localhost:3000/docs` |
| 현재 모델 | `claude-haiku-4-5-20251001` |
| 타임아웃 | 30초 |
| 최대 도구 루프 | 3회 |
| 서버 재시작 | 서버 터미널에서 `Ctrl+C` → `npm run dev` |
