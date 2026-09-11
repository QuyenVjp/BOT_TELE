import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI/CD and software-supply-chain hardening guards (THREAT_MODEL "Verification
 * baseline": secret, SAST, dependency, SBOM and container scans).
 *
 * The workflows are asserted as TEXT on purpose. The repository has no YAML
 * dependency, and adding one just to parse four files is not justified: every
 * assertion below is structural (trigger list, pin format, per-job permission
 * block) and can be checked deterministically offline, with no network and no
 * Docker.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..");
const workflowsDir = resolve(repoRoot, ".github", "workflows");
const WORKFLOW_FILES = ["ci.yml", "security.yml"] as const;
// A "floating" ref is a tag/branch like `@v4`, `@4.6.2` or `@main`. The
// lookahead keeps 40-hex SHA pins (which also start with a digit) from matching.
const FLOATING_USES = /uses:\s*[^@\s]+@v?\d(?![0-9a-f]{39})/u;
const SHA_REF = /^[0-9a-f]{40}$/u;

function readWorkflow(name: string): string {
  const path = resolve(workflowsDir, name);
  expect(existsSync(path), `${name} must exist`).toBe(true);
  return readFileSync(path, "utf8");
}

/** Every `uses:` line, including reusable-workflow calls at job level. */
function usesLines(source: string): string[] {
  return source.split("\n").filter((line) => /^\s*(?:- )?uses:\s*\S+@\S+/u.test(line));
}

/** Job ids in order, with the body lines that follow each 2-space `id:` key. */
function jobBlocks(source: string): { id: string; body: string }[] {
  const jobsSection = source.split(/^jobs:\s*$/mu)[1] ?? "";
  const blocks: { id: string; body: string }[] = [];
  let current: { id: string; body: string[] } | undefined;
  for (const line of jobsSection.split("\n")) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line)?.[1];
    if (id) {
      if (current) blocks.push({ id: current.id, body: current.body.join("\n") });
      current = { id, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) blocks.push({ id: current.id, body: current.body.join("\n") });
  return blocks;
}

const security = readWorkflow("security.yml");

describe("ci.yml triggers release branches", () => {
  const ci = readWorkflow("ci.yml");

  it("runs on push to main, the MVP branch and every release/** branch", () => {
    const branches = /push:\s*\n(?:\s*#[^\n]*\n)*\s*branches:\s*\[([^\]]*)\]/u
      .exec(ci)?.[1]
      ?.split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/gu, ""));

    expect(branches).toEqual(["main", "001-telegram-shop-mvp", "release/**"]);
  });

  it("still runs on pull_request and keeps contents: read at workflow level", () => {
    expect(ci).toMatch(/^ {2}pull_request:\s*$/mu);
    expect(ci).toMatch(/^permissions:\s*\n {2}contents: read\s*$/mu);
  });
});

describe("action pins are immutable", () => {
  it.each(WORKFLOW_FILES)("%s pins every uses: to a full commit SHA", (file) => {
    const source = readWorkflow(file);
    const lines = usesLines(source);
    expect(lines.length).toBeGreaterThan(0);

    const unpinned = lines.filter((line) => !SHA_REF.test(/@([^\s#]+)/u.exec(line)?.[1] ?? ""));
    expect(unpinned, `floating refs in ${file}`).toEqual([]);

    const missingLabel = lines.filter((line) => !/#\s*v?\d/u.test(line));
    expect(missingLabel, `pin without version comment in ${file}`).toEqual([]);
  });

  it.each(WORKFLOW_FILES)("%s contains no floating version refs", (file) => {
    expect(readWorkflow(file)).not.toMatch(FLOATING_USES);
  });

  it("security.yml pins the verified upstream revisions", () => {
    const pins = usesLines(security).map((line) => `${line.match(/uses:\s*(\S+)/u)?.[1]}`);
    expect(pins).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(pins).toContain("github/codeql-action/init@faaca9a8f6edddba5725ffe5adefdab6669a2eca");
    expect(pins).toContain("github/codeql-action/analyze@faaca9a8f6edddba5725ffe5adefdab6669a2eca");
    expect(pins).toContain(
      "github/codeql-action/upload-sarif@faaca9a8f6edddba5725ffe5adefdab6669a2eca",
    );
    expect(pins).toContain(
      "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@6e4298ebc4db23e847df9b2e2de2939d6f066c67",
    );
    expect(pins).toContain("gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7");
    expect(pins).toContain("anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610");
    expect(pins).toContain("aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25");
    expect(pins).toContain("ossf/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc");
  });
});

describe("dangerous workflow patterns stay out", () => {
  it.each(WORKFLOW_FILES)("%s avoids privileged or injected triggers", (file) => {
    const source = readWorkflow(file);
    expect(source).not.toMatch(/^\s*(?:-\s*)?pull_request_target:/mu);
    expect(source).not.toMatch(/^\s*(?:-\s*)?workflow_run:/mu);
  });

  it.each(WORKFLOW_FILES)("%s never pipes a download into a shell", (file) => {
    const source = readWorkflow(file);
    expect(source).not.toMatch(/(?:curl|wget)\s[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh/u);
    expect(source).not.toMatch(/npx\s+\S*@latest/u);
  });
});

describe("actions permissions stay least-privilege", () => {
  it.each(WORKFLOW_FILES)("%s declares permissions and never write-all", (file) => {
    const source = readWorkflow(file);
    expect(source).toMatch(/^permissions:/mu);
    expect(source).not.toMatch(/permissions:\s*write-all/u);
  });

  it("security.yml gives every job its own minimal permissions block", () => {
    const jobs = jobBlocks(security);
    expect(jobs.map((job) => job.id)).toEqual([
      "codeql",
      "dependency-scan",
      "secret-scan",
      "sbom",
      "container-scan",
      "scorecard",
    ]);

    for (const { id, body } of jobs) {
      expect(body, `${id} must declare its own permissions`).toMatch(/^ {4}permissions:\s*$/mu);
      expect(body, `${id} must not request write-all`).not.toMatch(/write-all/u);
      expect(body, `${id} must not write repository contents`).not.toMatch(/contents: write/u);
    }
  });

  it("only the SARIF-uploading jobs get security-events: write", () => {
    const withSecurityEvents = jobBlocks(security)
      .filter((job) => /security-events: write/u.test(job.body))
      .map((job) => job.id);
    expect(withSecurityEvents).toEqual([
      "codeql",
      "dependency-scan",
      "container-scan",
      "scorecard",
    ]);
    expect(security).toMatch(/id-token: write/u);
  });

  it("security.yml keeps its scan matrix and the weekly schedule", () => {
    expect(security).toMatch(/languages: javascript-typescript/u);
    expect(security).toMatch(/scan-type: fs/u);
    expect(security).toMatch(/severity: HIGH,CRITICAL/u);
    expect(security).toMatch(/exit-code: "1"/u);
    expect(security).toMatch(/^ {4}- cron: "\d+ \d+ \* \* \d+"$/mu);
  });
});

describe("dependabot keeps pins and dependencies fresh", () => {
  const path = resolve(repoRoot, ".github", "dependabot.yml");

  it("declares the npm and github-actions ecosystems on a weekly schedule", () => {
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).toMatch(/^version: 2\s*$/mu);
    expect(source).toMatch(/package-ecosystem: npm\s*$/mu);
    expect(source).toMatch(/package-ecosystem: github-actions\s*$/mu);
    expect(source).toMatch(/target-branch: main/u);
    expect(source).toMatch(/interval: weekly/u);
    expect(source).toMatch(/open-pull-requests-limit: 5/u);
  });
});
