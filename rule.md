# Notion 문서 생성 규칙 — musing_jm 프로젝트

이 프로젝트에서 Notion 문서 생성 요청이 들어오면 아래 기본값을 항상 적용한다.

## 기본 등록 위치

| 항목 | 값 |
|------|----|
| 워크스페이스 | Genexon (240415~) |
| 데이터베이스 | 📚 참고사항 |
| data_source_id | `b004a65e-ca5c-49fe-86c9-8040b59e9f5d` |

## 기본 프로퍼티 값

| 프로퍼티 | 기본값 | 비고 |
|----------|--------|------|
| `구분` | `03_Other`, `06_Side_Project` | multi_select, 두 개 모두 태그 |
| `Page` | `3Page` | multi_select |
| `소분류` | `musing` | multi_select |
| `날짜` | 문서 작성 당일 | ISO 8601 형식 (예: 2026-09-13) |
| `상태` | `작성 완료` | 초안이면 `작성 중` |

## 페이지 생성 시 참고

```json
{
  "parent": {
    "type": "data_source_id",
    "data_source_id": "b004a65e-ca5c-49fe-86c9-8040b59e9f5d"
  },
  "pages": [{
    "properties": {
      "title": "페이지 제목",
      "구분": ["03_Other", "06_Side_Project"],
      "Page": ["3Page"],
      "소분류": ["musing"],
      "날짜": "YYYY-MM-DD",
      "상태": "작성 완료"
    }
  }]
}
```

## 예외 케이스

- 사용자가 다른 `구분`을 명시하면 해당 값 사용 (위 기본값 대체)
- `소분류`에 세부 분류가 필요하면 `musing` + 추가 태그 병기
- 초안 작성 시 `상태` = `작성 중`으로 설정 후 완료 시 `작성 완료`로 업데이트
