"use client";

import { Copy, Download, ExternalLink, Search } from "lucide-react";
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

function confidenceLabel(value: WalletAnalysis["confidence"]) {
  if (value === "complete") return "完整";
  if (value === "partial") return "部分";
  return "不足";
}

function toCsv(rows: WalletAnalysis[]) {
  const header = [
    "wallet",
    "firstBuyAt",
    "firstBuyAmountSol",
    "totalBuyAmountSol",
    "stillHolding",
    "distinctBoughtMintCount",
    "firstActivityAt",
    "walletAgeDays",
    "confidence",
    "status"
  ];
  const body = rows.map((row) =>
    header
      .map((key) => {
        const value = row[key as keyof WalletAnalysis];
        return `"${String(value ?? "").replaceAll('"', '""')}"`;
      })
      .join(",")
  );
  return [header.join(","), ...body].join("\n");
}

export function AnalyzerClient() {
  const [tokenMint, setTokenMint] = useState("");
  const [buyerLimit, setBuyerLimit] = useState<BuyerLimit>(100);
  const [historyRange, setHistoryRange] = useState<HistoryRange>("full");
  const [onlySingle, setOnlySingle] = useState(true);
  const [onlyHolding, setOnlyHolding] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("firstBuyAt");
  const [data, setData] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function analyze() {
    setError("");
    setLoading(true);
    setData(null);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenMint, buyerLimit, historyRange })
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
      .filter((wallet) => (onlySingle ? wallet.status === "single" : true))
      .filter((wallet) => (onlyHolding ? wallet.stillHolding === true : true))
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
          <input
            value={tokenMint}
            onChange={(event) => setTokenMint(event.target.value)}
            placeholder="输入 Solana Token Mint"
          />
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
          <p>正在读取买家交易、扫描钱包历史并写入 24 小时缓存。</p>
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
            <div><span>单币占比</span><strong>{fmtNumber(data.summary.singleTokenRatio * 100, 2)}%</strong></div>
          </section>

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
                  <th>钱包</th>
                  <th>链接</th>
                  <th>首次买入</th>
                  <th>首次买入 SOL</th>
                  <th>累计 SOL</th>
                  <th>仍持仓</th>
                  <th>买入币种数</th>
                  <th>首次活动</th>
                  <th>钱包年龄</th>
                  <th>可信度</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((wallet) => (
                  <tr key={wallet.wallet}>
                    <td className="walletCell">
                      <code>{wallet.wallet.slice(0, 6)}...{wallet.wallet.slice(-6)}</code>
                      <button className="miniButton" onClick={() => navigator.clipboard.writeText(wallet.wallet)} title="复制地址">
                        <Copy size={14} />
                      </button>
                    </td>
                    <td className="linkCell">
                      <a href={`https://solscan.io/account/${wallet.wallet}`} target="_blank" rel="noreferrer" title="Solscan">
                        <ExternalLink size={15} />
                      </a>
                      <a href={`https://gmgn.ai/sol/address/${wallet.wallet}`} target="_blank" rel="noreferrer" title="GMGN">
                        GMGN
                      </a>
                    </td>
                    <td>{fmtDate(wallet.firstBuyAt)}</td>
                    <td>{fmtNumber(wallet.firstBuyAmountSol)}</td>
                    <td>{fmtNumber(wallet.totalBuyAmountSol)}</td>
                    <td>{wallet.stillHolding === null ? "未知" : wallet.stillHolding ? "是" : "否"}</td>
                    <td>{wallet.distinctBoughtMintCount}</td>
                    <td>{fmtDate(wallet.firstActivityAt)}</td>
                    <td>{wallet.walletAgeDays === undefined ? "-" : `${wallet.walletAgeDays} 天`}</td>
                    <td><span className={`pill ${wallet.confidence}`}>{confidenceLabel(wallet.confidence)}</span></td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr><td colSpan={10} className="emptyCell">没有符合当前筛选的钱包</td></tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </main>
  );
}
