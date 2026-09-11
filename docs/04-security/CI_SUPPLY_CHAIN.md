# CI / Supply Chain Security

Controls for the GitHub Actions pipelines that build, test and scan this repository.
Workflow sources: `.github/workflows/ci.yml`, `.github/workflows/security.yml`,
`.github/dependabot.yml`.

## Trigger matrix

| Workflow       | `push`                                        | `pull_request` | `schedule`                       |
| -------------- | --------------------------------------------- | -------------- | -------------------------------- |
| `ci.yml`       | `main`, `001-telegram-shop-mvp`, `release/**` | every PR       | —                                |
| `security.yml` | `main`, `release/**`                          | every PR       | Mondays 03:17 UTC (`17 3 * * 1`) |

`release/**` is included deliberately: a release branch (for example
`release/wallet-broadcast-acceptance`) must be verified by `push` CI, not only through the
`pull_request` it came from. The weekly run exists because dependencies stay unchanged while
advisories are published against them.

## Pin policy

- Every `uses:` — action steps **and** reusable-workflow calls — is pinned to a full 40-character
  commit SHA, followed by a `# vX.Y.Z` comment naming the release that SHA corresponds to.
  A moving ref (`@v4`, `@main`) is never acceptable: the tag owner could retag it and silently
  change what executes with repository access.
- Workflow-level `permissions: contents: read` is the default; each job may only widen that.
- No `curl | bash`, no `wget | sh`, no `npx package@latest`, no `pull_request_target` and no
  `workflow_run`. Install steps must be SHA-pinned actions or locked `npm ci` installs.
- Refreshing a pin is a deliberate, reviewable commit. Dependabot's `github-actions` ecosystem
  (weekly, grouped minor/patch) proposes those commits; they still have to pass both workflows.

### How to refresh a pin

Resolve the tag to its commit with the peeled form so annotated tags cannot hide a second object:

```bash
git ls-remote https://github.com/actions/checkout refs/tags/v4.4.0 'refs/tags/v4.4.0^{}'
```

- If an extra `...^{}` line is printed, the tag is **annotated** — use the `^{}` SHA (the commit
  GitHub Actions actually checks out) and ignore the tag-object SHA above it.
- If only one line is printed, the tag is **lightweight** and that SHA is the commit.

Verified example (annotated tag):

```text
11d5960a326750d5838078e36cf38b85af677262 refs/tags/v4.4.0
```

Then update the ref and its version comment together:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

Prove the edit before committing:

```bash
npx vitest run tests/security/ci-supply-chain.test.ts
```

## Permission model

`GITHUB_TOKEN` starts at `contents: read` for the workflow; the table lists what each job adds.
No job requests `contents: write` or `write-all`.

| Job (workflow)                     | Job permissions                                               | Why                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `codeql` (`security.yml`)          | `contents: read`, `security-events: write`, `packages: read`  | Upload CodeQL SARIF; `packages: read` allows resolving the CodeQL bundle                                            |
| `dependency-scan` (`security.yml`) | `actions: read`, `contents: read`, `security-events: write`   | OSV reusable workflow uploads SARIF and reads the run artifact metadata                                             |
| `secret-scan` (`security.yml`)     | `contents: read`                                              | gitleaks only reads the checkout; `GITLEAKS_ENABLE_COMMENTS: false` keeps fork PRs from needing comment permissions |
| `sbom` (`security.yml`)            | `contents: read`                                              | Generates an SBOM and uploads it as a run artifact                                                                  |
| `container-scan` (`security.yml`)  | `contents: read`, `security-events: write`                    | Trivy uploads SARIF                                                                                                 |
| `scorecard` (`security.yml`)       | `contents: read`, `security-events: write`, `id-token: write` | OIDC token is required to publish public results; job is skipped for fork PRs                                       |
| `verify` (`ci.yml`)                | inherits `contents: read`                                     | Runs the test matrix; publishes JUnit evidence via artifact upload only                                             |

`scorecard` is guarded with
`if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`
because `id-token: write` and publishing are unavailable to fork pull requests.

## Scanner coverage against the THREAT_MODEL verification baseline

`docs/04-security/THREAT_MODEL.md` requires "Secret, SAST, dependency, SBOM and container scans"
and names a supply-chain red-team lens. Coverage:

| Baseline item     | Control                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAST              | CodeQL `javascript-typescript`, `build-mode: none` (no compiled artifact needed — TypeScript is analysed from source, so the scanner never runs our build)                             |
| Dependency        | `security.yml` OSV-Scanner (`npm` and any other lockfile OSV understands) plus `npm run audit -- --audit-level=high` in `ci.yml`                                                       |
| Secret            | `ci.yml` `npm run secret-scan`, `security.yml` gitleaks over full history, and Trivy's `secret` scanner (SEC-008, SEC-012)                                                             |
| SBOM              | `anchore/sbom-action` CycloneDX JSON artifact, uploaded with the SHA-pinned `actions/upload-artifact`. Dependency-graph metadata only: no secrets, env values or runtime data are read |
| Container         | Trivy `scan-type: fs` over the repository (this deployment ships no container image, so filesystem is the honest scan type)                                                            |
| Supply-chain lens | Immutable SHA pins + OpenSSF Scorecard + Dependabot + `security-events` findings for SEC-014                                                                                           |

CodeQL is the only SAST engine: adding Semgrep on top would re-report the same class of findings and
double triage cost without adding coverage. Documented in `security.yml`.

## Failing policy for HIGH / CRITICAL

- Trivy: `severity: HIGH,CRITICAL`, `ignore-unfixed: true`, `exit-code: "1"`, SARIF uploaded even on
  failure so the finding is visible in the Security tab. `ignore-unfixed: true` means "no fix exists
  yet" is not a merge blocker, but "fix available" (any severity at or above the threshold) is.
- OSV-Scanner: `fail-on-vuln: true`.
- gitleaks: any detected secret fails the job; a secret that reaches git history must be rotated
  (see `CREDENTIAL_INCIDENT_RUNBOOK.md`), not merely deleted.
- CodeQL: default severity-based failure; results land in the Security tab.
- `ci.yml` dependency audit fails on `high` and above for production dependencies.
- There is **no** `.trivyignore`. Suppressing a finding requires a justified entry added to the
  workflow comment next to the Trivy step and a matching note here.

## Workflow verifiers

Two local verifiers are run against `.github/workflows/**` whenever a workflow changes:

```bash
actionlint .github/workflows/ci.yml .github/workflows/security.yml
zizmor --offline .github/workflows/
```

Both must report clean. `zizmor --offline` needs no network and no token, so it is safe to run
locally and in review.

### Findings triaged in this pass

| Finding                                                                                   | Where                 | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artipacked` (Medium) — checkout persists a credential into `.git/config`                 | `ci.yml` `verify` job | **Fixed.** `persist-credentials: false`; the job never pushes, so the credential was pure liability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cache-poisoning` (High, confidence Low) — cache restored into an artifact-publishing run | `ci.yml` `verify` job | **Fixed by removal, then suppressed as a documented false positive.** The npm cache is gone: this job publishes the JUnit evidence artifact, and whoever can seed a cache can influence what gets published, so `npm ci` runs cold. `zizmor` still flags `actions/setup-node` heuristically; it cannot see that v4.4.0 declares `cache:` with _no default_, so caching activates only when that input is supplied — and it is not. Verified against the pinned `action.yml`. Suppressed inline with `# zizmor: ignore[cache-poisoning]` and the reason, so a real reintroduction of `cache:` still has to be justified. |

`security.yml` was clean on both verifiers: every `actions/checkout` there already sets
`persist-credentials: false`, and no job restores a cache.

If a future change needs the npm cache back, the correct form is to bump `actions/setup-node`
to a release that supports the `package-manager-cache` input (v6.5.0 and later) and gate it with a
boolean expression, which is the pattern `zizmor` recognises:

```yaml
- uses: actions/setup-node@<40-char-sha> # v6.5.0
  with:
    node-version: "24"
    cache: npm
    package-manager-cache: ${{ github.event_name != 'pull_request' }}
```

## Fork pull requests

`pull_request` workflows from forks receive a read-only token, so jobs that upload SARIF may fail
there. That is expected and accepted: fork PRs are for review only, the scanners must be green on
the base branch before merge, and the `verify` job in `ci.yml` (which needs no write permission) is
the gate a contributor can actually satisfy. Fork contributions are merged into a branch of this
repository, where the full scanner set runs with write permissions.

## Merge gate

Every workflow in this directory is **active on the remote** (`gh api repos/<owner>/<repo>/actions/workflows`
reports `ci` and `security` as `active`), but the checks only become a gate once branch protection
requires them. That setting lives in repository configuration, not in the tree, and it needs
`admin` permission on the repository — a collaborator with only `push` gets HTTP 404 from the
protection endpoint, so it cannot be applied from this branch and is listed as an external
operational condition.

Run these as the repository owner (`markprovjp`), replacing the owner/repo if it is ever forked:

```bash
REPO=markprovjp/BOT_TELE

# Require the pull-request path and both workflows for main and release branches.
for BRANCH in main 'release/**'; do
  gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" \
    -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "verify",
      "CodeQL (javascript-typescript)",
      "Dependency scan (OSV-Scanner)",
      "Secret scan (gitleaks)",
      "SBOM (CycloneDX)",
      "Filesystem scan (Trivy)",
      "OpenSSF Scorecard"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "required_linear_history": true
}
JSON
done

# Least-privilege default token for every workflow, and no Actions-created PRs.
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# Secret scanning + push protection, where the plan provides them.
gh api -X PATCH "repos/$REPO" -F security_and_analysis[secret_scanning][status]=enabled 2>/dev/null || \
  echo "secret scanning is not available on this plan — enable it in Settings > Code security"
```

Two of these are worth spelling out because they are easy to misread:

- `required_status_checks.contexts` must name the **job** names exactly as the workflows declare
  them, so renaming a job silently removes it from the gate; re-run the command after any rename.
- `enforce_admins: true` is deliberate: the sole owner is exactly the actor most able to bypass a
  gate by accident.

Dependabot pull requests are validated by the same workflows and must never be merged with red or
skipped checks.
