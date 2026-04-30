"use client";

import React from "react";
import { useEffect, useState } from "react";
import type { ArbCandidate, BinaryContract, DashboardLogEntry, DashboardSignal, DashboardSnapshot } from "../../src/types";
import {
  formatCents,
  formatCountdown,
  formatDollars,
  isContractStale,
  sortCandidatesForBlotter,
  sortContractsForBook,
  staleContractCount,
  venueStatus,
} from "../lib/dashboard-view-model";

type StreamState = "connecting" | "live" | "degraded";

function VenueBadge({ venue }: { venue: string }) {
  return <span className={`venue venue-${venue}`}>{venue.toUpperCase()}</span>;
}

function StatusPill({ label, state }: { label: string; state: "live" | "stale" | "empty" | "warn" | "off" }) {
  return <span className={`status-pill status-${state}`}>{label}</span>;
}

function BookTable({ title, venue, contracts, snapshot }: {
  title: string;
  venue: "kalshi" | "polymarket";
  contracts: BinaryContract[];
  snapshot: DashboardSnapshot;
}) {
  return (
    <section className="panel book-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">{venue}</p>
          <h2>{title}</h2>
        </div>
        <StatusPill label={venueStatus(snapshot, venue)} state={venueStatus(snapshot, venue)} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Expiry</th>
              <th>Strike</th>
              <th>Yes Bid</th>
              <th>Yes Ask</th>
              <th>No Bid</th>
              <th>No Ask</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {sortContractsForBook(contracts).slice(0, 24).map((contract) => (
              <tr key={contract.contractId} className={isContractStale(contract, snapshot) ? "row-stale" : ""}>
                <td>{formatCountdown(contract.expiryMs, snapshot.generatedAt)}</td>
                <td>{formatDollars(contract.strike)}</td>
                <td>{formatCents(contract.yesBid)}</td>
                <td>{formatCents(contract.yesAsk)}</td>
                <td>{formatCents(contract.noBid)}</td>
                <td>{formatCents(contract.noAsk)}</td>
                <td>{Math.max(0, Math.round((snapshot.generatedAt - contract.updatedAt) / 1000))}s</td>
              </tr>
            ))}
            {contracts.length === 0 ? <tr><td colSpan={7} className="empty-cell">No live contracts discovered.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CandidateRow({ candidate, now }: { candidate: ArbCandidate; now: number }) {
  return (
    <tr>
      <td>{formatCountdown(candidate.expiryMs, now)}</td>
      <td><VenueBadge venue={candidate.lower.venue} /> {candidate.lower.direction.toUpperCase()}</td>
      <td>{formatDollars(candidate.lower.strike)}</td>
      <td>{formatCents(candidate.lower.ask)}</td>
      <td><VenueBadge venue={candidate.higher.venue} /> {candidate.higher.direction.toUpperCase()}</td>
      <td>{formatDollars(candidate.higher.strike)}</td>
      <td>{formatCents(candidate.higher.ask)}</td>
      <td>{formatCents(candidate.premium)}</td>
      <td className="profit">{formatCents(candidate.guaranteedProfit)}</td>
      <td>{formatCents(candidate.overlapProfit)}</td>
    </tr>
  );
}

function OpportunityBlotter({ snapshot }: { snapshot: DashboardSnapshot }) {
  const candidates = sortCandidatesForBlotter(snapshot.liveCandidates);
  return (
    <section className="panel blotter-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">live structural edge</p>
          <h2>Opportunity Blotter</h2>
        </div>
        <span className="big-number">{candidates.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Expiry</th>
              <th>Lower Leg</th>
              <th>Lower Strike</th>
              <th>Ask</th>
              <th>Higher Leg</th>
              <th>Higher Strike</th>
              <th>Ask</th>
              <th>Premium</th>
              <th>Guaranteed</th>
              <th>Overlap</th>
            </tr>
          </thead>
          <tbody>
            {candidates.slice(0, 32).map((candidate) => <CandidateRow key={candidate.pairKey} candidate={candidate} now={snapshot.generatedAt} />)}
            {candidates.length === 0 ? <tr><td colSpan={10} className="empty-cell">No threshold-crossing spreads right now.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SignalTape({ signals }: { signals: DashboardSignal[] }) {
  return (
    <section className="panel tape-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">audit log</p>
          <h2>Signal Tape</h2>
        </div>
      </div>
      <div className="tape-list">
        {signals.slice(0, 12).map((signal) => (
          <div className="tape-item" key={signal.id}>
            <span className={`action action-${signal.action}`}>{signal.action}</span>
            <span>{new Date(signal.createdAt).toLocaleTimeString()}</span>
            <span>{formatCents(signal.guaranteedProfit)} guaranteed</span>
            <span>{signal.lower.direction.toUpperCase()} {signal.lower.strike} / {signal.higher.direction.toUpperCase()} {signal.higher.strike}</span>
          </div>
        ))}
        {signals.length === 0 ? <div className="empty-cell">No persisted signals yet.</div> : null}
      </div>
    </section>
  );
}

function EventTape({ logs }: { logs: DashboardLogEntry[] }) {
  return (
    <section className="panel tape-panel">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">runtime</p>
          <h2>Event Tape</h2>
        </div>
      </div>
      <div className="tape-list">
        {logs.slice(0, 12).map((log, index) => (
          <div className={`tape-item severity-${log.severity.toLowerCase()}`} key={`${log.timestamp}-${index}`}>
            <span>{log.severity}</span>
            <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
            <span>{log.category}</span>
            <span>{log.message}</span>
          </div>
        ))}
        {logs.length === 0 ? <div className="empty-cell">No runtime events yet.</div> : null}
      </div>
    </section>
  );
}

export function DashboardTerminalView({
  dashboardName,
  snapshot,
  streamState,
}: {
  dashboardName: string;
  snapshot: DashboardSnapshot | null;
  streamState: StreamState;
}) {
  if (!snapshot) {
    return (
      <main className="terminal-shell loading-shell">
        <div className="loading-card">
          <p className="panel-kicker">{dashboardName}</p>
          <h1>{streamState === "degraded" ? "Worker stream unavailable" : "Connecting to live terminal"}</h1>
          <p>{streamState === "degraded" ? "The dashboard is waiting for the Railway worker snapshot proxy." : "Opening the read-only market data stream."}</p>
        </div>
      </main>
    );
  }

  const staleCount = staleContractCount(snapshot);
  const mode = snapshot.health.liveTrading ? "LIVE" : "DRY-RUN";
  return (
    <main className="terminal-shell">
      <header className="terminal-header">
        <div>
          <p className="panel-kicker">cross-venue binary arb</p>
          <h1>{dashboardName}</h1>
        </div>
        <div className="status-rail">
          <StatusPill label={streamState === "live" ? "SSE LIVE" : "SSE DEGRADED"} state={streamState === "live" ? "live" : "warn"} />
          <StatusPill label={snapshot.health.arbEnabled ? "STRATEGY ON" : "STRATEGY OFF"} state={snapshot.health.arbEnabled ? "live" : "off"} />
          <StatusPill label={mode} state={snapshot.health.liveTrading ? "warn" : "live"} />
          <StatusPill label={staleCount > 0 ? `${staleCount} STALE BOOKS` : "BOOKS FRESH"} state={staleCount > 0 ? "stale" : "live"} />
        </div>
      </header>

      <section className="metric-grid">
        <div className="metric"><span>Guaranteed Gate</span><strong>{formatCents(snapshot.health.minProfitDollars)}</strong></div>
        <div className="metric"><span>Re-entry Cadence</span><strong>{Math.round(snapshot.health.reentryIntervalMs / 1000)}s</strong></div>
        <div className="metric"><span>Last Scan</span><strong>{snapshot.scanner.lastScanAt ? `${Math.max(0, Math.round((snapshot.generatedAt - snapshot.scanner.lastScanAt) / 1000))}s` : "--"}</strong></div>
        <div className="metric"><span>Discovery Age</span><strong>{snapshot.discovery.lastDiscoveryAt ? `${Math.max(0, Math.round((snapshot.generatedAt - snapshot.discovery.lastDiscoveryAt) / 1000))}s` : "--"}</strong></div>
      </section>

      <section className="terminal-grid">
        <BookTable title="Kalshi BTC 15m" venue="kalshi" contracts={snapshot.books.kalshi} snapshot={snapshot} />
        <OpportunityBlotter snapshot={snapshot} />
        <BookTable title="Polymarket BTC 15m" venue="polymarket" contracts={snapshot.books.polymarket} snapshot={snapshot} />
      </section>

      {snapshot.discovery.lastDiscoveryError ? <div className="error-banner">Discovery error: {snapshot.discovery.lastDiscoveryError}</div> : null}

      <section className="bottom-grid">
        <SignalTape signals={snapshot.recentSignals} />
        <EventTape logs={snapshot.logs} />
      </section>
    </main>
  );
}

export default function DashboardTerminal({ dashboardName }: { dashboardName: string }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("connecting");

  useEffect(() => {
    let cancelled = false;
    const loadSnapshot = async () => {
      try {
        const response = await fetch("/api/dashboard/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error(await response.text());
        if (!cancelled) setSnapshot(await response.json() as DashboardSnapshot);
      } catch {
        if (!cancelled) setStreamState("degraded");
      }
    };

    void loadSnapshot();
    const stream = new EventSource("/api/dashboard/stream");
    stream.addEventListener("snapshot", (event) => {
      setSnapshot(JSON.parse((event as MessageEvent).data) as DashboardSnapshot);
      setStreamState("live");
    });
    stream.onerror = () => {
      setStreamState("degraded");
      void loadSnapshot();
    };

    return () => {
      cancelled = true;
      stream.close();
    };
  }, []);

  return <DashboardTerminalView dashboardName={dashboardName} snapshot={snapshot} streamState={streamState} />;
}
