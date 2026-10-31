# 테스트 가이드

> 이 문서 순서대로만 따라오면 됩니다.  
> 한 번 세팅하면 이후 시나리오는 복붙으로 바로 실행 가능합니다.

---

## 준비물

- PowerShell (Windows 기본 내장)
- 서버가 실행 중일 것 (STEP 1 참고)

---

## STEP 1. 서버 실행

**PowerShell 창 하나를 열고** 아래 실행:

```powershell
cd C:\00_Project\02_Business\00_Project\musing_jm
npm run dev
```

이렇게 뜨면 정상:

```
{"level":"info","msg":"Server listening at http://127.0.0.1:3000"}
```

> ⚠️ 이 터미널은 계속 켜둬야 합니다. 닫으면 서버도 꺼집니다.

---

## STEP 2. 서버 상태 확인

**새 PowerShell 창을 열고** 아래 실행:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/health"
```

정상 응답:

```
ok      : True
running : 0
queued  : 0
```

---

## STEP 3. 헬퍼 함수 등록 (딱 한 번만)

> 이 프로젝트는 **SSE 스트림** 방식으로 응답합니다.  
> 일반 요청과 달리 응답이 실시간으로 조금씩 흘러옵니다.  
> 아래 함수를 등록하면 이걸 읽기 쉽게 출력해줍니다.

**새 PowerShell 창에서 아래를 한 번에 복붙해서 실행:**

```powershell
function Invoke-SSE {
    param(
        [string]$Body,
        [switch]$Verbose
    )

    $req = [System.Net.HttpWebRequest]::Create("http://localhost:3000/process")
    $req.Method = "POST"
    $req.ContentType = "application/json"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $req.ContentLength = $bytes.Length
    $s = $req.GetRequestStream()
    $s.Write($bytes, 0, $bytes.Length)
    $s.Close()

    $res = $req.GetResponse()
    $reader = New-Object System.IO.StreamReader($res.GetResponseStream())

    $sessionId = ""
    $lastEvent = ""

    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line.StartsWith("event:")) {
            $lastEvent = $line.Substring(6).Trim()
        }
        elseif ($line.StartsWith("data:")) {
            $json = $line.Substring(5).Trim() | ConvertFrom-Json

            switch ($lastEvent) {
                "connected" {
                    $sessionId = $json.sessionId
                    Write-Host ""
                    Write-Host "[ 연결됨 ] sessionId: $($json.sessionId)" -ForegroundColor DarkGray
                }
                "trace" {
                    Write-Host "  > $($json.label)" -NoNewline -ForegroundColor DarkYellow
                    if ($json.detail) { Write-Host ": $($json.detail)" -NoNewline -ForegroundColor DarkGray }
                    Write-Host " ($($json.elapsedMs)ms)" -ForegroundColor DarkGray
                }
                "clarification" {
                    Write-Host ""
                    Write-Host "[ 되묻기 ] Claude가 추가 정보를 요청합니다:" -ForegroundColor Magenta
                    $json.questions | ForEach-Object {
                        Write-Host "  질문: $($_.question)" -ForegroundColor Magenta
                        $_.options | ForEach-Object {
                            Write-Host "    - $($_.label): $($_.description)" -ForegroundColor DarkMagenta
                        }
                    }
                    Write-Host ""
                    Write-Host "  → answers 에 선택한 라벨을 담아 재요청하세요." -ForegroundColor DarkGray
                }
                "done" {
                    Write-Host ""
                    Write-Host "[ 답변 완료 ]" -ForegroundColor Green
                    Write-Host $json.answer -ForegroundColor White
                    if ($json.references -and $json.references.Count -gt 0) {
                        Write-Host ""
                        Write-Host "[ 참조 ]" -ForegroundColor DarkGreen
                        $json.references | ForEach-Object {
                            Write-Host "  $($_.locator)" -ForegroundColor DarkGray
                        }
                    }
                    if ($json.usage) {
                        Write-Host ""
                        Write-Host "[ 사용량 ] $($json.usage.elapsedMs)ms | 토큰: $($json.usage.tokens) | 파일: $($json.usage.filesRead) | DB: $($json.usage.dbQueries)" -ForegroundColor DarkGray
                    }
                }
                "error" {
                    Write-Host ""
                    Write-Host "[ 오류 ] $($json.error)" -ForegroundColor Red
                }
            }
        }
    }
    $reader.Close()
    return $sessionId
}
```

실행하면 아무 출력 없이 넘어갑니다. 정상입니다.

---

## STEP 4. 테스트 시나리오

> `$sid` 변수에 sessionId가 자동 저장되므로 두 번째 질문부터는 그냥 복붙만 하면 됩니다.

---

### 시나리오 1 — 수수료 오류 원인 찾기 (되묻기 포함)

**이런 상황:** 지사수수료가 0원으로 나올 때 원인을 찾는 시나리오.  
Claude가 정보가 부족하면 되묻기를 할 수 있습니다.

**1번 질문:**

```powershell
$sid = Invoke-SSE -Body '{
  "question":  "지사수수료계가 0원으로 표시되고 있습니다. 왜 그런가요?",
  "memberId":  "hll",
  "requestId": "s1-001"
}'
```

**[ 되묻기가 온 경우 ]**  
출력에서 `[ 되묻기 ]` 가 보이면 → Claude가 제시한 선택지 중 하나를 골라서 아래 `answers` 에 입력 후 실행:

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"지사수수료계가 0원으로 표시되고 있습니다. 왜 그런가요?`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s1-002`",
  `"answers`":   {`"어느 기간 얘기인가요?`": `"2026년 1월`"}
}"
```

> `answers` 의 키는 Claude가 물어본 질문 텍스트, 값은 선택지 라벨로 수정하세요.

**답변이 나온 후 follow-up:**

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"수수료 계산할 때 어떤 조건이 충족되어야 금액이 채워지나요?`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s1-003`"
}"
```

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"그 조건이 DB에서 어떤 테이블에 저장되어 있나요?`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s1-004`"
}"
```

---

### 시나리오 2 — 급여 정산 로직 탐색 (3턴 연속 대화)

**이런 상황:** 급여 계산 로직을 단계적으로 파고드는 시나리오.  
매 답변 후 더 깊은 질문을 이어가며 대화 맥락이 유지되는지 확인합니다.

```powershell
$sid = Invoke-SSE -Body '{
  "question":  "직원 월급 정산 로직이 어떻게 구현되어 있나요? settlement 쪽 코드를 봐주세요.",
  "memberId":  "hll",
  "requestId": "s2-001"
}'
```

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"정산할 때 원천징수 금액은 어떻게 계산되나요?`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s2-002`"
}"
```

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"withholding 관련 DB 테이블 구조도 알려줄 수 있어요?`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s2-003`"
}"
```

---

### 시나리오 3 — 계약 수금 오류 (되묻기 유도)

**이런 상황:** 수금 처리가 안 될 때 원인을 좁혀나가는 시나리오.  
일부러 모호하게 질문해서 되묻기가 발생하는지 테스트합니다.

```powershell
$sid = Invoke-SSE -Body '{
  "question":  "이번 달 수금이 안 되고 있습니다. contractsugum 쪽 문제인 것 같은데 원인을 찾아주세요.",
  "memberId":  "hll",
  "requestId": "s3-001"
}'
```

되묻기 응답 후:

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"수금 처리 로직에서 실패가 나면 어떤 상태값으로 바뀌나요? 코드에서 찾아주세요.`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s3-002`"
}"
```

---

### 시나리오 4 — 실적 집계 로직 탐색 (3턴)

**이런 상황:** 영업 실적 집계 방식과 보조금 지급 조건을 단계적으로 확인합니다.

```powershell
$sid = Invoke-SSE -Body '{
  "question":  "영업 실적이 어떻게 집계되는지 performance 쪽 로직을 설명해주세요.",
  "memberId":  "hll",
  "requestId": "s4-001"
}'
```

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"실적 기준으로 보조금(subsidy)은 어떤 조건에서 지급되나요?`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s4-002`"
}"
```

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"실적이 0으로 나오는 경우는 코드에서 어떤 케이스로 처리되고 있나요?`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s4-003`"
}"
```

---

### 시나리오 5 — 월마감 처리 흐름 탐색 (3턴)

**이런 상황:** 월마감 로직의 전체 흐름을 파악하고 배치 연관성까지 확인합니다.

```powershell
$sid = Invoke-SSE -Body '{
  "question":  "월 마감(closemonth) 처리가 어떤 순서로 이루어지는지 코드 흐름을 설명해주세요.",
  "memberId":  "hll",
  "requestId": "s5-001"
}'
```

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"마감 처리 중에 배치 작업(taskschedule)이 연관되어 있나요? 있다면 어떻게 연결되어 있나요?`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s5-002`"
}"
```

```powershell
$sid = Invoke-SSE -Body "{
  `"question`":  `"마감이 완료된 이후에 데이터를 수정하려고 하면 어떻게 처리되나요? 잠금 로직이 있나요?`",
  `"memberId`":  `"hll`",
  `"sessionId`": `"$sid`",
  `"requestId`": `"s5-003`"
}"
```

---

## STEP 5. 출력 읽는 법

```
[ 연결됨 ] sessionId: abc-123-...     ← 이 세션ID로 대화가 이어집니다

  > 유형 판별: 오류 원인 확인 (45ms)  ← Claude가 질문 유형 파악
  > 저장소 탐색: settlement.java (1230ms)  ← 파일 뒤지는 중
  > DB 조회: tb_settlement (3400ms)    ← DB 보는 중

[ 답변 완료 ]                          ← 여기서부터 실제 답변
매출은 sales 테이블의 amount 컬럼...

[ 참조 ]                               ← Claude가 근거로 사용한 파일/테이블
  src/main/java/kr/co/gnx/insa/settlement/...java:123
  tb_settlement

[ 사용량 ] 8400ms | 토큰: 5200 | 파일: 3 | DB: 2
```

---

## STEP 6. 취소하고 싶을 때

요청이 너무 오래 걸리면 다른 PowerShell 창에서:

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3000/cancel" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"requestId": "s2-001"}'
```

> `requestId` 는 취소하고 싶은 요청의 값으로 바꾸세요.

---

## 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| 함수 실행해도 아무것도 안 나옴 | 서버가 꺼진 것 | STEP 1로 돌아가서 서버 재시작 |
| `Invoke-SSE` 를 모른다고 함 | STEP 3 함수 등록을 안 함 | STEP 3 복붙 후 재시도 |
| 응답이 10초 이상 안 나옴 | Claude가 분석 중 (정상) | trace 이벤트가 흘러오면 기다리면 됨 |
| `status: failed` — 동일 requestId | 같은 requestId 재사용 | `s2-001` → `s2-011` 처럼 숫자 바꾸기 |
| 되묻기(clarification) 후 막힘 | answers 형식 오류 | 키 = Claude가 물어본 질문 그대로, 값 = 선택지 라벨 그대로 |
