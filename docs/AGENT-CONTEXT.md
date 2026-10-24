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
      new_tracked_work: "pstack 플레이북 단계 -> 계획서(plan) -> 에픽/sub-issue 동기화 -> 격리된 worktree(short-lived branch) -> 구현/검증 -> commit/push -> PR -> aquila-review + security-reviewer 2중 리뷰 -> automerge."
      open_pr_followup: "기존 issue/branch/PR 재사용하여 후속 작업 진행."
      local_only: "로컬 설정, 진단, 작업 메모는 필요한 최소 수정과 검증으로 완료하며 원격 효과를 요구하지 않는다."

  hard_invariants:
    functional_core: "src/engine.mjs는 파일 I/O나 명령 실행을 포함하지 않는 순수 정책 평가 엔진으로 유지한다."
    zero_dependencies: "package.json 내 런타임 및 개발 의존성을 추가하지 않고 Node.js 22+ 내장 모듈만 사용한다."
    fail_closed: "정책 평가 오류나 신뢰 실패 시 임의의 allow로 조용히 대체하지 않고 명확한 에러/거부를 반환한다."
    bilingual_docs: "README.md 수정 시 반드시 README.ko.md를 정렬한다."
    worktree_safety: "루트 체크아웃은 main에 유지하고 모든 브랜치 작업은 ../aquila-steward-wt-<작업> 격리 worktree에서 수행한다. git add -A/git add . 및 git stash 금지."

  execution:
    start:
      - "사소한 질문이나 한 줄 수정이 아닌 작업은 docs/harness/claude-code.md와 skills/poteto-mode/SKILL.md를 읽고 플레이북 단계를 그대로 옮긴 작업 목록으로 시작한다."
      - "task classification과 최소 범위를 확정한다. agent 문서 local-only는 원격 효과 없이 바로 편집/검증한다."
      - "tracked 작업은 plan/sub-issue를 동기화하고 격리된 worktree에서 short-lived branch를 생성한다."
    work:
      - "계획서가 정본이다. 범위나 설계가 바뀌면 계획서를 먼저 갱신한다."
      - "결정에 쓴 원칙은 읽은 leaf skills/principle-*/SKILL.md만 인용하며, 응답에 원칙과 바뀐 선택을 함께 적는다."
      - "구현 위임은 poteto-agent, 읽기 전용 조사는 explorer, 주석 감사는 comment-sicko, PR 리뷰는 reviewer + security-reviewer를 쓴다(동시 최대 2개). 외부 GPT/Codex 계열 도구는 쓰지 않는다."
      - "응답과 문서 문장은 skills/unslop/SKILL.md와 skills/technical-writing/SKILL.md를 따른다."
      - "Git 커밋은 <type>(<scope>): <summary> 형식을 따르며 기능 단위와 1:1을 유지한다."
      - "GitHub 텍스트(이슈, PR, 커밋 메시지)는 간결한 영어와 명령형 동사를 사용한다."
      - "QA와의 대화는 한국어로 정중하고 명확하게 소통한다."
    verification:
      - "정적 패키지/구문/링크 검증: npm run check"
      - "코어 단위/통합 테스트: npm test"
      - "전체 검증 게이트: npm run verify"
      - "문서 전용 변경은 npm run check로 충분하며 불필요한 추가 테스트를 요구하지 않는다."
    finish:
      - "aquila-review 및 security-reviewer 미해결 스레드 0건과 검증 통과 결과를 확인하고, uptime으로 남은 프로세스와 스크래치를 회수한 뒤 요약 보고한다."
