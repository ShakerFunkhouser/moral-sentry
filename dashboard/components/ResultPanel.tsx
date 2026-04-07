"use client";

import type { GatewayResponse } from "@/lib/types";
import { FACETS } from "@/lib/scenarios";

interface Props {
  response: GatewayResponse | null;
  loading: boolean;
  error: string | null;
  onApprove?: () => void;
  approving?: boolean;
  onConnectAccount?: (connection: string) => void;
}

const DECISION_STYLES = {
  BLOCK: {
    badge: "bg-red-600 text-white",
    border: "border-red-700",
    barColor: "bg-red-500",
    label: "BLOCKED",
  },
  ESCALATE: {
    badge: "bg-yellow-500 text-black",
    border: "border-yellow-600",
    barColor: "bg-yellow-400",
    label: "ESCALATED",
  },
  ALLOW: {
    badge: "bg-emerald-600 text-white",
    border: "border-emerald-700",
    barColor: "bg-emerald-500",
    label: "ALLOWED",
  },
} as const;

const LOW_THRESHOLD = 0.2;
const HIGH_THRESHOLD = 0.45;

function DiverenceBar({
  divergence,
  barColor,
}: {
  divergence: number;
  barColor: string;
}) {
  const pct = Math.round(divergence * 100);
  return (
    <div className="mb-4">
      <div className="mb-1 flex justify-between text-xs text-zinc-400">
        <span>Moral Divergence</span>
        <span className="font-mono font-bold">{pct}%</span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-zinc-800">
        {/* threshold markers */}
        <div
          className="absolute top-0 h-full w-px bg-zinc-500 opacity-60"
          style={{ left: `${LOW_THRESHOLD * 100}%` }}
          title="Allow threshold"
        />
        <div
          className="absolute top-0 h-full w-px bg-zinc-400 opacity-80"
          style={{ left: `${HIGH_THRESHOLD * 100}%` }}
          title="Block threshold"
        />
        {/* fill */}
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-600">
        <span>Allow &lt;{LOW_THRESHOLD * 100}%</span>
        <span>Escalate</span>
        <span>Block ≥{HIGH_THRESHOLD * 100}%</span>
      </div>
    </div>
  );
}

function FacetTrace({ facetScores }: { facetScores: Record<string, number> }) {
  const facetMeta = Object.fromEntries(FACETS.map((f) => [f.name, f.label]));
  const entries = Object.entries(facetScores).sort((a, b) => a[1] - b[1]);
  if (entries.length === 0) return null;

  return (
    <div className="mb-3 rounded-lg bg-zinc-800/60 p-3">
      <p className="mb-2 text-xs font-semibold uppercase text-zinc-500">
        Calculus Trace
      </p>
      <div className="space-y-1.5">
        {entries.map(([facet, score]) => {
          const pct = Math.abs(score) * 100;
          const isHarm = score < 0;
          const isBeneficial = score > 0;
          return (
            <div key={facet} className="flex items-center gap-2">
              <span className="w-36 shrink-0 text-xs text-zinc-400">
                {facetMeta[facet] ?? facet.replace(/_/g, " ")}
              </span>
              <div className="relative flex h-2 w-full items-center">
                {/* centre line */}
                <div className="absolute left-1/2 h-full w-px bg-zinc-600" />
                {isHarm && (
                  <div
                    className="absolute right-1/2 h-2 rounded-l bg-red-500/70 transition-all duration-300"
                    style={{ width: `${pct / 2}%` }}
                  />
                )}
                {isBeneficial && (
                  <div
                    className="absolute left-1/2 h-2 rounded-r bg-emerald-500/70 transition-all duration-300"
                    style={{ width: `${pct / 2}%` }}
                  />
                )}
              </div>
              <span
                className={`w-10 text-right font-mono text-xs ${
                  isHarm
                    ? "text-red-400"
                    : isBeneficial
                      ? "text-emerald-400"
                      : "text-zinc-500"
                }`}
              >
                {score >= 0 ? "+" : ""}
                {score.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ResultPanel({
  response,
  loading,
  error,
  onApprove,
  approving,
  onConnectAccount,
}: Props) {
  return (
    <section className="rounded-xl border border-zinc-700 bg-zinc-900 p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-zinc-400">
        Decision
      </h2>

      {loading && (
        <div className="flex items-center gap-2 text-zinc-400">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-400" />
          <span className="text-sm">
            {approving
              ? "Human approved - Token Vault + calculus running…"
              : "DeepSeek scoring · calculus running…"}
          </span>
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 p-4">
          <p className="text-xs font-semibold text-red-400">Gateway Error</p>
          <p className="mt-1 font-mono text-xs text-red-300">{error}</p>
          <p className="mt-2 text-xs text-zinc-500">
            Is the dev gateway running?{" "}
            <code className="text-zinc-400">npm run dev-gateway</code>
          </p>
        </div>
      )}

      {!loading && !error && !response && (
        <p className="text-sm text-zinc-600">
          Fire a scenario or tool call to see the Moral Sentry decision.
        </p>
      )}

      {!loading &&
        !error &&
        response &&
        (() => {
          const style = DECISION_STYLES[response.decision];
          return (
            <div className={`rounded-xl border ${style.border} p-5`}>
              {/* Decision badge */}
              <div className="mb-4 flex items-center gap-3 flex-wrap">
                <span
                  className={`rounded-lg px-4 py-1.5 text-xl font-black tracking-widest transition-all duration-300 ${style.badge}`}
                >
                  {style.label}
                </span>
                {response.humanApproved && (
                  <span className="flex items-center gap-1 rounded-full border border-emerald-700 bg-emerald-950 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    Human Approved
                  </span>
                )}
                {response.audit && (
                  <span className="text-xs text-zinc-500">
                    prescribed:{" "}
                    <span className="font-mono text-zinc-300">
                      {response.audit.prescribed}
                    </span>
                  </span>
                )}
                {response.liveAssessment && (
                  <span className="ml-auto flex items-center gap-1 rounded-full border border-indigo-700 bg-indigo-950 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-300">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-400" />
                    Assessed by DeepSeek
                  </span>
                )}
              </div>

              {/* Divergence bar */}
              {response.audit && (
                <DiverenceBar
                  divergence={response.audit.divergence}
                  barColor={style.barColor}
                />
              )}

              {/* Facet trace */}
              {response.audit?.facetScores && (
                <FacetTrace facetScores={response.audit.facetScores} />
              )}

              {/* Block reason */}
              {response.result.blockReason && (
                <div className="mb-3 rounded-lg bg-zinc-800 p-3">
                  <p className="text-xs font-semibold uppercase text-zinc-500">
                    Block Reason
                  </p>
                  <p className="mt-1 text-sm text-zinc-200">
                    {response.result.blockReason}
                  </p>
                </div>
              )}

              {/* Approval details */}
              {response.result.requireApproval &&
                (() => {
                  const { title, description, severity } =
                    response.result.requireApproval;
                  const isVaultGate = title.includes("Not Connected");
                  const isSignInRequired = title.includes("Sign In Required");
                  // Infer which connection needs to be linked from the title
                  const vaultConnection = title.toLowerCase().includes("google")
                    ? "google-oauth2"
                    : title.toLowerCase().includes("github")
                      ? "github"
                      : null;
                  const connectUrl = vaultConnection
                    ? `/api/auth/connect-account?connection=${vaultConnection}&returnTo=${encodeURIComponent("/")}`
                    : null;

                  return (
                    <div className="mb-3 rounded-lg bg-zinc-800 p-3">
                      <p className="text-xs font-semibold uppercase text-zinc-500">
                        {isSignInRequired
                          ? "Auth0 - Sign In Required"
                          : isVaultGate
                            ? "Token Vault - Account Not Connected"
                            : "Approval Required"}
                      </p>
                      <p className="mt-1 text-sm font-medium text-zinc-200">
                        {title}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">
                        {description}
                      </p>
                      <div className="mt-3 flex items-center gap-3 flex-wrap">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${
                            severity === "high"
                              ? "bg-orange-900 text-orange-300"
                              : "bg-yellow-900 text-yellow-300"
                          }`}
                        >
                          severity: {severity}
                        </span>
                        {isSignInRequired ? (
                          <a
                            href="/api/auth/login?prompt=login"
                            className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                          >
                            Sign in with Auth0 →
                          </a>
                        ) : isVaultGate && connectUrl ? (
                          <button
                            onClick={() => {
                              if (onConnectAccount && vaultConnection) {
                                onConnectAccount(vaultConnection);
                              } else {
                                window.location.href = connectUrl;
                              }
                            }}
                            className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                          >
                            Connect
                            {vaultConnection === "google-oauth2"
                              ? " Google"
                              : " GitHub"}{" "}
                            Account →
                          </button>
                        ) : (
                          onApprove && (
                            <button
                              onClick={onApprove}
                              disabled={approving}
                              className="rounded-md bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
                            >
                              {approving ? "Approving…" : "Approve & Proceed"}
                            </button>
                          )
                        )}
                        {response.vaultConnected && !isVaultGate && (
                          <span className="flex items-center gap-1 text-xs text-emerald-400">
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            Token Vault ready (Google)
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}

              {/* ALLOW notice */}
              {response.decision === "ALLOW" && (
                <div className="mb-3 rounded-lg border border-emerald-800 bg-emerald-950/30 p-3">
                  <p className="text-xs text-emerald-400">
                    ✓ In a live agent deployment, the tool would now execute.
                    {response.humanApproved &&
                      " The human operator reviewed and approved this action."}
                    {response.vaultConnected &&
                      " Token Vault verified a connected account token."}
                  </p>
                </div>
              )}

              {/* Raw JSON toggle */}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-zinc-600 hover:text-zinc-400">
                  Raw response
                </summary>
                <pre className="mt-2 overflow-x-auto rounded bg-zinc-950 p-3 text-xs text-zinc-400">
                  {JSON.stringify(response, null, 2)}
                </pre>
              </details>
            </div>
          );
        })()}
    </section>
  );
}
