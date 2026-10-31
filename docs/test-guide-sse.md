# SSE 테스트 가이드

> `/process` 엔드포인트는 SSE(Server-Sent Events) 스트림으로 응답합니다.
> `Invoke-RestMethod`는 전체 응답을 기다리기 때문에 SSE 실시간 흐름을 보려면 아래 방법을 씁니다.

---

## 서버 먼저 실행

```powershell
cd C:\00_Project\02_Business\00_Project\musing_jm
npm run dev
```

---

## STEP 1. 기본 SSE 스트림 확인

PowerShell에서 SSE 이벤트를 실시간으로 출력하는 스크립트:

```powershell
$body = '{"question":"매출 계산 로직이 어떻게 되어 있나요?","memberId":"HANWHA_LIFELAB","requestId":"test-001"}'

$request = [System.Net.HttpWebRequest]::Create("http://localhost:3000/process")
$request.Method = "POST"
$request.ContentType = "application/json"
$request.Accept = "text/event-stream"

$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
$request.ContentLength = $bytes.Length
$stream = $request.GetRequestStream()
$stream.Write($bytes, 0, $bytes.Length)
$stream.Close()

$response = $request.GetResponse()
$reader = New-Object System.IO.StreamReader($response.GetResponseStream())

Write-Host "=== SSE 스트림 시작 ===" -ForegroundColor Cyan
while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ($line -ne "") {
        if ($line.StartsWith("event:")) {
            Write-Host $line -ForegroundColor Yellow
        } elseif ($line.StartsWith("data:")) {
            $json = $line.Substring(5).Trim() | ConvertFrom-Json
            Write-Host ($json | ConvertTo-Json -Depth 5) -ForegroundColor White
        }
    }
}
Write-Host "=== SSE 스트림 종료 ===" -ForegroundColor Cyan
$reader.Close()
```

**예상 출력:**
```
=== SSE 스트림 시작 ===
event: connected
{
  "sessionId": "abc-123-..."
}
event: trace
{
  "label": "유형 판별",
  "detail": "로직 문의",
  "elapsedMs": 45
}
event: trace
{
  "label": "저장소 탐색",
  "detail": "src/sale/calc.ts",
  "elapsedMs": 1230
}
event: done
{
  "answer": "매출은 sales 테이블의...",
  "references": [...],
  "usage": { "elapsedMs": 8400, "tokens": 5200 }
}
=== SSE 스트림 종료 ===
```

---

## STEP 2. sessionId 추출 후 연속 대화 테스트

```powershell
# ── 함수 정의: SSE 요청 보내고 sessionId 반환 ──────────────
function Invoke-SSE {
    param(
        [string]$Body,
        [switch]$PrintAll
    )
    $request = [System.Net.HttpWebRequest]::Create("http://localhost:3000/process")
    $request.Method = "POST"
    $request.ContentType = "application/json"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $request.ContentLength = $bytes.Length
    $s = $request.GetRequestStream()
    $s.Write($bytes, 0, $bytes.Length)
    $s.Close()

    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())

    $sessionId = ""
    $lastEvent = ""

    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line.StartsWith("event:")) {
            $lastEvent = $line.Substring(6).Trim()
            if ($PrintAll) { Write-Host "[$lastEvent]" -ForegroundColor Yellow }
        } elseif ($line.StartsWith("data:")) {
            $json = $line.Substring(5).Trim() | ConvertFrom-Json
            if ($lastEvent -eq "connected") { $sessionId = $json.sessionId }
            if ($PrintAll) { Write-Host ($json | ConvertTo-Json -Depth 5) }
            elseif ($lastEvent -eq "done") {
                Write-Host "`n[답변]" -ForegroundColor Green
                Write-Host $json.answer
            } elseif ($lastEvent -eq "clarification") {
                Write-Host "`n[되묻기]" -ForegroundColor Magenta
                $json.questions | ForEach-Object { Write-Host "  Q: $($_.question)" }
            }
        }
    }
    $reader.Close()
    return $sessionId
}

# ── 첫 번째 질문 ───────────────────────────────────────────
Write-Host "`n=== 첫 번째 질문 ===" -ForegroundColor Cyan
$body1 = '{"question":"매출 계산 로직이 어떻게 되어 있나요?","memberId":"HANWHA_LIFELAB","requestId":"test-001"}'
$sid = Invoke-SSE -Body $body1
Write-Host "`nsessionId: $sid" -ForegroundColor DarkGray

# ── 두 번째 질문 (이전 맥락 유지) ─────────────────────────
Write-Host "`n=== 두 번째 질문 (follow-up) ===" -ForegroundColor Cyan
$body2 = "{`"question`":`"그럼 부가세는 어떻게 계산되나요?`",`"memberId`":`"HANWHA_LIFELAB`",`"sessionId`":`"$sid`",`"requestId`":`"test-002`"}"
$sid = Invoke-SSE -Body $body2

# ── 세 번째 질문 ───────────────────────────────────────────
Write-Host "`n=== 세 번째 질문 ===" -ForegroundColor Cyan
$body3 = "{`"question`":`"혹시 관련된 DB 테이블도 알려줄 수 있어요?`",`"memberId`":`"HANWHA_LIFELAB`",`"sessionId`":`"$sid`",`"requestId`":`"test-003`"}"
Invoke-SSE -Body $body3
```

---

## STEP 3. 되묻기(clarification) 테스트

```powershell
# 모호한 질문 → clarification 이벤트 유도
Write-Host "=== 되묻기 테스트 ===" -ForegroundColor Cyan
$body1 = '{"question":"매출이 왜 이상하죠?","memberId":"HANWHA_LIFELAB","requestId":"test-010"}'
$sid = Invoke-SSE -Body $body1 -PrintAll

# clarification 이벤트가 오면 answers로 재요청
# (위 출력에서 question 값 확인 후 아래 answers 수정)
Write-Host "`n=== 되묻기 답변 ===" -ForegroundColor Cyan
$body2 = "{
  `"question`": `"매출이 왜 이상하죠?`",
  `"memberId`": `"HANWHA_LIFELAB`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"test-011`",
  `"answers`": {`"어느 기간 얘기인가요?`": `"2026년 1월`"}
}"
Invoke-SSE -Body $body2
```

---

## STEP 4. 취소 테스트

터미널 2개를 열어서 진행합니다.

**터미널 A** — 오래 걸리는 요청 시작:
```powershell
$body = '{"question":"전체 ERP 수수료 계산 로직을 처음부터 끝까지 모두 설명해주세요","memberId":"HANWHA_LIFELAB","requestId":"cancel-test-001"}'
# 위의 Invoke-SSE 함수 먼저 정의한 후:
Invoke-SSE -Body $body -PrintAll
```

**터미널 B** — 즉시 취소:
```powershell
$cancelBody = '{"requestId":"cancel-test-001"}' | ConvertFrom-Json | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://localhost:3000/cancel" -Method POST -ContentType "application/json" -Body $cancelBody
```

정상 응답:
```
canceled : True
```

터미널 A의 스트림이 즉시 끊기면 성공.

---

## STEP 5. 이벤트별 응답 구조

### connected
```json
{ "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
```
→ 이 sessionId를 저장해두면 연속 대화 가능

### trace
```json
{ "label": "유형 판별", "detail": "로직 문의", "elapsedMs": 45 }
{ "label": "저장소 탐색", "detail": "src/sale/calc.ts", "elapsedMs": 1230 }
{ "label": "DB 조회", "detail": "sales", "elapsedMs": 3400 }
```
→ 도구가 호출될 때마다 실시간으로 전달됨

### done
```json
{
  "answer": "매출은 sales 테이블의 amount 컬럼 합계로...",
  "references": [
    { "locator": "src/sale/calc.ts:123", "description": "파일 읽기: src/sale/calc.ts" },
    { "locator": "sales", "description": "DB 조회: sales" }
  ],
  "type": "LOGIC_REVIEW",
  "usage": {
    "elapsedMs": 8400,
    "tokens": 5200,
    "filesRead": 3,
    "dbQueries": 2
  }
}
```

### clarification
```json
{
  "type": "ERROR_CAUSE",
  "questions": [
    {
      "question": "어느 기간 얘기인가요?",
      "options": [
        { "label": "2026년 1월", "description": "전월" },
        { "label": "2026년 2월", "description": "당월" }
      ],
      "multiSelect": false
    }
  ]
}
```
→ `answers: { "질문 텍스트": "선택한 label" }` 로 재요청

### error
```json
{ "sessionId": "...", "error": "오류 메시지" }
```

---

## 빠른 참고

| 항목 | 값 |
|------|---|
| 서버 주소 | `http://localhost:3000` |
| SSE 엔드포인트 | `POST /process` |
| 취소 | `POST /cancel` |
| 상태 확인 | `GET /health` |
| Swagger UI | `http://localhost:3000/docs` |
| requestId | 요청마다 반드시 다른 값 사용 |
