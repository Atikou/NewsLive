import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { prepareHistory, pushHistory } from "../scripts/prune-history.js";

const now = Date.parse("2026-11-09T04:00:00Z");
const day = 86400000;
const date = (daysAgo) => new Date(now - daysAgo * day).toISOString();

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "newslive-history-"));
  t.after(() => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  const cwd = join(dir, "repo");
  const git = (args, options = {}) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: "pipe", ...options
  }).trim();
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "pipe" });
  const commit = (name, daysAgo, parents = [], extra = {}) => {
    const blob = git(["hash-object", "-w", "--stdin"], { input: name });
    const tree = git(["mktree"], { input: `100644 blob ${blob}\tfile.txt\n` });
    return git(["commit-tree", tree, ...parents.flatMap((sha) => ["-p", sha])], {
      input: `${name}\n`,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Original Author", GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "Committer", GIT_COMMITTER_EMAIL: "committer@example.com",
        GIT_AUTHOR_DATE: date(daysAgo), GIT_COMMITTER_DATE: date(daysAgo), ...extra
      }
    });
  };
  const head = (sha) => git(["update-ref", "refs/heads/main", sha]);
  const subjects = (sha) => git(["log", "--format=%s", sha]).split("\n");
  return { dir, cwd, git, commit, head, subjects };
}

test("清理严格早于 30 天的提交，保留边界、原始元数据与每次文件快照", (t) => {
  const f = fixture(t);
  const old = f.commit("old", 31);
  const boundary = f.commit("边界提交", 30, [old], { GIT_AUTHOR_DATE: date(60) });
  const latest = f.commit("latest", 1, [boundary]);
  f.head(latest);
  const result = prepareHistory({ cwd: f.cwd, now });
  assert.equal(result.removed, 1);
  assert.deepEqual(f.subjects(result.newHead), ["latest", "边界提交"]);
  const retained = f.git(["rev-list", result.newHead]).split("\n");
  for (const [index, original] of [latest, boundary].entries()) {
    const format = "%T%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%B";
    assert.equal(f.git(["show", "-s", `--format=${format}`, retained[index]]),
      f.git(["show", "-s", `--format=${format}`, original]));
  }
  assert.equal(f.git(["rev-parse", "HEAD"]), latest);
  f.head(result.newHead);
  assert.deepEqual(prepareHistory({ cwd: f.cwd, now }), {
    oldHead: result.newHead, newHead: result.newHead, removed: 0
  });
  f.git(["fsck", "--no-reflogs"]);
});

test("保留合并图与日期倒序中的近期祖先，不修改其他分支或标签", (t) => {
  const f = fixture(t);
  const old = f.commit("old root", 60);
  const recent = f.commit("recent ancestor", 20, [old]);
  const datedBack = f.commit("backdated old commit", 40, [recent]);
  const left = f.commit("left", 10, [datedBack]);
  const right = f.commit("right", 5, [old]);
  const merge = f.commit("merge", 0, [left, right]);
  f.head(merge);
  f.git(["tag", "keep-tag", old]);
  f.git(["branch", "keep-branch", old]);
  const result = prepareHistory({ cwd: f.cwd, now });
  assert.equal(result.removed, 2);
  assert.deepEqual(new Set(f.subjects(result.newHead)), new Set(["merge", "left", "right", "recent ancestor"]));
  assert.equal(f.git(["show", "-s", "--format=%P", result.newHead]).split(" ").length, 2);
  assert.equal(f.git(["show", "-s", "--format=%s", `${result.newHead}^1^1`]), "recent ancestor");
  assert.equal(f.git(["rev-parse", "keep-tag"]), old);
  assert.equal(f.git(["rev-parse", "keep-branch"]), old);
});

test("全部提交过期时保留当前完整快照", (t) => {
  const f = fixture(t);
  const old = f.commit("old", 90);
  const latest = f.commit("old latest", 40, [old]);
  f.head(latest);
  const result = prepareHistory({ cwd: f.cwd, now });
  assert.equal(result.removed, 2);
  assert.equal(f.git(["rev-list", "--count", result.newHead]), "1");
  assert.equal(f.git(["show", `${result.newHead}:file.txt`]), "old latest");
  assert.equal(f.git(["show", "-s", "--format=%ct", result.newHead]), String(now / 1000));
});

test("日期倒序的过期 HEAD 仍保留近期祖先及最新文件", (t) => {
  const f = fixture(t);
  const recent = f.commit("recent", 5);
  const oldTip = f.commit("old tip", 40, [recent]);
  f.head(oldTip);
  const result = prepareHistory({ cwd: f.cwd, now });
  assert.equal(f.git(["rev-list", "--count", result.newHead]), "2");
  assert.equal(f.git(["show", `${result.newHead}:file.txt`]), "old tip");
  assert.equal(f.git(["rev-parse", `${result.newHead}^`]), recent);
});

test("没有过期历史时不重写 SHA", (t) => {
  const f = fixture(t);
  const root = f.commit("recent", 1);
  f.head(root);
  assert.deepEqual(prepareHistory({ cwd: f.cwd, now }), { oldHead: root, newHead: root, removed: 0 });
});

test("推送仅更新指定分支，显式 lease 拒绝覆盖并发新提交", (t) => {
  const f = fixture(t);
  const old = f.commit("old", 50);
  const latest = f.commit("latest", 1, [old]);
  f.head(latest);
  const remote = join(f.dir, "remote.git");
  f.git(["init", "--bare", remote]);
  f.git(["remote", "add", "origin", remote]);
  f.git(["push", "origin", "main", `${old}:refs/heads/other`]);
  const result = prepareHistory({ cwd: f.cwd, now });
  const concurrent = f.commit("concurrent", 0, [latest]);
  f.git(["push", "origin", `${concurrent}:refs/heads/main`]);
  assert.throws(() => pushHistory(result, "main", f.cwd));
  assert.equal(f.git(["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0], concurrent);
  f.head(concurrent);
  const fresh = prepareHistory({ cwd: f.cwd, now });
  pushHistory(fresh, "main", f.cwd);
  assert.equal(f.git(["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0], fresh.newHead);
  assert.equal(f.git(["ls-remote", "origin", "refs/heads/other"]).split(/\s/)[0], old);
});

test("浅克隆拒绝清理，避免把不完整历史误认为全部历史", (t) => {
  const f = fixture(t);
  const old = f.commit("old", 50);
  f.head(f.commit("latest", 1, [old]));
  const shallow = join(f.dir, "shallow");
  f.git(["clone", "--depth=1", pathToFileURL(f.cwd).href, shallow]);
  assert.throws(() => prepareHistory({ cwd: shallow, now }), /full checkout/);
});
