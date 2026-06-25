"use client";

import * as React from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnDef,
} from "@tanstack/react-table";
import { ChevronRight, ChevronDown, ArrowUpDown } from "lucide-react";
import type { DashboardSnapshot } from "@/lib/types";
import { ViewScroll, GridPanel, StatTile } from "./_layout";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/ui/stat";
import { ledgerRows, type LedgerRow } from "@/lib/selectors";
import { fmtUsd, fmtCents, fmtPct, fmtClock, fmtRelative, fmtDuration, fmtMs, type StatusTone } from "@/lib/format";
import { cn } from "@/lib/utils";

const col = createColumnHelper<LedgerRow>();

function hedgeBadge(r: LedgerRow): { variant: "up" | "amber" | "down" | "neutral"; label: string } {
  if (r.exact) return { variant: "up", label: "HEDGED" };
  if (r.partial) return { variant: "amber", label: "PARTIAL" };
  if (r.action === "failed") return { variant: "down", label: "FAILED" };
  if (r.action === "skipped") return { variant: "neutral", label: "SKIPPED" };
  return { variant: "neutral", label: r.action.toUpperCase() };
}

type FilterKey = "all" | "hedged" | "partial" | "failed";
const NUMERIC = new Set(["premium", "edge", "kalshi", "poly", "estPnl", "pnl", "slippage", "duration"]);

export function LedgerView({ snap }: { snap: DashboardSnapshot }) {
  const data = React.useMemo(() => ledgerRows(snap), [snap]);
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "time", desc: true }]);
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [query, setQuery] = React.useState("");

  const filtered = React.useMemo(() => {
    return data.filter((r) => {
      if (filter === "hedged" && !r.exact) return false;
      if (filter === "partial" && !r.partial) return false;
      if (filter === "failed" && r.action !== "failed" && r.action !== "skipped") return false;
      if (query && !r.market.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [data, filter, query]);

  const columns = React.useMemo<ColumnDef<LedgerRow, any>[]>(
    () => [
      col.display({
        id: "expander",
        header: () => null,
        cell: ({ row }) => (
          <button
            className="text-fg-muted transition-colors hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              row.toggleExpanded();
            }}
          >
            {row.getIsExpanded() ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ),
        size: 28,
      }),
      col.accessor("createdAt", {
        id: "time",
        header: "Time",
        cell: ({ row }) => (
          <div className="flex flex-col leading-tight">
            <span className="text-fg-secondary">{fmtClock(row.original.createdAt)}</span>
            <span className="text-[9px] text-fg-faint">{fmtRelative(row.original.createdAt)}</span>
          </div>
        ),
      }),
      col.accessor("market", {
        id: "market",
        header: "Market",
        cell: (c) => <span className="text-fg">{c.getValue()}</span>,
      }),
      col.accessor("premium", {
        id: "premium",
        header: "Premium",
        cell: (c) => <span className="text-fg-secondary">{fmtCents(c.getValue())}</span>,
      }),
      col.accessor("guaranteedProfit", {
        id: "edge",
        header: "Edge",
        cell: ({ row }) => {
          const over = row.original.guaranteedProfit - row.original.threshold;
          return (
            <div className="flex items-center justify-end gap-1.5">
              <span className="text-up">{fmtCents(row.original.guaranteedProfit)}</span>
              <span className={cn("text-[9px]", over >= 0 ? "text-up/60" : "text-down")}>{fmtCents(over, true)}</span>
            </div>
          );
        },
      }),
      col.accessor((r) => r.kalshi.fillPrice, {
        id: "kalshi",
        header: "Kalshi",
        cell: ({ row }) => (
          <LegCell price={row.original.kalshi.fillPrice} status={row.original.kalshi.status} tone="kalshi" />
        ),
      }),
      col.accessor((r) => r.polymarket.fillPrice, {
        id: "poly",
        header: "Polymkt",
        cell: ({ row }) => (
          <LegCell price={row.original.polymarket.fillPrice} status={row.original.polymarket.status} tone="poly" />
        ),
      }),
      col.accessor((r) => (r.exact ? 2 : r.partial ? 1 : 0), {
        id: "hedge",
        header: "Hedge",
        cell: ({ row }) => {
          const b = hedgeBadge(row.original);
          return <Badge variant={b.variant}>{b.label}</Badge>;
        },
      }),
      col.accessor((r) => r.estimatedDollars ?? -Infinity, {
        id: "estPnl",
        header: "Est $",
        cell: ({ row }) => {
          const v = row.original.estimatedDollars;
          if (v == null) return <span className="text-fg-faint">–</span>;
          return <span className="text-fg-muted">{fmtUsd(v, { sign: true })}</span>;
        },
      }),
      col.accessor((r) => r.realizedDollars ?? -Infinity, {
        id: "pnl",
        header: "Act $",
        cell: ({ row }) => {
          const v = row.original.realizedDollars;
          if (v == null)
            return (
              <span className="text-fg-faint" title="No venue-reported realized P&L yet (unfilled / unresolved)">
                pending
              </span>
            );
          return <span className={v >= 0 ? "text-up" : "text-down"}>{fmtUsd(v, { sign: true })}</span>;
        },
      }),
      col.accessor((r) => r.slippage ?? 0, {
        id: "slippage",
        header: "Slip",
        cell: ({ row }) => {
          const s = row.original.slippage;
          if (s == null) return <span className="text-fg-faint">–</span>;
          return <span className={s > 0.01 ? "text-amber" : "text-fg-secondary"}>{fmtCents(s, true)}</span>;
        },
      }),
      col.accessor((r) => r.durationMs ?? 0, {
        id: "duration",
        header: "Dur",
        cell: ({ row }) => (
          <span className="text-fg-secondary">
            {row.original.durationMs != null ? fmtDuration(row.original.durationMs) : "–"}
          </span>
        ),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowCanExpand: () => true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const failures = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const r of data) if (r.failureReason) map.set(r.failureReason, (map.get(r.failureReason) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const filledCount = data.filter((r) => r.action === "filled").length;
  const exactCount = data.filter((r) => r.exact).length;
  const realizedTotal = data.reduce((a, r) => a + (r.realizedDollars ?? 0), 0);

  return (
    <ViewScroll>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Signals (recent)" value={String(data.length)} tone="neutral" sub="last 100" />
        <StatTile label="Filled / Exact" value={`${filledCount} / ${exactCount}`} tone="cyan" />
        <StatTile
          label="Realized PnL"
          value={fmtUsd(realizedTotal, { sign: true })}
          tone={realizedTotal >= 0 ? "up" : "down"}
          sub="across window"
        />
        <StatTile label="Failure Types" value={String(failures.length)} tone="amber" sub={failures[0]?.[0] ?? "none"} />
      </div>

      <GridPanel title="Trade Ledger · Two-Leg Synthetic Spreads" dot="live" span={12} bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter market…"
            className="h-6 w-full min-w-0 rounded-sm border border-line bg-surface-2 px-2 font-mono text-[10px] text-fg placeholder:text-fg-faint focus:border-cyan/40 focus:outline-none sm:w-36"
          />
          <div className="flex items-center gap-0.5 rounded-sm border border-line bg-surface-2 p-0.5">
            {(["all", "hedged", "partial", "failed"] as FilterKey[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded-[3px] px-2 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors",
                  filter === f ? "bg-cyan/15 text-cyan" : "text-fg-muted hover:text-fg-secondary",
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full min-w-[880px] border-collapse text-[11px]">
            <thead className="sticky top-0 z-10 bg-surface-2/95 backdrop-blur">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-line-strong">
                  {hg.headers.map((h) => {
                    const sortable = h.column.getCanSort() && h.column.id !== "expander";
                    const numeric = NUMERIC.has(h.column.id);
                    return (
                      <th
                        key={h.id}
                        onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
                        className={cn(
                          "px-2.5 py-2 font-mono text-[9.5px] font-medium uppercase tracking-wide text-fg-muted",
                          numeric ? "text-right" : "text-left",
                          sortable && "cursor-pointer select-none hover:text-fg-secondary",
                        )}
                      >
                        <span className={cn("inline-flex items-center gap-1", numeric && "flex-row-reverse")}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sortable && h.column.getIsSorted() ? <ArrowUpDown className="size-2.5 text-cyan" /> : null}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody className="font-mono tabular-nums">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length}>
                    <Empty>No trades match</Empty>
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <React.Fragment key={row.id}>
                    <tr
                      className={cn(
                        "cursor-pointer border-b border-line/40 transition-colors hover:bg-surface-2/50",
                        row.getIsExpanded() && "bg-surface-2/40",
                        row.original.quarantined && "border-l-2 border-l-down",
                      )}
                      onClick={() => row.toggleExpanded()}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className={cn("px-2.5 py-1.5", NUMERIC.has(cell.column.id) && "text-right")}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {row.getIsExpanded() ? (
                      <tr className="bg-base/60">
                        <td colSpan={columns.length} className="p-0">
                          <ExpandedTrade row={row.original} />
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </GridPanel>

      {failures.length ? (
        <GridPanel title="Failure / Skip Breakdown" dot="stale" span={12} bodyClassName="flex flex-wrap gap-2">
          {failures.map(([reason, count]) => (
            <div
              key={reason}
              className="flex items-center gap-2 rounded-sm border border-line bg-surface-2/50 px-2.5 py-1.5"
            >
              <Badge variant="down">{count}</Badge>
              <span className="font-mono text-[11px] text-fg-secondary">{reason}</span>
            </div>
          ))}
        </GridPanel>
      ) : null}
    </ViewScroll>
  );
}

function LegCell({ price, status, tone }: { price: number | null; status: string | null; tone: "kalshi" | "poly" }) {
  if (price == null) {
    return (
      <span className={cn("text-[10px]", status === "filled" ? "text-fg-secondary" : "text-fg-faint")}>
        {status ?? "–"}
      </span>
    );
  }
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span className={cn("size-1 rounded-full", tone === "kalshi" ? "bg-kalshi" : "bg-poly")} />
      <span className="text-fg">{fmtCents(price)}</span>
    </div>
  );
}

function ExpandedTrade({ row }: { row: LedgerRow }) {
  const s = row.signal;
  const fq = s.fillQualitySnapshot;
  const tm = s.executionTimings;
  const realizedPremium = s.depthVwap ?? null;
  return (
    <div className="flex flex-col gap-3 border-y border-line/60 p-3">
      {/* Top: estimated (pre-trade) + the two venue-reported legs side-by-side */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <DetailBlock title="Estimated · pre-trade" tone="info">
          <KV k="Strikes" v={`${row.lowerStrike.toLocaleString()} / ${row.higherStrike.toLocaleString()}`} />
          <KV k="Ask Premium" v={fmtCents(row.premium)} />
          <KV k="Guaranteed Edge" v={fmtCents(row.guaranteedProfit)} tone="up" />
          <KV k="Threshold" v={fmtCents(row.threshold)} />
          <KV k="Expected Exec. Edge" v={row.expectedEdge != null ? fmtCents(row.expectedEdge) : "–"} />
          <KV k="Expected Slippage" v={fq ? fmtCents(fq.expectedSlippage) : "–"} />
          <KV k="Paired-Fill Prob" v={fq ? fmtPct(fq.pairedFillProbability) : "–"} />
          <KV
            k="Est. Combined P&L"
            v={row.estimatedDollars != null ? fmtUsd(row.estimatedDollars, { sign: true }) : "–"}
          />
        </DetailBlock>

        <VenueLeg
          title="Kalshi · venue-reported"
          tone="kalshi"
          filled={(s.kalshiFillCount ?? 0) > 0}
          contract={s.kalshiContractId}
          status={s.kalshiStatus}
          fillPrice={s.kalshiFillPrice}
          fillCount={s.kalshiFillCount}
          fillId={s.kalshiFillId}
          clientId={s.kalshiClientOrderId}
          error={s.kalshiError}
          rttMs={tm?.kalshiRttMs}
          confirmed={s.venueConfirmations?.kalshi != null}
        />

        <VenueLeg
          title="Polymarket · venue-reported"
          tone="poly"
          filled={(s.polymarketFillCount ?? 0) > 0}
          contract={s.polymarketContractId}
          status={s.polymarketStatus}
          fillPrice={s.polymarketFillPrice}
          fillCount={s.polymarketFillCount}
          fillId={s.polymarketFillId}
          clientId={s.polymarketClientOrderId}
          error={s.polymarketError}
          rttMs={tm?.polymarketRttMs}
          confirmed={s.venueConfirmations?.polymarket != null}
        />
      </div>

      {/* Bottom: combined P&L (estimated → actual) + lifecycle timeline */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <DetailBlock title="Combined P&L · estimated → actual" tone="info">
          <KV
            k="Estimated combined"
            v={row.estimatedDollars != null ? fmtUsd(row.estimatedDollars, { sign: true }) : "–"}
          />
          <KV
            k="Actual realized (net fees)"
            v={row.realizedDollars != null ? fmtUsd(row.realizedDollars, { sign: true }) : "pending"}
            tone={row.realizedDollars == null ? undefined : row.realizedDollars >= 0 ? "up" : "down"}
          />
          <KV k="Realized premium" v={realizedPremium != null ? fmtCents(realizedPremium) : "–"} />
          <KV
            k="Realized slippage"
            v={row.slippage != null ? fmtCents(row.slippage, true) : "–"}
            tone={(row.slippage ?? 0) > 0.01 ? "down" : undefined}
          />
          <KV k="Paired fill size" v={`${row.fillSize}`} />
          <KV k="Strategy" v={s.executionStrategy ?? "–"} />
        </DetailBlock>

        <div className="lg:col-span-2">
          <Lifecycle row={row} />
        </div>
      </div>
    </div>
  );
}

function VenueLeg({
  title,
  tone,
  filled,
  contract,
  status,
  fillPrice,
  fillCount,
  fillId,
  clientId,
  error,
  rttMs,
  confirmed,
}: {
  title: string;
  tone: "kalshi" | "poly";
  filled: boolean;
  contract: string;
  status?: string | null;
  fillPrice?: number | null;
  fillCount?: number | null;
  fillId?: string | null;
  clientId?: string | null;
  error?: string | null;
  rttMs?: number | null;
  confirmed: boolean;
}) {
  return (
    <DetailBlock title={title} tone={tone}>
      <KV k="Filled" v={filled ? "yes" : "no"} tone={filled ? "up" : "down"} />
      <KV k="Order status" v={status ?? "–"} />
      <KV k="Fill price" v={fillPrice != null ? fmtCents(fillPrice) : "–"} />
      <KV k="Fill size" v={`${fillCount ?? 0}`} />
      <KV k="Venue fill ID" v={fillId ?? "–"} />
      <KV k="Client order ID" v={clientId ?? "–"} />
      <KV k="Venue confirmation" v={confirmed ? "received" : "–"} tone={confirmed ? "up" : undefined} />
      <KV k="RTT" v={fmtMs(rttMs)} />
      {error ? <KV k="Venue error" v={error} tone="down" /> : null}
    </DetailBlock>
  );
}

interface LifecycleEvent {
  at: number | null;
  label: string;
  detail?: string;
  tone: "up" | "down" | "amber" | "info";
}

function Lifecycle({ row }: { row: LedgerRow }) {
  const s = row.signal;
  const kFilled = (s.kalshiFillCount ?? 0) > 0;
  const pFilled = (s.polymarketFillCount ?? 0) > 0;
  const venues =
    kFilled && pFilled
      ? "both legs filled"
      : kFilled
        ? "Kalshi filled · Polymarket not filled"
        : pFilled
          ? "Polymarket filled · Kalshi not filled"
          : "no legs filled";

  const events: LifecycleEvent[] = [
    {
      at: row.createdAt,
      label: "Signal created",
      detail: `edge ${fmtCents(row.guaranteedProfit)} vs threshold ${fmtCents(row.threshold)}`,
      tone: "info",
    },
    {
      at: row.updatedAt,
      label: row.exact
        ? "Filled — exact hedged pair"
        : row.partial
          ? "Partial fill — unhedged residual"
          : row.action === "failed"
            ? "Execution failed"
            : row.action === "skipped"
              ? "Skipped — not submitted"
              : "Filled",
      detail: row.failureReason ? `${venues} · ${row.failureReason}` : venues,
      tone: row.exact ? "up" : row.action === "failed" ? "down" : "amber",
    },
  ];
  if (s.riskQuarantinedAt) {
    events.push({
      at: Date.parse(s.riskQuarantinedAt),
      label: "Quarantined — unresolved exposure",
      detail: `${s.riskQuarantineReason ?? "unhedged"}${
        row.unresolvedExposure != null ? ` · ${fmtUsd(row.unresolvedExposure)} exposure` : ""
      }`,
      tone: "down",
    });
  }
  if (s.recoveryStatus && s.recoveryStatus !== "none") {
    events.push({
      at: null,
      label: `Recovery action — ${s.recoveryStatus.replace(/_/g, " ")}`,
      detail: s.recoveryAttempts != null ? `attempt ${s.recoveryAttempts}` : undefined,
      tone: "amber",
    });
  }
  if (s.reconciliationResolvedAt || s.reconciliationResolution) {
    events.push({
      at: s.reconciliationResolvedAt ? Date.parse(s.reconciliationResolvedAt) : null,
      label: `Reconciled — ${s.reconciliationResolution?.resolutionType ?? "resolved"}`,
      detail: s.reconciliationResolutionReason ?? s.reconciliationResolution?.notes ?? undefined,
      tone: "info",
    });
  }

  const exposureOpen = row.unresolvedExposure != null && row.unresolvedExposure > 0;
  return (
    <div className="rounded-md border border-line bg-surface/60 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.1em] text-amber">
          Lifecycle / Recovery
        </span>
        {exposureOpen ? (
          <Badge variant="down">unresolved {fmtUsd(row.unresolvedExposure)}</Badge>
        ) : row.exact ? (
          <Badge variant="up">resolved</Badge>
        ) : null}
      </div>
      <ol className="flex flex-col gap-2">
        {events.map((e, i) => (
          <li key={i} className="flex items-start gap-2">
            <span
              className={cn(
                "mt-1 size-1.5 shrink-0 rounded-full",
                e.tone === "up" ? "bg-up" : e.tone === "down" ? "bg-down" : e.tone === "amber" ? "bg-amber" : "bg-cyan",
              )}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-fg-secondary">{e.label}</span>
                <span className="shrink-0 font-mono text-[9px] text-fg-faint">
                  {e.at != null && Number.isFinite(e.at) ? fmtClock(e.at) : "—"}
                </span>
              </div>
              {e.detail ? <span className="truncate font-mono text-[10px] text-fg-muted">{e.detail}</span> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DetailBlock({
  title,
  tone,
  children,
}: {
  title: string;
  tone: StatusTone | "kalshi" | "poly";
  children: React.ReactNode;
}) {
  const accent = tone === "kalshi" ? "text-kalshi" : tone === "poly" ? "text-poly" : "text-cyan";
  return (
    <div className="rounded-md border border-line bg-surface/60 p-2.5">
      <div className={cn("mb-2 font-mono text-[9.5px] font-medium uppercase tracking-[0.1em]", accent)}>{title}</div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function KV({ k, v, tone }: { k: string; v: React.ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-fg-muted">{k}</span>
      <span
        className={cn(
          "max-w-[60%] truncate font-mono text-[10.5px] tabular-nums",
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-fg-secondary",
        )}
      >
        {v}
      </span>
    </div>
  );
}
