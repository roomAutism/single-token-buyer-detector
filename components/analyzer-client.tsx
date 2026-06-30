"use client";

import { ChevronDown, ChevronRight, Copy, Download, ExternalLink, Search, Square } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
import type {
  AnalyzeResponse,
  AnalyzeWalletResponse,
  BuyerLimit,
  HistoryRange,
  TokenBuyer,
  WalletAnalysis
} from "@/lib/types";

type SortKey =
  | "default"
  | "firstBuyAt"
  | "totalBuyAmountSol"
  | "historicalSwappedNonBaseTokenCount"
  | "everHeldNonBaseTokenCount"
  | "currentHeldNonBaseTokenCount"
  | "walletAgeDays"
  | "analysisStatus"
  | "strictSingleToken";
type SortDirection = "asc" | "desc" | null;

function fmtDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function fmtNumber(value: number, digits = 4) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function yesNo(value: boolean | null) {
  if (value === null) return "未知";
  return value ? "是" : "否";
}

function statusLabel(wallet: WalletAnalysis) {
  if (wallet.analysisStatus === "pending") return "等待中";
  if (wallet.analysisStatus === "analyzing") return "分析中";
  if (wallet.analysisStatus === "retrying") return "限流重试";
  if (wallet.analysisStatus === "rate_limited") return "限流失败";
  if (wallet.analysisStatus === "completed") return wallet.strictSingleToken ? "严格单币" : "多币/非单币";
  if (wallet.analysisStatus === "data_insufficient") return "数据不足";
  if (wallet.analysisStatus === "analysis_error") return "分析失败";
  return "覆盖受限";
}

function statusClass(wallet: WalletAnalysis) {
  if (wallet.analysisStatus === "completed") return wallet.strictSingleToken ? "complete" : "partial";
  return wallet.analysisStatus;
}

function toCsv(rows: WalletAnalysis[]) {
  const header = [
    "wallet",
    "historicalSwappedNonBaseTokenCount",
    "everHeldNonBaseTokenCount",
    "currentHeldNonBaseTokenCount",
    "currentlyHolding",
    "soldOut",
    "analysisStatus",
    "failureReason",
    "rateLimitRetryCount",
    "firstBuyAt",
    "totalBuySol",
    "walletAgeDays",
    "strictSingleToken",
    "tradedCurrentToken",
    "firstBuyAmountSol",
    "scanTransactionCount",
    "scanPageCount",
    "scanStartedAt",
    "scanEndedAt"
  ];
  const body = rows.map((row) =>
    header
      .map((key) => {
        const value =
          key === "failureReason" ? row.reason :
          key === "rateLimitRetryCount" ? row.heliusRetryCount :
          key === "totalBuySol" ? row.totalBuyAmountSol :
          row[key as keyof WalletAnalysis];
        return `"${String(Array.isArray(value) ? value.join("|") : value ?? "").replaceAll('"', '""')}"`;
      })
      .join(",")
  );
  return [header.join(","), ...body].join("\n");
}

function summarizeRows(rows: WalletAnalysis[]) {
  const completedWallets = rows.filter((row) => row.analysisStatus === "completed").length;
  const strictSingleTokenWallets = rows.filter((row) => row.strictSingleToken).length;
  return {
    totalBuyers: rows.length,
    completedWallets,
    strictSingleTokenWallets,
    multiTokenWallets: rows.filter((row) => row.analysisStatus === "completed" && !row.strictSingleToken).length,
    insufficientWallets: rows.filter((row) => row.analysisStatus === "data_insufficient").length,
    analysisErrorWallets: rows.filter((row) => row.analysisStatus === "analysis_error").length,
    coverageLimitedWallets: rows.filter((row) => row.analysisStatus === "coverage_limited").length,
    singleTokenRatio: completedWallets === 0 ? 0 : strictSingleTokenWallets / completedWallets
  };
}

const statusPriority: Record<string, number> = {
  completed: 0,
  retrying: 1,
  rate_limited: 2,
  coverage_limited: 3,
  data_insufficient: 4,
  analysis_error: 5,
  pending: 6,
  analyzing: 7
};

function failedWallet(base: WalletAnalysis, message: string): WalletAnalysis {
  return {
    ...base,
    analysisStatus: message === "Helius rate limited after 3 retries" ? "rate_limited" : "analysis_error",
    status: message === "Helius rate limited after 3 retries" ? "rate_limited" : "analysis_error",
    reason: message
  };
}

function markStatus(base: WalletAnalysis, status: "pending" | "analyzing" | "retrying"): WalletAnalysis {
  return {
    ...base,
    analysisStatus: status,
    status
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`API returned non-JSON response (${response.status}): ${raw.slice(0, 300)}`);
  }
}

function WalletDetails({ wallet }: { wallet: WalletAnalysis }) {
  return (
    <div className="detailsBox">
      <div className="detailsGrid">
        <div><span>analysis_status</span><strong>{wallet.analysisStatus}</strong></div>
        <div><span>strict_single_token</span><strong>{String(wallet.strictSingleToken)}</strong></div>
        <div><span>historical_swapped_count</span><strong>{wallet.historicalSwappedNonBaseTokenCount}</strong></div>
        <div><span>ever_held_count</span><strong>{wallet.everHeldNonBaseTokenCount}</strong></div>
        <div><span>current_held_count</span><strong>{wallet.currentHeldNonBaseTokenCount}</strong></div>
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
        <span>历史参与 Token 列表</span>
        {wallet.historicalSwappedTokens.length ? wallet.historicalSwappedTokens.map((token) => (
          <div className="tokenRow" key={token.mint}>
            <code>{token.mint}</code>
            <span>{token.isCurrentToken ? "当前 Token" : "其他 Token"}</span>
            <span>首次 {fmtDate(token.firstSeenAt)}</span>
            <span>最后 {fmtDate(token.lastSeenAt)}</span>
            <span>买入 {token.buyCount}</span>
            <span>卖出 {token.sellCount}</span>
          </div>
        )) : <em>未发现</em>}
      </div>
      <div className="mintList">
        <span>累计曾持有 Token 列表</span>
        {wallet.everHeldTokens.length ? wallet.everHeldTokens.map((token) => (
          <div className="tokenRow" key={token.mint}>
            <code>{token.mint}</code>
            <span>首次持有 {fmtDate(token.firstHeldAt)}</span>
            <span>当前余额 {yesNo(token.currentlyHeld)}</span>
            <span>获得方式 {token.acquiredBy}</span>
            <span>{token.excludedAsDustOrAirdrop ? "疑似空投/dust 排除" : "计入"}</span>
          </div>
        )) : <em>未发现</em>}
      </div>
      <div className="mintList">
        <span>当前持有 Token 列表</span>
        {wallet.currentHeldTokens.length ? wallet.currentHeldTokens.map((token) => (
          <div className="tokenRow" key={token.mint}>
            <code>{token.mint}</code>
            <span>数量 {token.amount}</span>
            <span>{token.isCurrentToken ? "当前 Token" : "其他 Token"}</span>
            <span>{token.isBaseAsset ? "基础资产" : "非基础资产"}</span>
          </div>
        )) : <em>未发现</em>}
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
  const [buyerLimit, setBuyerLimit] = useState<BuyerLimit>(10);
  const [historyRange, setHistoryRange] = useState<HistoryRange>("recent20");
  const [onlySingle, setOnlySingle] = useState(true);
  const [onlyHolding, setOnlyHolding] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [everHeldFilter, setEverHeldFilter] = useState("all");
  const [currentHeldFilter, setCurrentHeldFilter] = useState("all");
  const [walletAgeFilter, setWalletAgeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [everHeldMin, setEverHeldMin] = useState("");
  const [everHeldMax, setEverHeldMax] = useState("");
  const [ageMin, setAgeMin] = useState("");
  const [ageMax, setAgeMax] = useState("");
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);
  const [data, setData] = useState<AnalyzeResponse | null>(null);
  const [debugResult, setDebugResult] = useState<WalletAnalysis | null>(null);
  const [debugBuyer, setDebugBuyer] = useState<{ isInBuyerList: boolean; buyerRank?: number; buyer?: TokenBuyer } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [retryingCount, setRetryingCount] = useState(0);
  const stopRef = useRef(false);
  const startTimesRef = useRef<number[]>([]);
  const retryQueueRef = useRef<WalletAnalysis[]>([]);
  const retryAttemptsRef = useRef<Map<string, number>>(new Map());
  const retryRunningRef = useRef(false);

  function updateWallet(wallet: WalletAnalysis) {
    setData((current) => {
      if (!current) return current;
      const wallets = current.wallets.map((row) => (row.wallet === wallet.wallet ? wallet : row));
      return { ...current, wallets, summary: summarizeRows(wallets) };
    });
  }

  function isHelius429(wallet: WalletAnalysis) {
    return wallet.heliusStatusCodes.includes(429) || wallet.reason?.toLowerCase().includes("429");
  }

  async function throttleWalletRequest() {
    const now = Date.now();
    startTimesRef.current = startTimesRef.current.filter((time) => now - time < 1000);
    if (startTimesRef.current.length >= 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000 - (now - startTimesRef.current[0]) + 25));
    }
    startTimesRef.current.push(Date.now());
  }

  function scanLimits() {
    if (historyRange === "recent20") return { maxPages: 1, maxTransactions: 20 };
    if (historyRange === "recent100") return { maxPages: 1, maxTransactions: 100 };
    return { maxPages: 5, maxTransactions: 500 };
  }

  async function analyzeOneWallet(base: WalletAnalysis): Promise<WalletAnalysis> {
    await throttleWalletRequest();
    const { maxPages, maxTransactions } = scanLimits();
    const response = await fetch("/api/analyze-wallet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tokenCa: tokenMint,
        wallet: base.wallet,
        historyMode: historyRange,
        maxPages,
        maxTransactions,
        buyer: {
          wallet: base.wallet,
          firstBuyAt: base.firstBuyAt,
          firstBuyAmountSol: base.firstBuyAmountSol,
          totalBuyAmountSol: base.totalBuyAmountSol
        }
      })
    });
    const payload = await parseJsonResponse<AnalyzeWalletResponse>(response);

    if (!response.ok || !payload.ok) {
      return failedWallet(base, payload.ok ? `Request failed: ${response.status}` : payload.error || payload.reason);
    }

    return payload.wallet;
  }

  function retryDelay(wallet: WalletAnalysis, attempt: number) {
    if (wallet.retryAfterMs && wallet.retryAfterMs > 0) return wallet.retryAfterMs;
    return [2000, 5000, 10000][Math.max(0, attempt - 1)] ?? 10000;
  }

  function enqueueRateLimitedWallet(wallet: WalletAnalysis, resetAttempts = false) {
    if (resetAttempts) retryAttemptsRef.current.set(wallet.wallet, 0);
    const attempts = retryAttemptsRef.current.get(wallet.wallet) ?? 0;
    if (attempts >= 3) {
      updateWallet(failedWallet({ ...wallet, heliusStatusCodes: [...new Set([...wallet.heliusStatusCodes, 429])] }, "Helius rate limited after 3 retries"));
      return;
    }

    if (!retryQueueRef.current.some((item) => item.wallet === wallet.wallet)) {
      retryQueueRef.current.push(wallet);
    }
    setRetryingCount(retryQueueRef.current.length);
    updateWallet({ ...markStatus(wallet, "retrying"), reason: `Helius rate limited, retry ${attempts + 1}/3` });
    void processRetryQueue();
  }

  async function processRetryQueue() {
    if (retryRunningRef.current) return;
    retryRunningRef.current = true;

    while (!stopRef.current && retryQueueRef.current.length > 0) {
      const base = retryQueueRef.current.shift();
      setRetryingCount(retryQueueRef.current.length + (base ? 1 : 0));
      if (!base) continue;

      const nextAttempt = (retryAttemptsRef.current.get(base.wallet) ?? 0) + 1;
      retryAttemptsRef.current.set(base.wallet, nextAttempt);
      updateWallet({ ...markStatus(base, "retrying"), reason: `Helius rate limited, retry ${nextAttempt}/3` });
      await new Promise((resolve) => setTimeout(resolve, retryDelay(base, nextAttempt)));

      try {
        const result = await analyzeOneWallet(base);
        if (isHelius429(result)) {
          if (nextAttempt >= 3) {
            updateWallet(failedWallet(result, "Helius rate limited after 3 retries"));
          } else {
            enqueueRateLimitedWallet(result);
          }
        } else {
          retryAttemptsRef.current.delete(base.wallet);
          updateWallet(result);
        }
      } catch (err) {
        const failed = failedWallet(base, err instanceof Error ? err.message : "wallet retry failed");
        if (isHelius429(failed) && nextAttempt < 3) {
          enqueueRateLimitedWallet(failed);
        } else {
          updateWallet(nextAttempt >= 3 ? failedWallet(base, "Helius rate limited after 3 retries") : failed);
        }
      }
      setRetryingCount(retryQueueRef.current.length);
    }

    retryRunningRef.current = false;
    setRetryingCount(retryQueueRef.current.length);
  }

  async function runWalletQueue(wallets: WalletAnalysis[]) {
    let nextIndex = 0;

    async function worker() {
      while (!stopRef.current && nextIndex < wallets.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const base = wallets[currentIndex];
        updateWallet(markStatus(base, "analyzing"));
        try {
          const result = await analyzeOneWallet(base);
          if (isHelius429(result)) {
            enqueueRateLimitedWallet(result, true);
          } else {
            updateWallet(result);
          }
        } catch (err) {
          updateWallet(failedWallet(base, err instanceof Error ? err.message : "wallet analysis failed"));
        }
      }
    }

    await Promise.all([worker(), worker()]);
  }

  async function analyzeDebugWallet(responseData: AnalyzeResponse) {
    if (!debugWallet.trim()) {
      setDebugResult(null);
      setDebugBuyer(null);
      return;
    }

    const buyerIndex = responseData.wallets.findIndex((wallet) => wallet.wallet === debugWallet.trim());
    const matched = buyerIndex >= 0 ? responseData.wallets[buyerIndex] : null;
    setDebugBuyer({
      isInBuyerList: !!matched,
      buyerRank: matched ? buyerIndex + 1 : undefined,
      buyer: matched
        ? {
            wallet: matched.wallet,
            firstBuyAt: matched.firstBuyAt,
            firstBuyAmountSol: matched.firstBuyAmountSol,
            totalBuyAmountSol: matched.totalBuyAmountSol
          }
        : undefined
    });

    const base = matched ?? markStatus({
      wallet: debugWallet.trim(),
      firstBuyAmountSol: 0,
      totalBuyAmountSol: 0,
      analysisStatus: "pending",
      status: "pending",
      strictSingleToken: false,
      tradedCurrentToken: false,
      distinctBoughtMints: [],
      distinctBoughtMintCount: 0,
      nonBaseTokenMints: [],
      uniqueNonBaseTokenCount: 0,
      historicalSwappedNonBaseTokenCount: 0,
      everHeldNonBaseTokenCount: 0,
      currentHeldNonBaseTokenCount: 0,
      historicalSwappedTokens: [],
      everHeldTokens: [],
      currentHeldTokens: [],
      stillHolding: null,
      currentlyHolding: null,
      soldOut: null,
      scanTransactionCount: 0,
      scanPageCount: 0,
      heliusStatusCodes: [],
      heliusRetryCount: 0,
      debugEvents: []
    }, "pending");

    setDebugResult(markStatus(base, "analyzing"));
    try {
      const result = await analyzeOneWallet(base);
      setDebugResult(isHelius429(result) ? { ...markStatus(result, "retrying"), reason: "Helius rate limited" } : result);
    } catch (err) {
      setDebugResult(failedWallet(base, err instanceof Error ? err.message : "debug wallet analysis failed"));
    }
  }

  async function analyze() {
    setError("");
    setLoading(true);
    setStopped(false);
    stopRef.current = false;
    startTimesRef.current = [];
    retryQueueRef.current = [];
    retryAttemptsRef.current = new Map();
    retryRunningRef.current = false;
    setRetryingCount(0);
    setData(null);
    setDebugResult(null);
    setDebugBuyer(null);
    setExpandedWallet(null);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenMint, buyerLimit, historyRange })
      });
      const payload = await parseJsonResponse<AnalyzeResponse & { error?: string; message?: string }>(response);
      if (!response.ok) throw new Error(payload.error || payload.message || `Request failed: ${response.status}`);

      setData(payload);
      await Promise.all([analyzeDebugWallet(payload), runWalletQueue(payload.wallets)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "分析失败");
    } finally {
      setLoading(false);
    }
  }

  function stopAnalysis() {
    stopRef.current = true;
    retryQueueRef.current = [];
    setRetryingCount(0);
    setStopped(true);
    setLoading(false);
  }

  function retryAllRateLimitedWallets() {
    if (!data) return;
    setStopped(false);
    stopRef.current = false;
    for (const wallet of data.wallets) {
      if (isHelius429(wallet) || wallet.reason === "Helius rate limited after 3 retries") {
        enqueueRateLimitedWallet(wallet, true);
      }
    }
  }

  const summary = useMemo(() => summarizeRows(data?.wallets ?? []), [data]);
  function inEverHeldRange(wallet: WalletAnalysis) {
    const value = wallet.everHeldNonBaseTokenCount;
    if (everHeldFilter === "one") return value === 1;
    if (everHeldFilter === "1-3") return value >= 1 && value <= 3;
    if (everHeldFilter === "4-10") return value >= 4 && value <= 10;
    if (everHeldFilter === "gt10") return value > 10;
    if (everHeldFilter === "custom") {
      const min = everHeldMin === "" ? -Infinity : Number(everHeldMin);
      const max = everHeldMax === "" ? Infinity : Number(everHeldMax);
      return value >= min && value <= max;
    }
    return true;
  }

  function inCurrentHeldRange(wallet: WalletAnalysis) {
    const value = wallet.currentHeldNonBaseTokenCount;
    if (currentHeldFilter === "0") return value === 0;
    if (currentHeldFilter === "1") return value === 1;
    if (currentHeldFilter === "2-5") return value >= 2 && value <= 5;
    if (currentHeldFilter === "gt5") return value > 5;
    return true;
  }

  function inAgeRange(wallet: WalletAnalysis) {
    const value = wallet.walletAgeDays;
    if (value === undefined) return walletAgeFilter === "all";
    if (walletAgeFilter === "lt1") return value < 1;
    if (walletAgeFilter === "lt7") return value < 7;
    if (walletAgeFilter === "lt30") return value < 30;
    if (walletAgeFilter === "custom") {
      const min = ageMin === "" ? -Infinity : Number(ageMin);
      const max = ageMax === "" ? Infinity : Number(ageMax);
      return value >= min && value <= max;
    }
    return true;
  }

  function defaultCompare(a: WalletAnalysis, b: WalletAnalysis) {
    if (onlySingle) {
      return (
        Number(b.strictSingleToken) - Number(a.strictSingleToken) ||
        a.everHeldNonBaseTokenCount - b.everHeldNonBaseTokenCount ||
        new Date(a.firstBuyAt ?? 0).getTime() - new Date(b.firstBuyAt ?? 0).getTime()
      );
    }
    return (
      (statusPriority[a.analysisStatus] ?? 99) - (statusPriority[b.analysisStatus] ?? 99) ||
      a.historicalSwappedNonBaseTokenCount - b.historicalSwappedNonBaseTokenCount ||
      a.everHeldNonBaseTokenCount - b.everHeldNonBaseTokenCount ||
      new Date(a.firstBuyAt ?? 0).getTime() - new Date(b.firstBuyAt ?? 0).getTime()
    );
  }

  function sortCompare(a: WalletAnalysis, b: WalletAnalysis) {
    if (sortKey === "default" || !sortDirection) return defaultCompare(a, b);
    const direction = sortDirection === "asc" ? 1 : -1;
    if (sortKey === "firstBuyAt") {
      return direction * (new Date(a.firstBuyAt ?? 0).getTime() - new Date(b.firstBuyAt ?? 0).getTime());
    }
    if (sortKey === "totalBuyAmountSol") return direction * (a.totalBuyAmountSol - b.totalBuyAmountSol);
    if (sortKey === "walletAgeDays") return direction * ((a.walletAgeDays ?? -1) - (b.walletAgeDays ?? -1));
    if (sortKey === "analysisStatus") {
      return direction * ((statusPriority[a.analysisStatus] ?? 99) - (statusPriority[b.analysisStatus] ?? 99));
    }
    if (sortKey === "strictSingleToken") {
      return (
        direction * (Number(a.strictSingleToken) - Number(b.strictSingleToken)) ||
        a.everHeldNonBaseTokenCount - b.everHeldNonBaseTokenCount ||
        new Date(a.firstBuyAt ?? 0).getTime() - new Date(b.firstBuyAt ?? 0).getTime()
      );
    }
    return direction * (Number(a[sortKey]) - Number(b[sortKey]));
  }

  function cycleSort(key: SortKey, defaultDirection: Exclude<SortDirection, null> = "desc") {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDirection(defaultDirection);
      return;
    }
    if (sortDirection === defaultDirection) {
      setSortDirection(defaultDirection === "desc" ? "asc" : "desc");
      return;
    }
    setSortKey("default");
    setSortDirection(null);
  }

  function sortArrow(key: SortKey) {
    if (sortKey !== key || !sortDirection) return "";
    return sortDirection === "asc" ? " ↑" : " ↓";
  }

  const rows = useMemo(() => {
    const source = data?.wallets ?? [];
    return source
      .filter((wallet) => (onlySingle ? wallet.analysisStatus === "completed" && wallet.strictSingleToken : true))
      .filter((wallet) => (onlyHolding ? wallet.currentlyHolding === true : true))
      .filter(inEverHeldRange)
      .filter(inCurrentHeldRange)
      .filter(inAgeRange)
      .filter((wallet) => (statusFilter === "all" ? true : wallet.analysisStatus === statusFilter))
      .sort(sortCompare);
  }, [data, onlyHolding, onlySingle, sortKey, sortDirection, everHeldFilter, currentHeldFilter, walletAgeFilter, statusFilter, everHeldMin, everHeldMax, ageMin, ageMax]);

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
            <option value={10}>前 10 名买家</option>
            <option value={100}>前 100 名买家（高级慢速）</option>
            <option value={300}>前 300 名买家（高级慢速）</option>
            <option value={500}>前 500 名买家（高级慢速）</option>
          </select>
        </label>
        <label className="field">
          <span>历史扫描</span>
          <select value={historyRange} onChange={(event) => setHistoryRange(event.target.value as HistoryRange)}>
            <option value="recent20">最近 20 笔</option>
            <option value="recent100">最近 100 笔</option>
            <option value="full">全历史（高级慢速，分批）</option>
          </select>
        </label>
        <button className="primaryButton" onClick={loading ? stopAnalysis : analyze} disabled={!loading && !tokenMint.trim()}>
          {loading ? <Square size={17} /> : <Search size={17} />}
          {loading ? "停止分析" : "开始分析"}
        </button>
      </section>

      {historyRange === "full" || buyerLimit > 10 ? (
        <section className="panel hintPanel">
          高级慢速模式会逐钱包分批分析，最多 2 个并发；页面会持续显示部分结果。
        </section>
      ) : null}

      {loading ? (
        <section className="panel progressPanel">
          <div className="progressBar"><span /></div>
          <p>已获取买家后正在逐钱包分析。每个钱包请求独立运行，单次请求不会等待整批完成。</p>
        </section>
      ) : null}

      {stopped ? <section className="panel hintPanel">分析已停止，已完成的钱包结果保留在表格中。</section> : null}
      {retryingCount > 0 ? <section className="panel hintPanel">限流重试中 {retryingCount} 个钱包。</section> : null}
      {error ? <section className="errorPanel">{error}</section> : null}

      {data ? (
        <>
          <section className="metrics">
            <div><span>原始买家数</span><strong>{summary.totalBuyers}</strong></div>
            <div><span>已完成分析</span><strong>{summary.completedWallets}</strong></div>
            <div><span>严格单币钱包</span><strong>{summary.strictSingleTokenWallets}</strong></div>
            <div><span>多币钱包</span><strong>{summary.multiTokenWallets}</strong></div>
            <div><span>数据不足</span><strong>{summary.insufficientWallets}</strong></div>
            <div><span>覆盖受限</span><strong>{summary.coverageLimitedWallets}</strong></div>
            <div><span>分析失败</span><strong>{summary.analysisErrorWallets}</strong></div>
            <div><span>单币占比</span><strong>{fmtNumber(summary.singleTokenRatio * 100, 2)}%</strong></div>
          </section>

          {debugResult && debugBuyer ? (
            <section className="panel debugPanel">
              <div className="debugHeader">
                <div><span>指定钱包调试</span><strong>{shortAddress(debugResult.wallet)}</strong></div>
                <div><span>是否在买家列表</span><strong>{debugBuyer.isInBuyerList ? `是，第 ${debugBuyer.buyerRank} 名` : "否"}</strong></div>
                <div><span>首次买入 / 累计 SOL</span><strong>{fmtDate(debugBuyer.buyer?.firstBuyAt)} / {fmtNumber(debugBuyer.buyer?.totalBuyAmountSol ?? 0)}</strong></div>
              </div>
              <WalletDetails wallet={debugResult} />
            </section>
          ) : null}

          <section className="panel controls">
            <label><input type="checkbox" checked={onlySingle} onChange={(event) => setOnlySingle(event.target.checked)} /> 仅严格单币</label>
            <label><input type="checkbox" checked={onlyHolding} onChange={(event) => setOnlyHolding(event.target.checked)} /> 仅仍持仓</label>
            <button className="secondaryButton" onClick={retryAllRateLimitedWallets} disabled={!data.wallets.some((wallet) => isHelius429(wallet))}>
              重试所有限流失败钱包
            </button>
            <select value={`${sortKey}:${sortDirection ?? "default"}`} onChange={(event) => {
              const [key, direction] = event.target.value.split(":") as [SortKey, string];
              setSortKey(key);
              setSortDirection(direction === "default" ? null : direction as SortDirection);
            }}>
              <option value="default:default">默认排序</option>
              <option value="firstBuyAt:asc">首次买入最早优先</option>
              <option value="firstBuyAt:desc">首次买入最近优先</option>
              <option value="totalBuyAmountSol:desc">累计 SOL 高到低</option>
              <option value="totalBuyAmountSol:asc">累计 SOL 低到高</option>
              <option value="historicalSwappedNonBaseTokenCount:asc">历史参与少到多</option>
              <option value="historicalSwappedNonBaseTokenCount:desc">历史参与多到少</option>
              <option value="everHeldNonBaseTokenCount:asc">曾持有少到多</option>
              <option value="everHeldNonBaseTokenCount:desc">曾持有多到少</option>
              <option value="currentHeldNonBaseTokenCount:asc">当前持有少到多</option>
              <option value="currentHeldNonBaseTokenCount:desc">当前持有多到少</option>
              <option value="walletAgeDays:asc">新钱包优先</option>
              <option value="walletAgeDays:desc">老钱包优先</option>
              <option value="analysisStatus:asc">分析状态优先</option>
              <option value="strictSingleToken:desc">严格单币优先</option>
            </select>
            <select value={everHeldFilter} onChange={(event) => setEverHeldFilter(event.target.value)}>
              <option value="all">累计曾持有：全部</option>
              <option value="one">仅 1 种</option>
              <option value="1-3">1-3 种</option>
              <option value="4-10">4-10 种</option>
              <option value="gt10">大于 10 种</option>
              <option value="custom">自定义</option>
            </select>
            {everHeldFilter === "custom" ? <>
              <input className="smallInput" value={everHeldMin} onChange={(event) => setEverHeldMin(event.target.value)} placeholder="曾持有最小" />
              <input className="smallInput" value={everHeldMax} onChange={(event) => setEverHeldMax(event.target.value)} placeholder="曾持有最大" />
            </> : null}
            <select value={currentHeldFilter} onChange={(event) => setCurrentHeldFilter(event.target.value)}>
              <option value="all">当前持有：全部</option>
              <option value="0">0</option>
              <option value="1">1</option>
              <option value="2-5">2-5</option>
              <option value="gt5">大于 5</option>
            </select>
            <select value={walletAgeFilter} onChange={(event) => setWalletAgeFilter(event.target.value)}>
              <option value="all">钱包年龄：全部</option>
              <option value="lt1">小于 1 天</option>
              <option value="lt7">小于 7 天</option>
              <option value="lt30">小于 30 天</option>
              <option value="custom">自定义</option>
            </select>
            {walletAgeFilter === "custom" ? <>
              <input className="smallInput" value={ageMin} onChange={(event) => setAgeMin(event.target.value)} placeholder="年龄最小" />
              <input className="smallInput" value={ageMax} onChange={(event) => setAgeMax(event.target.value)} placeholder="年龄最大" />
            </> : null}
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">状态：全部</option>
              <option value="completed">completed</option>
              <option value="retrying">retrying</option>
              <option value="rate_limited">rate_limited</option>
              <option value="coverage_limited">coverage_limited</option>
              <option value="data_insufficient">data_insufficient</option>
              <option value="analysis_error">analysis_error</option>
              <option value="pending">pending</option>
            </select>
          </section>

          <section className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>详情</th>
                  <th>钱包</th>
                  <th>链接</th>
                  <th><button className="thButton" onClick={() => cycleSort("analysisStatus", "asc")}>分析状态{sortArrow("analysisStatus")}</button></th>
                  <th><button className="thButton" onClick={() => cycleSort("firstBuyAt", "asc")}>首次买入{sortArrow("firstBuyAt")}</button></th>
                  <th><button className="thButton" onClick={() => cycleSort("totalBuyAmountSol", "desc")}>累计 SOL{sortArrow("totalBuyAmountSol")}</button></th>
                  <th><button className="thButton" onClick={() => cycleSort("historicalSwappedNonBaseTokenCount", "asc")}>历史参与币种数{sortArrow("historicalSwappedNonBaseTokenCount")}</button></th>
                  <th><button className="thButton" onClick={() => cycleSort("everHeldNonBaseTokenCount", "asc")}>累计曾持有币种数{sortArrow("everHeldNonBaseTokenCount")}</button></th>
                  <th><button className="thButton" onClick={() => cycleSort("currentHeldNonBaseTokenCount", "asc")}>当前持有币种数{sortArrow("currentHeldNonBaseTokenCount")}</button></th>
                  <th>当前持有</th>
                  <th>是否卖光</th>
                  <th>扫描笔数</th>
                  <th>扫描页数</th>
                  <th><button className="thButton" onClick={() => cycleSort("walletAgeDays", "asc")}>钱包年龄{sortArrow("walletAgeDays")}</button></th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((wallet) => (
                  <Fragment key={wallet.wallet}>
                    <tr>
                      <td>
                        <button className="miniButton" onClick={() => setExpandedWallet(expandedWallet === wallet.wallet ? null : wallet.wallet)} title="展开详情">
                          {expandedWallet === wallet.wallet ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="walletCell">
                        <code>{shortAddress(wallet.wallet)}</code>
                        <button className="miniButton" onClick={() => navigator.clipboard.writeText(wallet.wallet)} title="复制地址"><Copy size={14} /></button>
                      </td>
                      <td className="linkCell">
                        <a href={`https://solscan.io/account/${wallet.wallet}`} target="_blank" rel="noreferrer" title="Solscan"><ExternalLink size={15} /></a>
                        <a href={`https://gmgn.ai/sol/address/${wallet.wallet}`} target="_blank" rel="noreferrer" title="GMGN">GMGN</a>
                      </td>
                      <td><span className={`pill ${statusClass(wallet)}`}>{statusLabel(wallet)}</span></td>
                      <td>{fmtDate(wallet.firstBuyAt)}</td>
                      <td>{fmtNumber(wallet.totalBuyAmountSol)}</td>
                      <td>{wallet.historicalSwappedNonBaseTokenCount}</td>
                      <td>{wallet.everHeldNonBaseTokenCount}</td>
                      <td>{wallet.currentHeldNonBaseTokenCount}</td>
                      <td>{yesNo(wallet.currentlyHolding)}</td>
                      <td>{yesNo(wallet.soldOut)}</td>
                      <td>{wallet.scanTransactionCount}</td>
                      <td>{wallet.scanPageCount}</td>
                      <td>{wallet.walletAgeDays === undefined ? "-" : `${wallet.walletAgeDays} 天`}</td>
                      <td>{wallet.reason ?? "-"}</td>
                    </tr>
                    {expandedWallet === wallet.wallet ? (
                      <tr>
                        <td colSpan={15}><WalletDetails wallet={wallet} /></td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
                {rows.length === 0 ? <tr><td colSpan={15} className="emptyCell">没有符合当前筛选的钱包</td></tr> : null}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </main>
  );
}
