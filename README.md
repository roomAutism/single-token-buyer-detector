# Single-Token Buyer Detector

Solana 链上分析 MVP：输入一个 Token CA，读取该 token 的买入钱包，再扫描钱包历史 DEX swap，只保留历史上主动买入过且唯一买入 mint 等于当前 CA 的钱包。

## 当前 MVP

- Next.js + TypeScript
- 服务端 API route 调用 Birdeye 和 Helius
- 前端不接触 API key
- 默认扫描前 10 名买家 + 最近 20 笔 swap，避免 Vercel Runtime Timeout
- `/api/analyze` 只获取 Birdeye 买家列表，不在同一个请求内等待全部 Helius 钱包历史扫描
- `/api/analyze-wallet` 每次只分析 1 个公开钱包，前端用最大 2 并发队列逐钱包更新结果
- 支持最近 20 笔、最近 100 笔、全历史分批模式
- 服务端缓存钱包分析结果 24 小时
- 并发限制、重试、CSV 导出
- 可选“指定钱包地址（调试）”，不要求该钱包位于前 N 买家内
- 分析状态拆分为 completed、data_insufficient、analysis_error、coverage_limited
- 展示三类币种统计：历史参与非基础币种数、累计曾持有币种数、当前持有币种数
- 表头排序和筛选均在前端本地完成，不会因为排序重新请求 API

## 数据规则

本工具不使用当前余额判断钱包是否“只买过一个币”。判断基于历史 SWAP：

- 只统计钱包主动 swap 买入后收到的 token mint
- 严格单币按“真实 swap 参与过的非基础 token mint”判断，买入和卖出都计入参与历史
- SOL / wSOL / USDC / USDT 不计入买过的币种
- 普通转账、空投、创建 ATA 余额变化不计入
- API 失败会标记为 `analysis_error`；达到全历史页数保护上限会标记为 `coverage_limited`；真实缺少可判定交易才标记为 `data_insufficient`
- 已经卖光当前 token 不影响严格单币资格；当前是否持仓仅作为单独字段展示

## 三类币种统计

- `historicalSwappedNonBaseTokenCount`：真实 swap 中参与过的非基础 token 数量，买入和卖出都算，用于严格单币/多币判定。
- `everHeldNonBaseTokenCount`：解析交易中能确认余额曾增加到大于 0 的非基础 token 数量。transfer/unknown 会作为观察字段展示，不会改变严格单币判定。
- `currentHeldNonBaseTokenCount`：当前余额仍大于 0 的非基础 token 数量，独立于 `currentlyHolding` 当前输入 token 的布尔值。

## Runtime 设计

Vercel Serverless 有执行时长限制，所以工具分两阶段运行：

1. `POST /api/analyze`：校验 Token CA，调用 Birdeye 获取买家列表，快速返回。
2. `POST /api/analyze-wallet`：逐个钱包调用 Helius 扫描 swap 历史。每个钱包请求都有 `maxPages`、`maxTransactions` 和安全耗时限制，超过限制返回 `coverage_limited`，不会等待到 Vercel 300 秒超时。

前端负责调度钱包队列，默认最大并发 2，并实时显示 `pending`、`analyzing`、`completed`、`data_insufficient`、`coverage_limited`、`analysis_error`。

Helius 429 限流会进入独立重试队列，不阻塞首轮分析：

- 首轮钱包分析保持最大并发 2，已完成结果立即显示。
- 只有 Helius 429 钱包会进入 `retrying` 状态。
- 优先使用 `Retry-After`，否则按 2 秒、5 秒、10 秒退避。
- 最多重试 3 次，最终失败显示 `Helius rate limited after 3 retries`。
- 服务端 Helius 请求共享自适应节流器；出现 429 后短时间降速，稳定后恢复。

## 配置

复制环境变量文件：

```bash
cp .env.example .env.local
```

填入：

```bash
BIRDEYE_API_KEY=your_birdeye_key
HELIUS_API_KEY=your_helius_key
```

## 本地运行

```bash
pnpm install
pnpm dev
```

打开 `http://localhost:3000`。

## 部署到 Vercel

1. 将项目推到 GitHub。
2. 在 Vercel Dashboard 点击 Add New → Project。
3. 选择这个 GitHub 仓库并导入。
4. Framework Preset 选择 Next.js，其他保持默认：
   - Install Command: `pnpm install`
   - Build Command: `pnpm build`
   - Output Directory: 留空
5. 在 Environment Variables 添加：
   - `BIRDEYE_API_KEY`
   - `HELIUS_API_KEY`
6. 点击 Deploy。

注意：当前 MVP 使用服务端内存缓存，适合先部署验证。Vercel Serverless 多实例或冷启动后缓存可能丢失；生产版建议把 `lib/cache.ts` 换成 Vercel KV、Upstash Redis 或 Postgres。

## 安全

本工具不连接钱包、不需要私钥、不签名、不执行交易，只读取公开链上数据。
