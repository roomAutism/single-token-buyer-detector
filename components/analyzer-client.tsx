"use client";

import { ChevronDown, ChevronRight, Copy, Download, ExternalLink, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { AnalyzeResponse, BuyerLimit, HistoryRange, WalletAnalysis } from "@/lib/types";

type SortKey = "firstBuyAt" | "totalBuyAmountSol" | "walletAgeDays";

function fmtDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function fmtNumber(value: number, digits = 4) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function statusLabel(wallet: WalletAnalysis) {
  if (wallet.analysisStatus === "completed") return wallet.strictSingleToken ? "严格单币" : "多币/非单币";
  if (wallet.analysisStatus === "data_insufficient") return "数据不足";
  if (wallet.analysisStatus === "analysis_error") return "分析失败";
  return "覆盖受限";
}

function statusClass(wallet: WalletAnalysis) {
  if (wallet.analysisStatus === "completed") return wallet.strictSingleToken ? "complete" : "partial";
  return wallet.analysisStatus;
}

function yesNo(value: boolean | null) {
  if (value === null) return "未知";
  return value ? "是" : "否";
}

function toCsv(rows: WalletAnalysis[]) {
  const header = [
    "wallet",
    "analysisStatus",
    "strictSingleToken",
    "tradedCurrentToken",
    "firstBuyAt",
    "firstBuyAmountSol",
    "totalBuyAmountSol",
    "currentlyHolding",
    "soldOut",
    "uniqueNonBaseTokenCount",
    "nonBaseTokenMints",
    "scanTransactionCount",
    "scanPageCount",
    "scanStartedAt",
    "scanEndedAt",
    "reason"
  ];
  const body = rows.map((row) =>
    header
      .map((key) => {
        const value = row[key as keyof WalletAnalysis];
        return `"${String(Array.isArray(value) ? value.join("|") : value ?? "").replaceAll('"', '""')}"`;
      })
      .join(",")
  );
  return [header.join(","), ...body].join("\n");
}

function WalletDetails({ wallet }: { wallet: WalletAnalysis }) {
  return (
    <div className="detailsBox">
      <div className="detailsGrid">
        <div><span>analysis_status</span><strong>{wallet.analysisStatus}</strong></div>
        <div><span>strict_single_token</span><strong>{String(wallet.strictSingleToken)}</strong></div>
        <div><span>unique_non_base_token_count</span><strong>{wallet.uniqueNonBaseTokenCount}</strong></div>
        <div><span>traded_current_token</span><strong>{String(wallet.tradedCurrentToken)}</strong></div>
        <div><span>currently_holding</span><strong>{yesNo(wallet.currentlyHolding)}</strong></div>
        <div><span>sold_out</span><strong>{yesNo(wallet.soldOut)}</strong></div>
        <div><span>scan_transactions</span><strong>{wallet.scanTransactionCount}</strong></div>
        <div><span>scan_pages</span><strong>{wallet.scanPageCount}</strong></div>
        <div><span>history_start</span><strong>{fmtDate(wallet.scanStartedAt)}</strong></div>
        <div><span>history_end</span><strong>{fmtDate(wallet.scanEndedAt)}</strong></div>
        <div><span>helius_status_codes</span><strong>{wallet.heliusStatusCodes.join(",") || "-"}</strong></div>
        <div><span>helius_retries</span><strong>{wallet.heliusRetryCount}</strong></div>
      </div>

      <div className="mintList">
        <span>发现的非基础 Token mint</span>
        {wallet.nonBaseTokenMints.length ? (
          wallet.nonBaseTokenMints.map((mint) => <code key={mint}>{mint}</code>)
        ) : (
          <em>未发现</em>
        )}
      </div>

      <div className="eventList">
        <span>判定过程</span>
        {wallet.debugEvents.length ? (
          wallet.debugEvents.map((event) => (
            <div key={event.signature} className="eventRow">
              <code>{shortAddress(event.signature)}</code>
              <span>{fmtDate(event.timestamp)}</span>
              <span>{event.type ?? "-"}</span>
              <span>{event.source ?? "-"}</span>
              <span>{event.involvesCurrentToken ? "涉及当前 Token" : "未涉及当前 Token"}</span>
              <span>{event.nonBaseMints.join(", ") || "无非基础 token"}</span>
            </div>
          ))
        ) : (
          <em>没有可展示的 swap 事件</em>
        )}
      </div>
    </div>
  );
}

export function AnalyzerClient() {
  const [tokenMint, setTokenMint] = useState("");
  const [debugWallet, setDebugWallet] = useState("");
  const [buyerLimit, setBuyerLimit] = useState<BuyerLimit>(100);
  const [historyRange, setHistoryRange] = useState<HistoryRange>("full");
  const [onlySingle, setOnlySingle] = useState(true);
  const [onlyHolding, setOnlyHolding] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("firstBuyAt");
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);
  const [data, setData] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function analyze() {
    setError("");
    setLoading(true);
    setData(null);
    setExpandedWallet(null);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenMint, buyerLimit, historyRange, debugWallet })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "分析失败");
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "分析失败");
    } finally {
      setLoading(false);
    }
  }

  const rows = useMemo(() => {
    const source = data?.wallets ?? [];
    return source
      .filter((wallet) => (onlySingle ? wallet.analysisStatus === "completed" && wallet.strictSingleToken : true))
      .filter((wallet) => (onlyHolding ? wallet.currentlyHolding === true : true))
      .sort((a, b) => {
        if (sortKey === "totalBuyAmountSol") return b.totalBuyAmountSol - a.totalBuyAmountSol;
        if (sortKey === "walletAgeDays") return (b.walletAgeDays ?? -1) - (a.walletAgeDays ?? -1);
        return new Date(a.firstBuyAt ?? 0).getTime() - new Date(b.firstBuyAt ?? 0).getTime();
      });
  }, [data, onlyHolding, onlySingle, sortKey]);

  function exportCsv() {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `single-token-buyers-${data?.tokenMint ?? "token"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Solana Chain Analysis</p>
          <h1>Single-Token Buyer Detector</h1>
        </div>
        {data ? <button className="iconButton" onClick={exportCsv} title="导出 CSV"><Download size={18} /></button> : null}
      </section>

      <section className="panel inputPanel">
        <label className="field tokenField">
          <span>Token CA</span>
          <input value={tokenMint} onChange={(event) => setTokenMint(event.target.value)} placeholder="输入 Solana Token Mint" />
        </label>

        <label className="field debugField">
          <span>指定钱包地址（调试）</span>
          <input value={debugWallet} onChange={(event) => setDebugWallet(event.target.value)} placeholder="可选，公开钱包地址" />
        </label>

        <label className="field">
          <span>分析范围</span>
          <select value={buyerLimit} onChange={(event) => setBuyerLimit(Number(event.target.value) as BuyerLimit)}>
            <option value={100}>前 100 名买家</option>
            <option value={300}>前 300 名买家</option>
            <option value={500}>前 500 名买家</option>
          </select>
        </label>

        <label className="field">
          <span>历史扫描</span>
          <select value={historyRange} onChange={(event) => setHistoryRange(event.target.value as HistoryRange)}>
            <option value="20swaps">最近 20 笔 swap</option>
            <option value="30d">最近 30 天</option>
            <option value="90d">最近 90 天</option>
            <option value="500swaps">最近 500 笔 swap</option>
            <option value="full">全历史（慢速）</option>
          </select>
        </label>

        <button className="primaryButton" onClick={analyze} disabled={loading || !tokenMint.trim()}>
          <Search size={17} />
          {loading ? "分析中" : "开始分析"}
        </button>
      </section>

      {loading ? (
        <section className="panel progressPanel">
          <div className="progressBar"><span /></div>
          <p>正在读取买家交易、扫描钱包历史并写入 24 小时服务端缓存。</p>
        </section>
      ) : null}

      {error ? <section className="errorPanel">{error}</section> : null}

      {data ? (
        <>
          <section className="metrics">
            <div><span>总买家数</span><strong>{data.summary.totalBuyers}</strong></div>
            <div><span>已完成分析</span><strong>{data.summary.completedWallets}</strong></div>
            <div><span>严格单币钱包</span><strong>{data.summary.strictSingleTokenWallets}</strong></div>
            <div><span>多币钱包</span><strong>{data.summary.multiTokenWallets}</strong></div>
            <div><span>数据不足</span><strong>{data.summary.insufficientWallets}</strong></div>
            <div><span>分析失败</span><strong>{data.summary.analysisErrorWallets}</strong></div>
            <div><span>历史覆盖受限</span><strong>{data.summary.coverageLimitedWallets}</strong></div>
            <div><span>单币占比</span><strong>{fmtNumber(data.summary.singleTokenRatio * 100, 2)}%</strong></div>
          </section>

          {data.debugWallet ? (
            <section className="panel debugPanel">
              <div className="debugHeader">
                <div>
                  <span>指定钱包调试</span>
                  <strong>{shortAddress(data.debugWallet.wallet.wallet)}</strong>
                </div>
                <div>
                  <span>是否在买家列表</span>
                  <strong>{data.debugWallet.isInBuyerList ? `是，第 ${data.debugWallet.buyerRank} 名` : "否"}</strong>
                </div>
                <div>
                  <span>首次买入 / 累计 SOL</span>
                  <strong>{fmtDate(data.debugWallet.buyer?.firstBuyAt)} / {fmtNumber(data.debugWallet.buyer?.totalBuyAmountSol ?? 0)}</strong>
                </div>
              </div>
              <WalletDetails wallet={data.debugWallet.wallet} />
            </section>
          ) : null}

          <section className="panel controls">
            <label><input type="checkbox" checked={onlySingle} onChange={(event) => setOnlySingle(event.target.checked)} /> 仅严格单币</label>
            <label><input type="checkbox" checked={onlyHolding} onChange={(event) => setOnlyHolding(event.target.checked)} /> 仅仍持仓</label>
            <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
              <option value="firstBuyAt">按首次买入时间</option>
              <option value="totalBuyAmountSol">按累计买入金额</option>
              <option value="walletAgeDays">按钱包年龄</option>
            </select>
          </section>

          <section className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>详情</th>
                  <th>钱包</th>
                  <th>链接</th>
                  <th>分析状态</th>
                  <th>首次买入</th>
                  <th>累计 SOL</th>
                  <th>非基础币种数</th>
                  <th>当前持仓</th>
                  <th>是否卖光</th>
                  <th>扫描笔数</th>
                  <th>扫描页数</th>
                  <th>钱包年龄</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((wallet) => (
                  <>
                    <tr key={wallet.wallet}>
                      <td>
                        <button
                          className="miniButton"
                          onClick={() => setExpandedWallet(expandedWallet === wallet.wallet ? null : wallet.wallet)}
                          title="展开详情"
                        >
                          {expandedWallet === wallet.wallet ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="walletCell">
                        <code>{shortAddress(wallet.wallet)}</code>
                        <button className="miniButton" onClick={() => navigator.clipboard.writeText(wallet.wallet)} title="复制地址">
                          <Copy size={14} />
                        </button>
                      </td>
                      <td className="linkCell">
                        <a href={`https://solscan.io/account/${wallet.wallet}`} target="_blank" rel="noreferrer" title="Solscan">
                          <ExternalLink size={15} />
                        </a>
                        <a href={`https://gmgn.ai/sol/address/${wallet.wallet}`} target="_blank" rel="noreferrer" title="GMGN">GMGN</a>
                      </td>
                      <td><span className={`pill ${statusClass(wallet)}`}>{statusLabel(wallet)}</span></td>
                      <td>{fmtDate(wallet.firstBuyAt)}</td>
                      <td>{fmtNumber(wallet.totalBuyAmountSol)}</td>
                      <td>{wallet.uniqueNonBaseTokenCount}</td>
                      <td>{yesNo(wallet.currentlyHolding)}</td>
                      <td>{yesNo(wallet.soldOut)}</td>
                      <td>{wallet.scanTransactionCount}</td>
                      <td>{wallet.scanPageCount}</td>
                      <td>{wallet.walletAgeDays === undefined ? "-" : `${wallet.walletAgeDays} 天`}</td>
                      <td>{wallet.reason ?? "-"}</td>
                    </tr>
                    {expandedWallet === wallet.wallet ? (
                      <tr key={`${wallet.wallet}-details`}>
                        <td colSpan={13}>
                          <WalletDetails wallet={wallet} />
                        </td>
                      </tr>
                    ) : null}
                  </>
                ))}
                {rows.length === 0 ? (
                  <tr><td colSpan={13} className="emptyCell">没有符合当前筛选的钱包</td></tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </main>
  );
}
