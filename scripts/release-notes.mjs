import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateVersion } from "./version.mjs";

export function releaseNotes(changelog, version) {
  validateVersion(version);
  const sections = [...changelog.matchAll(/^## ([^\r\n]+)\r?\n/gm)];
  const matches = sections.filter((match) => match[1].trim() === version);
  if (matches.length !== 1) throw new Error(`Expected one ## ${version} entry in CHANGELOG.md.`);
  const heading = matches[0];
  const next = sections[sections.indexOf(heading) + 1];
  const body = changelog.slice(heading.index + heading[0].length, next?.index ?? changelog.length).trim();
  if (!body) throw new Error(`Add release notes under ## ${version} in CHANGELOG.md.`);
  return `## ${version}\n\n${body}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(releaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
