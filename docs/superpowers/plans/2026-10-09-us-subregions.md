# US Subregions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose automatically maintained geographic pools as a few stable subscription entries, subdividing the US while leaving small regions intact.

**Architecture:** Derive geographic selectors from existing country configuration. A country cache supplies immutable filtered views for subregions; signed geography is recorded at probe time. Preserve upstream generation and existing country routes.

**Tech Stack:** Existing Worker JavaScript, Python generator, Node built-in tests, vanilla HTML; no new dependency.

## Global Constraints

- Existing country configuration versions 1/2/3 remain supported and unchanged by reads.
- US stays default; selectors US-EAST, US-CENTRAL, US-WEST only use authenticated matching US state evidence; missing location is US-only.
- State rules exactly as in approved docs/superpowers/specs/2026-10-09-us-subregions-design.md.
- Keep max 32 discovered candidates, max 4 probes per round, concurrency 2, 12-second round budget, request-driven 15-minute refresh, per-item 30-minute expiry, force/target-miss cooldown at least 60 seconds.
- Never direct or cross-region fallback. Independent KV HMAC key stays unchanged; no credentials printed or new token.
- Only root commits. Workers are not alone, must preserve other edits. Source edits on feature branch, no heavy installs/builds or additional worktree at available 14 GiB.
- No production Cloudflare publication this task.

### Task 1: Backend geography, pool retention and subscriptions

**Files:** policy/regions.js, policy/exit-proof.js, policy/auto-exits.js; related tests; generated _worker.js only through scripts/apply-us-policy.py.

**Interfaces:**
- 订阅区域列表(config, selected) returns country and derived US selectors, default first. Selector code US-EAST etc, country US, area east/central/west; source/exits inherited from parent.
- 选择区域(config,url) resolves legacy and derived selectors, rejects duplicates/empty/unknown.
- 获取有效区域池(env,selector,request,force=false) returns a selected-region view of shared country pool, never nonmatching exits.
- /admin/regions.json GET supplies entries metadata for selectors and existing subscriptions.
- /admin/exits.json GET/POST returns selected-region status plus country pool counters; GET does not probe; POST is existing authenticated/same-origin mutation.

- [x] Add test file tests/subregions.test.cjs with real receipt signing/verification cases, selection/subscription cases, shared parent/subregion cache, retention and expiration cases. Verify RED on current implementation (node --test tests/subregions.test.cjs).
- [x] Receipt v2 signs regionCode/city. Test request.cf {country:'US',regionCode:'CA',city:'Los Angeles'} yields a verified west result; editing regionCode to NY rejects signature; missing regionCode produces no classified area.
- [x] Derive region selectors and subscription names Naiops-US · 美国自动, Naiops-US-EAST · 美国东部, Naiops-US-CENTRAL · 美国中部, Naiops-US-WEST · 美国西部; others Naiops-JP · 日本自动 etc. Validate generated names stay unique. Removing US removes derived entries; explicit country scope returns one, full subscription returns nine by default.
- [x] Cache parent US once, filter immutable view by signed state. Two valid CA/NY results must serve different US-WEST/US-EAST selections without duplicate refresh and share parent country cache; unknown state usable only for US. Missing target obeys cooldown and bound. Update per-exit expiry handling and validation so an expired member never extends another member's proof or forces discarding fresh matching members.
- [x] Successful partial refresh merges valid old backups with new checked results, dedupes and retains healthy primary, max 8 pool. Unknown/mismatched/revoked evidence cannot return via old cache, including KV write failure. Provide truthful discoveredCount/probedCount and classify available counts; old fixtures without new geo remain country-only.
- [x] Generate worker; update existing behavioral assertions for intentional nine-entry/naming change; run node --test tests/subregions.test.cjs tests/regions.test.cjs tests/exit-proof.test.cjs tests/auto-exits.test.cjs tests/exit-integration.test.cjs tests/us-only.test.cjs and Python source check. Write report with RED/GREEN commands/results. No commits.
- [x] Root packages scoped diff for independent backend review; fix findings and rerun covering tests. Include current-authority per-candidate revocation, invalid envelope withdrawal, bounded non-durable revocation across same-isolate eviction, explicit unavailableState API and existing native workerd/TLS v2 harness.

### Task 2: Region overview UI

**Files:** policy/regions.html; related panel tests only.
**Interfaces:** Use Task 1 entries metadata and selected-region status. Retain country configuration form for advanced options; default is country selection, original settings remain.

- [x] Use frontend-design skill and read existing HTML. Put subscriptions and repeated region status cards first, config/candidate details in details elements.
- [x] Render one card per entry with display name, country/area, pending/available/unavailable/expired/error state, valid count and update time. Explain missing signed geography distinctly from total source failure. Source/probe statistics refer to shared country round, not invented per-area discovery counts.
- [x] Read all card statuses with at most 2 concurrent GETs; no probe on page load. Refresh chosen entry explicitly via POST, reread sibling US cards after shared refresh; rate-limit feedback. Existing Origin/content-type auth behavior preserved.
- [x] Subscription scope includes nine selectors; copying generates correct selected region. Failed GET leaves existing settings intact and exposes recoverable message; save/reload preserves scope when valid.
- [x] Compile extracted inline JS with Node vm.Script and run actual admin/API tests. If browser is available reuse existing session to check desktop/narrow layout; otherwise record visual NOT_RUN. No dependency install and no commits.
- [x] Root packages scoped diff and independent review checks spec and code quality; fix and rerun targeted tests.

### Task 3: Documentation, whole-branch verification and GitHub delivery

**Files:** README.md, docs/上游差异.md, docs/美国子区域验收.md, design and plan documents, generated worker.

- [x] Document nine entries, 18 Mihomo protocol proxies, shared US pool, state mapping, request-driven updates, approximate/null geolocation, and unchanged country links. No promise of enough free candidates per subregion.
- [x] Run python3 scripts/apply-us-policy.py upstream/_worker.js _worker.js then bash scripts/verify.sh. Full regression is existing lightweight tests, not dependency install or compilation. Preserve RED/GREEN evidence outside repo.
- [x] Independent whole-branch review of source diff and test results; fix any important findings before completion.
- [ ] Root stages only source/tests/docs/generated worker, commits, pushes feature branch and creates PR attached to task. Confirm GitHub CI. No Cloudflare production deploy.
- [ ] Record final revision, test summary, CI/PR, limitations and resource cleanup. Keep formal verification evidence and remove only owned regenerable scratch/processes.
