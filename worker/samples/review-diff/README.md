# review-diff

```sh
workling-worker prepare review-diff /tmp/run-review
workling-worker run /tmp/run-review
```

检查 `/tmp/run-review/out/review.json`。预期 `verdict` 为 `changes`，验收项「`start > end` 时返回 `0`」为 `no`，并有一条指向 `src/range.ts` 的 `blocker`。样例的 `bun test` 会通过，因为新增的测试只覆盖 `sumRange(1, 3)`。
