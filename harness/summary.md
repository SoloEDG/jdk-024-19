# 契约引擎验证

无浏览器依赖，直接跑：

```bash
npx esbuild harness/engine.test.ts --bundle --platform=node --format=cjs --outfile=/tmp/contract-run/test.js
node /tmp/contract-run/test.js
```

覆盖：前置与开约边界、尾巴接力、同鱼共享预览/独占结算、非贪心最大组合、
互斥放弃、重试只开当前阶段、刷新/断线/换约同序、压缩后保留见证与原因、
重复领取不二次消耗/不发奖、预算过期与 requiresAny 下游。
