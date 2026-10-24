# Antigravity Agent Runtime Contract — Steward

이 문서는 `Steward` (`AquilaXk/steward`) 저장소에서 Antigravity 및 코딩 에이전트가 단독으로 작업을 수행할 때 준수해야 하는 상시 런타임 규약 및 계약입니다.

---

## 1. Governance & Single Source of Truth (SSOT)

- **글로벌 안전 헌법**: `~/.gemini/GEMINI.md`
  - 공통 안전 경계, Fail-Closed 원칙, 승인 경계(Approval Boundary), 시크릿 보호, 8절 pstack 작업 방식.
- **pstack 운영 정본**: `~/.claude/rules/pstack-usage.md` (모델 배정 참조: `~/.claude/rules/pstack-models.md`)
  - 플레이북 기반 작업 목록, leaf `principle-*` 인용, `poteto-agent` 위임, `unslop`·`technical-writing` 문장 규칙.
- **프로젝트 헌법**: [`GEMINI.md`](./GEMINI.md)
  - 아키텍처 원칙, 작업 분류(Task Classification), 절대 규칙, 결정론적 검증 게이트.
- **작업 실행 및 맥락**: [`docs/AGENT-CONTEXT.md`](./docs/AGENT-CONTEXT.md)
  - 작업 분류, 불변식, 실행 및 검증 워크플로우.
- **아키텍처 및 도메인 문서**:
  - 시스템 구조 및 I/O 경계: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
  - 정책 엔진 및 평가 규칙: [`docs/POLICIES.md`](./docs/POLICIES.md)
  - 증거 기반 검증 및 게이트: [`docs/VERIFICATION.md`](./docs/VERIFICATION.md)
  - 운영 런북 및 복구 절차: [`docs/OPERATIONS.md`](./docs/OPERATIONS.md)
  - 지속성 메모리 및 저널: [`docs/MEMORY.md`](./docs/MEMORY.md)
  - 호스트 어댑터 및 플러그인: [`docs/HOSTS.md`](./docs/HOSTS.md)
  - 에이전트 스킬 프로시저: [`docs/SKILLS.md`](./docs/SKILLS.md)
  - 모델 가이던스: [`docs/MODEL-GUIDANCE.md`](./docs/MODEL-GUIDANCE.md)
- **계획 및 산출물**: Antigravity Planning Mode
  - 고위험 및 다중 파일 작업 시 `implementation_plan.md` 및 `walkthrough.md`를 정본으로 사용 (첫 항목은 매칭된 `poteto-mode` 플레이북 단계).

---

## 2. Core Operational Hard Rules

### 2.1 Scope, Subagents & Worktree Ownership
- **루트 `main` 고정 및 단일 작업 소유권**:
  - 루트 체크아웃(`/Volumes/MACSSD/Projects/GitProjects/aquila-steward`)은 항상 `main`에 유지하며, 브랜치 작업은 `git worktree add`로 생성한 격리된 worktree(`../aquila-steward-wt-<작업>`)에서 1개의 tracked 작업만 소유하여 수행합니다.
- **Git & Worktree 안전 불변식**:
  - 공유 체크아웃이나 워커 worktree에서 `git checkout` / `git switch`로 브랜치를 전환하지 않습니다.
  - `git add -A`, `git add --all`, `git add .` 광역 스테이징을 금지하며, 수정한 파일 경로를 명시하여 스테이징합니다.
  - `git stash` / `git stash pop`은 모든 worktree가 공유하므로 절대 사용하지 않습니다.
- **Root 소유권 및 서브에이전트 위임 경계 (Max 2 Parallel Subagents)**:
  - **Root(메인) 에이전트**: 전체 스코프 확정, 사전 리서치, 설계/정책 결정, 워커 브리프(`principle-*` 경로, `Goal`, `Context`, `Done`, `Boundaries(allow/deny)`, `Verification`, `No-AI-Traces`, `No-git-stash`) 작성, 워커 diff 및 수치 직접 재검증, 커밋/PR 생성, `aquila-review` 코드리뷰 및 병합 게이트를 단독 소유합니다.
  - **서브에이전트 매핑 (동시 실행 최대 2개)**:
    - `poteto-agent`: pstack 위임 에이전트. 범위·설계가 확정된 격리 worktree 내 구현·테스트·버그 수정·리팩토링의 기본값 (`worker`/`worker-hard`는 예비로만 사용).
    - `explorer`: 읽기 전용 코드·계약·워크플로우·로그·공식 문서 고속 탐색.
    - `reviewer`: `aquila-review` 5대 적대적 감사 게이트·4-Pass 코드리뷰 및 fix 후 interdiff closure 검증(읽기 전용).
    - `security-reviewer`: Source-to-Sink Taint Flow 추적 및 `REACHABILITY` / `IMPACT` / `DEFENSES` 3-Lens 보안 감사(읽기 전용).
    - `comment-sicko`: 리뷰 전 diff의 주석·suppression 감사(pstack `no-comments`, 읽기 전용).
    - `docs-writer`: 범위와 결정이 확정된 문서·Issue/PR 본문 초안 작성.
    - `pr-gate-auditor`: automerge 라벨 부착 전 병합 게이트 점검(읽기 전용).
  - 새 작업과 수정 라운드는 새 에이전트에 원래 브리프·이후 지시·이전 보고를 합쳐 넘기며, 에이전트가 끝날 때마다 `uptime`과 상위 프로세스를 확인해 남은 부하와 스크래치를 회수합니다.
- **PR 분리 및 응집성 원칙 (Epic → 백로그 항목 → PR, QA 2026-10-16·24)**:
  - 구현 PR은 동일 위험, 인접 파일, 검증, 롤백 경계의 작업을 1개의 자기완결 PR로 묶어 전달합니다.
  - 오탈자, 단순 설정, 주석 정리 등 경미한 작업(Class C)은 신규 Issue를 개설하지 않고 배치 PR이나 기존 에픽/sub-issue에 연결합니다.
  - 측정 행, flake, 리뷰 finding, 후속 과제마다 새 이슈를 만들지 않고 해당 sub-issue나 에픽 체크리스트에 행으로 추가하며, 리뷰 지적은 같은 PR에서 고칩니다.
  - 코어 정책 엔진, 호스트 플러그인, 스키마, 배포 작업 등 서로 다른 고위험 경계는 분리합니다.

### 2.2 Planning, pstack & Execution
- **pstack 작업 방식 (QA 2026-10-23)**:
  - pstack(`~/.claude/plugins/cache/cursor-plugins/pstack/` 최신 버전) 및 운영 정본(`~/.claude/rules/pstack-usage.md`, Antigravity 도구 매핑은 `~/.gemini/GEMINI.md` 8절)을 따릅니다. 본 문서(`AGENTS.md`)와 충돌하면 본 문서가 우선합니다.
  - 사소한 질문이나 한 줄 수정이 아닌 작업은 시작 전에 `docs/harness/claude-code.md`와 `skills/poteto-mode/SKILL.md`를 읽고, 매칭된 `poteto-mode` 플레이북 단계를 그대로 옮긴 작업 목록으로 시작합니다.
  - 결정에 쓴 원칙은 leaf `skills/principle-*/SKILL.md`를 읽은 것만 인용하며, 응답에 적용한 원칙과 그 원칙이 바꾼 선택을 함께 적습니다.
  - 응답과 문서 문장은 `skills/unslop/SKILL.md`와 `skills/technical-writing/SKILL.md`를 따릅니다(긴 대시, 문장 중간 콜론, "굵은 라벨: 설명" 목록 금지).
  - 호스트 전용 자동화 단계(Automations, Bugbot, `cursor-team-kit`의 `deslop`·`control-*`)는 `Skipped: <단계>. <사유>.` 한 줄로 건너뜁니다.
  - 외부 GPT/Codex 계열 도구는 어떤 경로로도 쓰지 않습니다(QA 2026-10-23).
- **에이전트 기능 및 `/boost` 최대 활용**:
  - 모든 작업은 Antigravity 에이전트 역량(심층 추론, Planning Mode, Subagent 분업, 결정론적 검증 게이트)과 `/boost`를 최대한 활용하여 수행합니다.
  - 심층적인 사고와 다각도 분석, 전략적 계획 수립 및 엄격한 검증이 필요한 코딩/설계/연구 과제는 `/boost`를 적극 활용하여 완성도와 무결성을 극대화합니다.
- **계획서가 정본**: 모든 구현, 검증, 커밋, PR은 계획서를 정본으로 따르며 범위나 설계 변경 시 편집 전에 계획서부터 갱신합니다.
- **커밋 1:1 대응**: Git 커밋은 `<type>(<scope>): <summary>` 형식을 준수하며, 계획서의 기능 단위와 1:1을 유지합니다.
- **모델명 하드코딩 금지**: 저장소 문서나 코드에 특정 모델명을 핀(pin)하거나 하드코딩하지 않고 Antigravity 기본 설정을 따릅니다.
- **모델 API 직접 호출 금지**: 로컬 변경의 일환으로 모델 API를 호출하거나 패키지를 임의로 퍼블리시하지 않습니다.

### 2.3 Git & GitHub Delivery
- **5단계 표준 파이프라인 준수**:
  `1. 고도화된 계획서 수립 (사례 조사/벤치마킹 반영 및 QA 승인) -> 2. GitHub Issue/Sub-Issue 동기화 -> 3. 격리된 worktree(short-lived branch) 구현 및 로컬 검증 -> 4. PR 생성 및 aquila-review + security-reviewer 2중 코드리뷰 (스레드 해결) -> 5. automerge 라벨 부착 및 자동 머지`
- **`main` 직접 푸시 절대 금지**: 모든 변경은 `main`에서 분기한 단기 수명(short-lived) 브랜치에서 진행합니다.
- **GitHub 언어 및 문체**:
  - 이슈, PR 제목/본문, 커밋 메시지, 코드 리뷰 등 GitHub에 게시되는 모든 텍스트는 간결하고 전문적인 영문(English)을 사용합니다.
  - 제목과 요약 불릿, 커밋 메시지는 명령형 동사(Imperative verb)로 시작합니다 (권장: 제목 72자 이내).
  - 기여자 개인을 지칭하기보다 `we`, `the code`, `this change` 중심의 협업적 서술을 사용합니다.
  - `Co-Authored-By`, `Generated with ...`, 세션 URL 등 AI 흔적을 절대 남기지 않습니다.
- **QA 커뮤니케이션**:
  - QA와의 대화 및 로컬 보고는 한국어를 사용합니다.
- **타 서비스 및 외부 참고 언급 금지**:
  - 코드, 커밋 메시지, GitHub 이슈, PR 제목 및 본문, 문서 등 모든 산출물에서 타 서비스명이나 외부 참고 저장소/서비스를 직접 언급하거나 비교/참고했다는 표현을 일체 사용하지 않습니다.
- **리뷰 및 Automerge 게이트 (`aquila-review` SSOT)**:
  - 검증 순서: 로컬 최소 결정론적 검증 통과 → PR 생성 → CI 및 `aquila-review` 스킬(`~/.gemini/config/skills/aquila-review/SKILL.md`, `pstack Alignment` 절 포함) + `security-reviewer` 2중 코드리뷰(저장소 외부 스크래치 경로에서 `post-review.mjs`로 단일 GitHub Review 객체 게시) → 리뷰 피드백 해결(미해결 스레드 0건 확보) → `gh pr edit <PR_NUMBER> --add-label automerge`로 자동 머지 트리거.
  - 리뷰 라운드 수에는 상한을 두지 않으며, P0~P2(정확성·보안)만 병합을 차단하고 P3·P4는 Nit로 표시해 같은 PR에서 고치거나 체크리스트 행으로 넘깁니다. fix 커밋 뒤에는 바뀐 부분(interdiff)만 다시 리뷰합니다.
  - 직접 `git merge`나 원격 `main` 직접 푸시는 엄격히 금지합니다.

---

## 3. Product Invariants & Architecture Constraints

- **Node.js 22+ & Zero Dependencies**:
  - 이 패키지는 런타임 제3자 의존성이 전혀 없으며(Zero third-party runtime dependencies), Node.js 22+ 환경에서 로컬로 실행됩니다.
- **Functional Core Separation**:
  - 순수 정책 엔진(`src/engine.mjs`)은 파일시스템, 신뢰(trust), 호스트 어댑터와 명확히 분리합니다. 엔진 내부에 I/O나 명령 실행을 두지 않습니다.
- **Fail-Closed Policy Engine**:
  - 정책 평가 오류(policy error)나 신뢰 실패, 유효하지 않은 입력을 임의로 `allow`로 조용히 대체하지 않습니다.
- **Observable Behavior Testing**:
  - 신뢰 실패(failed trust), 잘못된 입력(invalid input), 컨텍스트 예산 초과(context budgets), 동시 쓰기(concurrent writes), 오래된 증거(stale evidence)를 포함한 관찰 가능한 동작을 엄격히 테스트합니다.
- **Bilingual Documentation Alignment**:
  - 소스 코드, 테스트, 영문 문서는 명료한 영어(Clear English)로 작성하며, `README.ko.md`와의 정렬을 항상 유지합니다.

---

## 4. Minimum Deterministic Verification

작업 완료 전 변경 사항을 증명하는 최소 결정론적 검증을 1회 이상 실행합니다:

- **정적 패키지/구문/링크/스키마 검증**:
  ```bash
  npm run check
  ```
- **코어 정책 엔진 및 저널 동작 검증**:
  ```bash
  npm test
  ```
- **전체 통합 검증**:
  ```bash
  npm run verify
  ```
- **문서 전용(Documentation-only) 변경**:
  - 코어 동작 변경이 없는 문서 변경은 해당 문서/패키지 검사(`npm run check`)로 충분하며, 임의의 과도한 추가 테스트를 요구하지 않습니다.
