# Musing_jm

Musing 프로젝트에서 **자연어 가공 및 MCP 오케스트레이션**을 담당하는 서버입니다.

사용자의 자연어 문의를 받아 문의 유형을 판별하고, 관련 참고자료(지식베이스 / 회원사 DB / 처리 이력)를 조회해 컨텍스트를 붙인 뒤, Claude Code가 가장 정확하고 효과적으로 처리할 수 있는 형태로 재구성하여 MCP를 통해 전달하는 역할을 합니다.

## 배경

Musing은 현업 이슈를 기획자를 거쳐 자동으로 처리하는 사내 업무 처리 엔진입니다. 전체 흐름에서 입출력 처리(자연어 수신, 결과 반환)와 실제 가공·판단 로직은 역할이 나뉘어 있으며, 이 저장소는 그중 **자연어 가공 + MCP 서버 관리**를 담당합니다.

```
현업 이슈 → 기획자 → Musing (기획 검토 → 개발 처리)

  입출력 처리 (자연어 수신/결과 반환)
        ↓ 원시 자연어 그대로 전달
  Musing_jm (본 저장소)
    ├─ 문의 유형 판별
    ├─ 참고자료/규정 확인 (MCP)
    └─ Claude Code용 프롬프트 재구성
        ↓ MCP로 전달
  Claude Code
    └─ 지식베이스 / 회원사 DB / GitLab Repo 참조
        ↓ 응답
  입출력 처리로 결과 반환
```

## 주요 역할

- **자연어 가공(Preprocessor)**: 원시 자연어 문의를 분석해 문의 유형을 판별하고 처리 가능한 형태로 재구성
- **참고자료 확인(Reference Resolver)**: 지식베이스, 회원사 DB, 기존 처리 이력을 MCP로 조회해 컨텍스트 수집
- **MCP 오케스트레이션**: 가공된 내용을 Claude Code에 MCP로 전달하고 응답을 처리

## 기술 스택

- TypeScript
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- Claude Code (SDK / CLI)

## 폴더 구조

```
src/
├── preprocess/     # 자연어 판별·가공 로직
├── mcp-servers/    # 역할별 MCP 서버 (knowledge-base, member-db, history)
├── orchestrator/   # 여러 MCP 조합 + Claude Code 호출 흐름 제어
├── config/         # 연결 정보 (실제 값은 .env로 분리)
└── index.ts        # 진입점
```

## 시작하기

```bash
# 의존성 설치
npm install

# TypeScript 빌드
npx tsc

# 개발 실행
npx ts-node src/index.ts
```

환경 변수는 `.env.example`을 참고해 `.env` 파일로 구성합니다. (DB 접속 정보 등 민감 정보는 커밋하지 않습니다.)

## 상태

🚧 초기 스캐폴딩 단계 — MCP 서버(mock 데이터 기반) 구성 중

## 관련 역할 분담

- 입출력 처리: 한상민
- 자연어 가공 / MCP 서버 관리: 김지민 (본 저장소)
