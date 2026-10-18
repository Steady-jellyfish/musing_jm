# Anthropic API 토큰 결제 가이드

> Claude API를 사용하면 요청마다 토큰 수에 따라 과금됩니다.  
> 이 문서는 결제 설정부터 비용 모니터링, 이 프로젝트에 적용하는 방법까지 설명합니다.

---

## 1. 결제 설정 (최초 1회)

### 1-1. Anthropic Console 접속

`console.anthropic.com` 접속 → 로그인 (Google 계정 또는 이메일)

### 1-2. 결제 수단 등록

1. 좌측 메뉴 → **Billing** 클릭
2. **Add payment method** → 신용카드 입력
3. 저장 후 **Plans** 탭에서 현재 플랜 확인

### 1-3. 크레딧 충전 (선택)

- Anthropic은 **선불 크레딧** 또는 **후불** 방식 모두 지원
- 선불: **Billing → Add credits** → 금액 입력 후 결제
- 후불: 사용 후 월말 청구 (계정 등급에 따라 다름)

> 처음 가입 시 무료 크레딧($5)이 제공될 수 있습니다. 소진 후 결제 필요.

---

## 2. API Key 발급 및 적용

### 2-1. API Key 발급

1. Console → 좌측 **API Keys** 클릭
2. **Create Key** → 이름 입력 (예: `musing-jm-prod`)
3. 생성된 키 복사 (창을 닫으면 다시 볼 수 없음)

### 2-2. 프로젝트에 적용

`.env` 파일에 입력:
```env
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxx
```

> 이 키는 절대 Git에 커밋하지 마세요. `.gitignore`에 `.env`가 포함되어 있는지 확인하세요.

---

## 3. 현재 사용 모델과 가격

이 프로젝트는 기본적으로 `claude-sonnet-4-6`을 사용합니다 (`.env`의 `CLAUDE_MODEL`).

### claude-sonnet-4-6 가격 (2026년 기준)

| 항목 | 단가 |
|------|------|
| Input tokens | $3.00 / 1M tokens |
| Output tokens | $15.00 / 1M tokens |

### 모델별 비교

| 모델 | Input | Output | 특징 |
|------|-------|--------|------|
| `claude-haiku-4-5` | $0.80 | $4.00 | 가장 저렴, 단순 질의 |
| `claude-sonnet-4-6` | $3.00 | $15.00 | 기본 추천, 균형 잡힌 성능 |
| `claude-opus-4-6` | $15.00 | $75.00 | 가장 정확, 복잡한 분석 |

> 단가는 Anthropic 정책에 따라 변경될 수 있습니다. 최신 가격: `console.anthropic.com/pricing`

---

## 4. 이 프로젝트의 예상 비용

### 요청 1건당 토큰 예시 (ERP 코드 분석)

| 구성 요소 | 예상 토큰 |
|---------|---------|
| 시스템 프롬프트 | ~500 tokens |
| 사용자 질문 | ~50 tokens |
| Tool 호출 (searchCode × 3) | ~300 tokens |
| 코드 파일 읽기 결과 (readFileRange × 5) | ~8,000 tokens |
| DB 쿼리 결과 (executeQuery × 3) | ~2,000 tokens |
| Claude 답변 생성 | ~1,000 tokens |
| **합계 (예시 기준)** | **~12,000 tokens** |

### 월간 비용 추정

| 일 요청 수 | 월 요청 수 | 예상 비용 (Sonnet 기준) |
|-----------|-----------|----------------------|
| 10건 | 300건 | ~$1.5 |
| 50건 | 1,500건 | ~$7.5 |
| 200건 | 6,000건 | ~$30 |
| 1,000건 | 30,000건 | ~$150 |

> 실제 비용은 질문 복잡도, 코드베이스 크기, 되묻기 여부에 따라 크게 달라집니다.

---

## 5. 비용 모니터링

### Console에서 확인

1. `console.anthropic.com` → **Usage** 탭
2. 날짜별, 모델별 토큰 사용량 및 비용 확인 가능
3. **Billing** → 현재 크레딧 잔액 / 청구 예정액 확인

### 지출 한도 설정 (권장)

1. Console → **Billing** → **Usage limits**
2. **Monthly spend limit** 설정 → 초과 시 API 호출 차단
3. 알림 이메일도 설정 가능

---

## 6. 이 프로젝트에서 토큰 사용량 추적

### 현재 상태

현재 응답의 `usage.tokens` 필드가 항상 `undefined`입니다 (미구현).  
`usage.filesRead`, `usage.dbQueries`는 정상 집계됩니다.

### tokens 집계 구현 방법

**파일**: `src/agent/agent-runner.ts`

`for await` 루프 안에서 Agent SDK 메시지의 `usage` 필드를 파싱합니다:

```typescript
// for await 루프 상단에 추가
let totalTokens = 0;

for await (const message of gen) {
  // 기존 코드 ...

  // Agent SDK가 usage 정보를 담아 보내는 경우 파싱
  if (message && typeof message === "object") {
    // result 메시지에서 usage 추출 시도
    if ("usage" in message) {
      const u = (message as {
        usage?: { input_tokens?: number; output_tokens?: number }
      }).usage;
      if (u) {
        totalTokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      }
    }
  }
}

// 반환 시 usage.tokens 채우기
usage: {
  elapsedMs: totalElapsed,
  tokens: totalTokens || undefined,   // 0이면 undefined로 유지
  filesRead,
  dbQueries,
},
```

> Agent SDK가 토큰 정보를 메시지로 노출하는 방식은 SDK 버전마다 다를 수 있습니다.  
> 정확한 집계가 필요하면 Anthropic SDK 직접 호출 경로(`orchestrator/index.ts`)를 사용하는 것이 더 안정적입니다.

---

## 7. 비용 절감 전략

### 모델 전략

```env
# 개발/테스트 환경: 저렴한 모델
CLAUDE_MODEL=claude-haiku-4-5

# 운영 환경: 성능이 필요한 경우
CLAUDE_MODEL=claude-sonnet-4-6
```

### Tool loop 제한

```env
# 기본값 10. 복잡한 분석이 필요 없으면 줄이기
CLAUDE_MAX_TOOL_LOOPS=5
```

루프 1회 감소 = 평균 2,000~3,000 tokens 절약

### 타임아웃 설정

```env
# 기본값 60000ms. 짧게 설정하면 긴 분석을 차단해 비용 절감
CLAUDE_TIMEOUT_MS=30000
```

### Prompt Caching 활용 (고급)

시스템 프롬프트가 반복되는 경우 Anthropic의 Prompt Caching을 사용하면 Input token 비용을 최대 90% 절감할 수 있습니다.  
현재 구조에서 `buildSystemPrompt()`가 매 요청마다 동일한 텍스트를 생성하므로 캐싱 적용 효과가 큽니다.

적용 방법은 Anthropic 공식 문서: `docs.anthropic.com/en/docs/build-with-claude/prompt-caching`

---

## 8. 요금 청구 문제 대응

| 상황 | 대응 |
|------|------|
| 예상보다 많은 비용 | Console Usage에서 어떤 키/시간대에 집중됐는지 확인 |
| API Key 유출 의심 | Console → API Keys → 해당 키 즉시 비활성화 + 새 키 발급 |
| 크레딧 소진으로 API 차단 | Billing → Add credits 충전 |
| 비용 급증 알림 | Billing → Usage limits에서 월 한도 낮게 설정 |
