# Steward — Gemini Agent Constitution

이 문서는 Google Antigravity 및 Gemini CLI 환경에서 `Steward` (`AquilaXk/steward`) 저장소를 작업할 때 준수해야 하는 최상위 프로젝트 헌법 및 운영 지침입니다.

---

## 1. Project & Architecture Context

- **Repository**: `Steward` (`AquilaXk/steward`)
- **Core Purpose**: 코딩 에이전트를 위한 로컬, 증거 기반(evidence-aware) 정책 및 지속성 메모리 툴킷 (Node.js 22+, 런타임 서드파티 의존성 0개).
- **Architecture Principles**:
  - **Functional Core & Explicit I/O Boundaries**:
    - `src/engine.mjs`는 파일 I/O, 명령 실행, 외부 통신을 수행하지 않는 순수 정책 평가 엔진입니다.
    - 파일시스템, 신뢰(trust), 호스트 어댑터(`adapter`)는 명확한 경계로 분리 유지합니다.
  - **Single Source of Truth (SSOT)**:
    - 계획서(Plan), 계약(Contracts), 실행 가능한 검증 게이트가 작업의 정본입니다.
  - **Fail-Closed Principle**:
    - 정책 평가 오류나 신뢰 실패, 유효하지 않은 입력을 임의로 `allow`로 조용히 대체(silent fallback)하지 않고 반드시 명확하게 에러/거부를 반환합니다.
  - **Zero Runtime Dependencies**:
    - 본 패키지는 Node.js 22+ 내장 모듈만으로 동작하며, 런타임 제3자 라이브러리를 일체 사용하지 않습니다.
  - **Verifiable & Immutable Evidence**:
    - 저널은 단일 파일, 시퀀스 번호, 해시 체인으로 무결성을 보장하며 임의의 과거 기록 위변조나 사일런트 포크를 허용하지 않습니다.
  - **Bounded Changes**:
    - 요청 범위를 엄격히 준수하며, 투기적 추상화(speculative abstractions)나 무관한 대규모 리팩터링을 지양합니다.

---

## 2. Task Classification & Workflow

모든 요청은 작업 착수 전 다음 4가지 유형 중 하나로 명확히 분류합니다:

1. **`read-only`**:
   - 코드베이스 탐색, 원인 분석, 설계 조사, 단순 질의.
   - 코드/설정 수정 없이 증거 기반 분석 결과 보고로 완료.
2. **`local-only`**:
   - 에이전트 설정 문서, 로컬 진단, 작업 메모 등 로컬 전용 작업.
   - 최소 범위 수정 후 fresh verification(`npm run check`, `npm test`)으로 완료. 원격 이슈, 브랜치, 커밋, PR을 요구하지 않음.
3. **`new tracked work`**:
   - 기능 구현, 버그 수정, 구조 개선 등 원격 전달(delivery)이 필요한 작업.
   - **표준 5단계 작업 파이프라인 (End-to-End Pipeline)**:
     1. **고도화된 작업 계획서 수립 (Plan with Case Research)**:
        - 다중 파일 또는 고위험 작업 시 Planning Mode(`implementation_plan.md`) 필수 수행.
        - 아키텍처/설계 결정이 필요한 경우, 산업 표준 및 우수 사례를 적극 검색·참고하여 최적의 방안을 계획서에 수립.
        - *주의: 타 서비스 언급 금지 규칙에 따라 특정 타사 서비스명을 최종 산출물에 직접 기재하지 않고 도메인 요구사항으로 정제하여 기술.*
        - 사용자 명시적 승인 후 다음 단계로 진행.
     2. **이슈 생성 (Issue Tracking)**:
        - 승인된 계획을 바탕으로 GitHub Issue 생성 (`gh issue create`).
        - 제목과 본문은 간결하고 전문적인 영문(English) 및 명령형 동사 사용.
     3. **구현 및 로컬 결정론적 검증 (Implementation & Deterministic Verification)**:
        - `main` 기반 단기 수명 브랜치(`feat/...`, `fix/...`, `docs/...`)에서 작업.
        - 기능 단위와 1:1 대응되는 커밋 작성 (`<type>(<scope>): <summary>`).
        - 변경 사항을 직접 증명하는 가장 작은 결정론적 검사(`npm run check`, `npm test`) 통과.
     4. **PR 생성 및 코드리뷰 (PR & Code Review Gate)**:
        - Pull Request 생성 (`gh pr create`).
        - `aquila-review` 스킬(`~/.gemini/config/skills/aquila-review/SKILL.md`, `pstack Alignment` 절 포함) 및 `security-reviewer` 2중 코드리뷰(저장소 외부 스크래치 경로에서 `post-review.mjs`로 단일 GitHub Review 객체 게시) 수행, 미해결(unresolved) 스레드 0건 확보.
     5. **오토머지 (Automerge Gate)**:
        - 필수 CI 통과(Green) 및 코드리뷰 미해결 스레드 0건 확인 후 `gh pr edit <PR_NUMBER> --add-label automerge`로 자동 머지 트리거.
        - `main` 직접 머지나 강제 푸시는 절대 금지.
4. **`open PR follow-up`**:
   - 이미 열려 있는 PR에 대한 후속 리뷰 반영 또는 추가 수정.
   - 기존의 issue, branch, PR을 그대로 재사용하여 작업.

---

## 3. Hard Rules (절대 규칙)

### 3.1 Scope, Subagents & Worktree Ownership
- **단일 소유권 및 루트 `main` 고정**: 루트 체크아웃(`/Volumes/MACSSD/Projects/GitProjects/aquila-steward`)은 항상 `main`에 고정하며, 1개의 격리된 작업 워크트리(`../aquila-steward-wt-<작업>`)는 1개의 tracked task만 소유합니다.
- **Git & Worktree 안전 불변식**:
  - 공유 체크아웃이나 워커 worktree에서 `git checkout` / `git switch`로 브랜치를 전환하지 않습니다.
  - `git add -A`, `git add --all`, `git add .` 광역 스테이징을 금지하며, 커밋할 파일 경로를 명시적으로 지정합니다.
  - `git stash` / `git stash pop`은 모든 worktree가 공유하므로 절대 사용하지 않습니다.
- **Root 소유권 및 pstack 서브에이전트 위임 (Max 2 Parallel Subagents)**:
  - **Root(Lead) 에이전트**: 스코프 확정, 사전 리서치, 설계/정책 결정, 워커 브리프(`principle-*` 경로, `Goal`, `Context`, `Done`, `Boundaries(allow/deny)`, `Verification`) 작성, 워커 diff 및 수치 재확인, 커밋/PR 생성, `aquila-review` + `security-reviewer` 코드리뷰 및 병합 게이트를 단독 소유합니다.
  - **서브에이전트 매핑 (동시 실행 최대 2개)**:
    - `poteto-agent`: pstack 위임 에이전트 (`../aquila-steward-wt-<작업>` 격리 worktree 내 구현·테스트·버그 수정·리팩토링 기본값; `worker`/`worker-hard`는 예비).
    - `explorer`: 읽기 전용 코드·계약·워크플로우·로그·공식 문서 고속 탐색.
    - `reviewer` / `security-reviewer`: `aquila-review` 5대 게이트·4-Pass 코드리뷰 및 3-Lens 심층 보안 감사(읽기 전용).
    - `comment-sicko`: 리뷰 전 diff의 주석·suppression 감사(pstack `no-comments`, 읽기 전용).
    - `docs-writer`: 범위와 결정이 확정된 문서·Issue/PR 본문 초안 작성.
    - `pr-gate-auditor`: automerge 라벨 부착 전 병합 게이트 점검(읽기 전용).
- **원자적 기능 PR 및 이슈 계층 (Epic → 백로그 항목 → PR, QA 2026-10-16·24)**:
  - 구현 PR은 동일 위험, 인접 파일, 검증, 롤백 경계의 작업을 가능한 단위로 묶습니다.
  - 오타, 주석 정리 등 경미한 작업(Class C)은 신규 Issue를 개설하지 않고 일괄 유지보수(Batch Maintenance) 또는 기존 에픽/sub-issue에 연결합니다.
  - 측정 행, flake, 리뷰 finding, 후속 과제마다 새 이슈를 만들지 않고 해당 sub-issue나 에픽 체크리스트에 행으로 추가하며, 리뷰 지적은 같은 PR에서 고칩니다.
  - 스키마 변경, 호스트 플러그인 연동, 코어 정책 엔진, 배포/문서 등 서로 다른 위험 경계의 작업은 분리합니다.

### 3.2 Planning, pstack & Execution
- **pstack 작업 방식 (QA 2026-10-23)**:
  - pstack(`~/.claude/plugins/cache/cursor-plugins/pstack/` 최신 버전) 및 운영 정본(`~/.claude/rules/pstack-usage.md`, Antigravity 매핑은 `~/.gemini/GEMINI.md` 8절)을 따릅니다.
  - 사소한 질문이나 한 줄 수정이 아닌 작업은 시작 전에 `docs/harness/claude-code.md`와 `skills/poteto-mode/SKILL.md`를 읽고, 매칭된 `poteto-mode` 플레이북 단계를 그대로 옮긴 작업 목록으로 시작합니다.
  - 결정에 쓴 원칙은 읽은 leaf `skills/principle-*/SKILL.md`만 인용하며, 응답에 원칙과 바뀐 선택을 함께 적습니다.
  - 응답과 문서 문장은 `skills/unslop/SKILL.md`와 `skills/technical-writing/SKILL.md`를 따르며, 호스트 전용 단계는 `Skipped: <단계>. <사유>.` 한 줄로 건너뜁니다.
  - 외부 GPT/Codex 계열 도구는 어떤 경로로도 사용하지 않습니다(QA 2026-10-23).
- **계획서가 정본**: 모든 구현, 검증, 커밋, PR은 계획서(Plan)를 정본으로 따릅니다. 범위나 설계 결정이 변경되면 코드 편집 전에 계획서부터 갱신합니다.
- **커밋 1:1 대응**: Git 커밋은 `<type>(<scope>): <summary>` 형식을 준수하며, 계획서의 기능 단위와 1:1을 유지합니다.
- **모델명 하드코딩 금지**: 저장소 문서나 코드에 특정 AI 모델명을 핀(pin)하거나 하드코딩하지 않고 Antigravity 기본 설정을 따릅니다.
- **로컬 변경 시 모델 API 호출 금지**: 로컬 개발 및 테스트 과정에서 외부 모델 API를 임의로 직접 호출하지 않습니다.

### 3.3 Git & GitHub Delivery
- **`main` 직접 푸시 절대 금지**: 모든 작업은 `main`에서 분기한 단기 수명(short-lived) 브랜치에서 수행합니다.
- **GitHub 작성 스타일 (English Prose)**:
  - 이슈, PR 제목/본문, 커밋 메시지, 코드 리뷰 등 GitHub에 게시되는 모든 텍스트는 **간결하고 전문적인 영문(English)**으로 작성합니다.
  - 제목과 요약 불릿, 커밋 메시지는 **명령형 동사(Imperative verb)**로 시작합니다 (권장: 제목 72자 이내).
  - 기여자 개인을 지칭하기보다 `we`, `the code`, `this change` 중심의 협업적 서술을 사용합니다.
  - `Co-Authored-By`, `Generated with ...`, 세션 URL 등 AI 흔적을 절대 남기지 않습니다.
- **QA 커뮤니케이션 (Korean)**:
  - QA와의 대화, 질의응답, 로컬 보고는 **한국어**로 정중하고 명확하게 소통합니다.
- **문서 동기화 의무**:
  - 사용자 대상 문서 변경 시 `README.md`(영어)와 `README.ko.md`(한국어)의 정렬을 항상 유지합니다.
- **타 서비스 및 외부 참고 언급 금지**:
  - 코드, 커밋 메시지, GitHub 이슈, PR 제목 및 본문, 문서 등 모든 산출물에서 타 서비스명이나 외부 참고 저장소/서비스를 직접 언급하거나 비교/참고했다는 표현을 일체 사용하지 않습니다. 본 프로젝트 고유의 요구사항 및 도메인 맥락으로만 기술합니다.
- **Review & Automerge Gate (`aquila-review` SSOT)**:
  - 검증 순서: 로컬 최소 결정론적 검증 → PR 생성 → CI 및 `aquila-review` + `security-reviewer` 2중 코드리뷰(저장소 외부 스크래치 경로에서 `post-review.mjs`로 단일 GitHub Review 객체 게시) → 리뷰 피드백 해결(미해결 스레드 0건) → `automerge` 라벨 부여 → 자동 머지.
  - 리뷰 라운드 수에는 상한을 두지 않으며, P0~P2(정확성·보안)만 병합을 차단하고 P3·P4는 Nit로 표시해 같은 PR에서 고치거나 체크리스트 행으로 넘깁니다. fix 커밋 뒤에는 바뀐 부분(interdiff)만 다시 리뷰합니다.
  - 직접 `git merge`나 원격 `main` 브랜치 직접 푸시는 엄격히 금지합니다.

### 3.4 Safety & Approval Boundary
- **단일 승인 경계 (Approval Boundary)**:
  - 머지(merge), 패키지 퍼블리시/릴리즈, 파괴적 삭제(`rm -rf` 등), force-push, 시크릿(secret) 변경은 **반드시 사용자의 명시적 승인**을 거쳐야 합니다.
- **No Secret Exposure**: 시크릿, 인증 토큰, 비밀번호, 개인식별정보(PII)를 커밋, 파일, 로그, 이슈, PR, 채팅에 절대 노출하지 않습니다.

---

## 4. Verification Policy (결정론적 최소 검증)

- **Smallest Deterministic Check**:
  - 작업 완료 전 변경 사항을 직접 증명하는 가장 작고 확실한 결정론적 검사를 1회 이상 실행합니다:
    - 정적 패키지/구문/링크/스키마 검증: `npm run check`
    - 코어 정책/엔진/저널 단위 및 통합 검증: `npm test`
    - 통합 검증 게이트: `npm run verify` (`npm run check && npm test`)
  - 버그 수정 작업 시에는 실패하는 재현 테스트(failing regression test)를 먼저 작성하고 구현으로 통과시킵니다.
- **No Blind Oververification**:
  - 이미 확인된 변경 없는 결과에 대해 불필요하게 무거운 전체 테스트나 반복 폴링을 수행하지 않습니다.
  - 문서 전용(Documentation-only) 변경은 관련 문서/패키지 검사(`npm run check`)로 충분하며 임의의 추가 런타임 테스트를 요구하지 않습니다.

---

## 5. Antigravity Native Integration & Agent Capabilities

- **에이전트 기능 및 /boost 최대 활용 (Maximize Agent Capabilities & /boost)**:
  - 모든 작업은 Antigravity 에이전트의 고급 역량(Planning Mode, Subagent 분업, 심층 추론, 결정론적 검증 게이트)과 `/boost`를 최대한 활용하여 수행합니다.
  - 깊은 사고(Deep Thinking), 전략적 계획 수립, 다각도 관점 검토 및 철저한 검증이 요구되는 코딩·설계·리서치 작업에는 `/boost` 기능을 적극 활용하여 완성도와 무결성을 극대화합니다.
- **Planning Mode & Artifacts**:
  - 고위험 또는 다중 파일 작업 시 `implementation_plan.md`를 작성하여 사용자 검토를 거치며, 완료 후 `walkthrough.md`에 결과를 정리합니다.
- **Subagent Collaboration & Resource Reclamation**:
  - 독립적인 코드/문서 탐색은 `explorer`, 격리된 worktree(`../aquila-steward-wt-<작업>`) 내 구현·테스트·버그 수정은 `poteto-agent`, 리뷰 전 주석 감사는 `comment-sicko`, PR 리뷰 및 보안 감사는 `reviewer` + `security-reviewer`에 위임하되(동시 최대 2개), Root 에이전트가 최종 diff·수치 검증과 수용 여부를 단독 통제합니다.
  - 서브에이전트가 끝날 때마다 `uptime`과 상위 프로세스를 확인하여 남은 프로세스와 스크래치를 회수합니다.
