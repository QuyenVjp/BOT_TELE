import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { healthPayload, loadBuildIdentity } from "../../src/shared/build-identity.js";

const COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function stamp(identity: unknown): string {
  dir = mkdtempSync(join(tmpdir(), "build-identity-"));
  writeFileSync(join(dir, "app.js"), "export {}\n");
  writeFileSync(join(dir, "build-identity.json"), `${JSON.stringify(identity)}\n`);
  return pathToFileURL(join(dir, "app.js")).href;
}

describe("build identity", () => {
  it("returns null when the identity file is missing", () => {
    expect(loadBuildIdentity(pathToFileURL(join(tmpdir(), "missing-app.js")).href)).toBeNull();
    expect(healthPayload(null)).toEqual({ status: "ok" });
  });

  it("loads a valid identity next to the compiled entrypoint", () => {
    const identity = loadBuildIdentity(
      stamp({ commit: COMMIT, builtAt: "2026-09-09T06:00:00.000Z", dirty: false }),
    );
    expect(identity).toEqual({
      commit: COMMIT,
      builtAt: "2026-09-09T06:00:00.000Z",
      dirty: false,
    });
    expect(healthPayload(identity)).toEqual({
      status: "ok",
      commit: COMMIT,
      builtAt: "2026-09-09T06:00:00.000Z",
      dirty: false,
    });
  });

  it("rejects a short or non-hex commit and does not leak unknown fields", () => {
    expect(
      loadBuildIdentity(
        stamp({
          commit: "deadbeef",
          builtAt: "2026-09-09T06:00:00.000Z",
          dirty: false,
          token: "secret",
        }),
      ),
    ).toBeNull();
  });
});
