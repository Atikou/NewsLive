import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function git(cwd, args, input) {
  return execFileSync("git", args, {
    cwd, input, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" }
  });
}

// Creates objects only: local branches, tags and working files are never changed.
export function prepareHistory({ cwd = process.cwd(), now = Date.now() } = {}) {
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]).toString().trim() !== "false") {
    throw new Error("History cleanup requires a full checkout (fetch-depth: 0).");
  }
  const cutoff = Math.floor(now / 1000) - 30 * 24 * 60 * 60;
  const oldHead = git(cwd, ["rev-parse", "HEAD"]).toString().trim();
  const rows = git(cwd, ["rev-list", "--reverse", "--topo-order", "--timestamp", "--parents", oldHead])
    .toString().trim().split("\n").map((line) => {
      const [time, sha, ...parents] = line.split(" ");
      return { time: Number(time), sha, parents };
    });
  const removed = rows.filter(({ time }) => time < cutoff).length;
  if (!removed) return { oldHead, newHead: oldHead, removed: 0 };

  const mapped = new Map();
  for (const { time, sha, parents } of rows) {
    // Contract removed nodes, including merges and out-of-order commit dates.
    const newParents = [...new Set(parents.flatMap((parent) => mapped.get(parent)))];
    if (time < cutoff && sha !== oldHead) {
      mapped.set(sha, newParents);
      continue;
    }
    if (time >= cutoff && parents.join(" ") === newParents.join(" ")) {
      mapped.set(sha, [sha]);
      continue;
    }
    // latin1 round-trips the original bytes even for non-UTF-8 commit messages.
    const raw = git(cwd, ["cat-file", "commit", sha]).toString("latin1");
    const separator = raw.indexOf("\n\n");
    let headers = raw.slice(0, separator).split(/\n(?=[^ ])/)
      .filter((field) => !/^(parent|gpgsig|gpgsig-sha256|mergetag) /.test(field));
    let message = raw.slice(separator + 2);
    if (time < cutoff) {
      // An inactive branch still needs a tip carrying its complete current tree.
      headers = headers.map((field) => /^(author|committer) /.test(field)
        ? field.replace(/\d+ [+-]\d{4}$/, `${Math.floor(now / 1000)} +0000`) : field);
      message = "chore: retain current snapshot after history cleanup\n";
    }
    headers.splice(1, 0, ...newParents.map((parent) => `parent ${parent}`));
    const rewritten = Buffer.from(`${headers.join("\n")}\n\n${message}`, "latin1");
    const newSha = git(cwd, ["hash-object", "-t", "commit", "-w", "--stdin"], rewritten).toString().trim();
    mapped.set(sha, [newSha]);
  }
  const [newHead] = mapped.get(oldHead);
  const tree = (sha) => git(cwd, ["rev-parse", `${sha}^{tree}`]).toString().trim();
  if (tree(oldHead) !== tree(newHead)) throw new Error("Cleanup changed the current file tree.");
  const dates = git(cwd, ["log", "--format=%ct", newHead]).toString().trim().split("\n");
  const expected = rows.length - removed + (rows.at(-1).time < cutoff ? 1 : 0);
  if (dates.length !== expected || dates.some((date) => Number(date) < cutoff)) {
    throw new Error("Cleanup failed to preserve exactly the retained history.");
  }
  return { oldHead, newHead, removed };
}

export function pushHistory({ oldHead, newHead }, branch, cwd = process.cwd()) {
  const ref = `refs/heads/${branch}`;
  git(cwd, ["check-ref-format", ref]);
  if (newHead === oldHead) return;
  // Explicit expected SHA protects against commits pushed after checkout.
  git(cwd, ["push", `--force-with-lease=${ref}:${oldHead}`, "origin", `${newHead}:${ref}`]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--push" || !args[1])) {
    throw new Error("Usage: node scripts/prune-history.js [--push <default-branch>]");
  }
  const result = prepareHistory();
  console.log(`Commits older than 30 days: ${result.removed}; ${result.oldHead} -> ${result.newHead}`);
  if (args.length) {
    pushHistory(result, args[1]);
    console.log(result.removed ? "History cleanup pushed successfully." : "No cleanup needed.");
  } else {
    console.log("Dry run: no branch references or remote repositories were changed.");
  }
}
