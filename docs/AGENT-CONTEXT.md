agent_context:
  version: 1
  role: "runtime-owner"
  language: ko-KR

  entry:
    open: ["GEMINI.md", "AGENTS.md", "docs/ARCHITECTURE.md"]
    navigation: "작업 성격에 따라 docs/POLICIES.md(정책), docs/VERIFICATION.md(검증/증거), docs/OPERATIONS.md(운영/런북), docs/HOSTS.md(호스트 어댑터)를 참조한다."
    budget: "필요한 절만 읽고, 반복 탐색하지 않는다."

  task:
    classification:
      agent_docs_local_only: "에이전트 문서만 bounded edit -> fresh verification (npm run check) -> 보고. 원격 issue/branch/commit/PR 없음."
      new_tracked_work: "계획서(plan) -> issue -> main 기반 short-lived branch -> 구현/검증 -> commit/push -> PR -> automerge."
      open_pr_followup: "기존 issue/branch/PR 재사용하여 후속 작업 진행."
      local_only: "로컬 설정, 진단, 작업 메모는 필요한 최소 수정과 검증으로 완료하며 원격 효과를 요구하지 않는다."

  hard_invariants:
    functional_core: "src/engine.mjs는 파일 I/O나 명령 실행을 포함하지 않는 순수 정책 평가 엔진으로 유지한다."
    zero_dependencies: "package.json 내 런타임 및 개발 의존성을 추가하지 않고 Node.js 22+ 내장 모듈만 사용한다."
    fail_closed: "정책 평가 오류나 신뢰 실패 시 임의의 allow로 조용히 대체하지 않고 명확한 에러/거부를 반환한다."
    bilingual_docs: "README.md 수정 시 반드시 README.ko.md를 정렬한다."

  execution:
    start:
      - "task classification과 최소 범위를 확정한다. agent 문서 local-only는 원격 효과 없이 바로 편집/검증한다."
      - "tracked 작업은 plan/issue를 동기화하고 새 작업이면 main에서 branch를 생성한다."
    work:
      - "계획서가 정본이다. 범위나 설계가 바뀌면 계획서를 먼저 갱신한다."
      - "Git 커밋은 <type>(<scope>): <summary> 형식을 따르며 기능 단위와 1:1을 유지한다."
      - "GitHub 텍스트(이슈, PR, 커밋 메시지)는 간결한 영어와 명령형 동사를 사용한다."
      - "사용자와의 대화는 한국어로 정중하고 명확하게 소통한다."
    verification:
      - "정적 패키지/구문/링크 검증: npm run check"
      - "코어 단위/통합 테스트: npm test"
      - "전체 검증 게이트: npm run verify"
      - "문서 전용 변경은 npm run check로 충분하며 불필요한 추가 테스트를 요구하지 않는다."
    finish:
      - "검증 통과 결과를 확인하고 변경 사항을 요약 보고한다."
