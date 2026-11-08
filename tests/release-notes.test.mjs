import test from "node:test";
import assert from "node:assert/strict";
import { releaseNotes } from "../scripts/release-notes.mjs";

test("release notes contain only the requested version, retaining subsections and links", () => {
  const changelog = "# Changelog\n\n## 0.4.0\n\nFuture.\n\n## 0.3.1\n\n### Added\n\n- Cancel.\n\n[Compare](https://example.com/compare)\n\n## 0.3.0\n\nOld.\n";
  assert.equal(releaseNotes(changelog, "0.3.1"), "## 0.3.1\n\n### Added\n\n- Cancel.\n\n[Compare](https://example.com/compare)\n");
});

test("missing, empty, duplicate and invalid version entries prevent publishing", () => {
  for (const text of ["## 0.3.0\nOld", "## 0.3.1\n\n## 0.3.0\nOld", "## 0.3.1\nA\n## 0.3.1\nB"]) assert.throws(() => releaseNotes(text, "0.3.1"));
  assert.throws(() => releaseNotes("## v0.3.1\nA", "v0.3.1"));
});

test("last entries and Windows line endings are supported", () => {
  assert.equal(releaseNotes("# Changelog\r\n## 0.3.1\r\n\r\nFix.\r\n", "0.3.1"), "## 0.3.1\n\nFix.\n");
});
