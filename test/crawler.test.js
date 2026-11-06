import assert from "node:assert/strict";
import test from "node:test";
import { isPublishedAfter } from "../src/crawler.js";

test("即时推送只接收上次成功抓取之后发布的事件", () => {
  const cutoff = new Date("2026-08-03T01:00:00.000Z");

  assert.equal(
    isPublishedAfter({ pubDate: "2026-08-03T01:00:01.000Z" }, cutoff),
    true
  );
  assert.equal(
    isPublishedAfter({ pubDate: "2026-08-03T01:00:00.000Z" }, cutoff),
    false
  );
  assert.equal(
    isPublishedAfter({ pubDate: "2026-08-03T00:59:59.000Z" }, cutoff),
    false
  );
  assert.equal(isPublishedAfter({ pubDate: "not-a-date" }, cutoff), false);
});
