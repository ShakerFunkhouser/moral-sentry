"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PriorityPanel } from "./PriorityPanel";
import { ScenarioPanel } from "./ScenarioPanel";
import { ResultPanel } from "./ResultPanel";
import { LiveFeed } from "./LiveFeed";
import { fireToolCall, getMockUser, resetDemo } from "@/lib/gateway";
import { FACETS } from "@/lib/scenarios";
import type {
  GatewayResponse,
  PriorityWeights,
  ToolCallRequest,
} from "@/lib/types";

function defaultPriorities(): Partial<PriorityWeights> {
  return Object.fromEntries(FACETS.map((f) => [f.name, f.defaultWeight]));
}

export function Dashboard() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState<
    { name?: string; email?: string } | null | undefined
  >(undefined);
  const syncedRef = useRef(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Poll /api/auth/me to get the real session state - avoids relying on
  // server→client prop hydration which can miss post-OAuth redirects
  function checkSession() {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d: { user: { name?: string; email?: string } | null }) =>
        setAuthUser(d.user ?? null),
      )
      .catch(() => setAuthUser(null));
  }

  useEffect(() => {
    checkSession();
    // Re-check when the tab becomes visible (user returns from Auth0 login page)
    const onFocus = () => {
      checkSession();
      syncVaultToken();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  // Surface any connect_error redirected back from /api/auth/connect-account
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("connect_error");
    if (err) {
      setConnectError(decodeURIComponent(err));
      params.delete("connect_error");
      const clean =
        window.location.pathname +
        (params.toString() ? "?" + params.toString() : "");
      router.replace(clean);
    }
  }, [router]);

  // After returning from Google / GitHub OAuth for Token Vault Connected Accounts,
  // re-sync the refresh token then auto-fire the pending approved request.
  useEffect(() => {
    const pending = sessionStorage.getItem(
      "moral-sentry:pending-after-connect",
    );
    if (!pending) return;
    sessionStorage.removeItem("moral-sentry:pending-after-connect");
    const req = JSON.parse(pending) as ToolCallRequest;
    // Re-sync vault token first (the new connected account changes what Token Vault returns)
    fetch("/api/sync-vault-token", { method: "POST" })
      .catch(() => {})
      .finally(() => {
        setApproving(true);
        setError(null);
        setLastRequest(req);
        fireToolCall(req)
          .then((result) => {
            if (
              result.decision === "ESCALATE" &&
              result.result.requireApproval?.title.includes("Not Connected")
            ) {
              const desc = result.result.requireApproval?.description ?? "";
              const auth0ErrMatch = desc.match(/⚠️ Auth0 error: (.+)/);
              const errorMsg = auth0ErrMatch
                ? `Auth0 Token Vault error: ${auth0ErrMatch[1]}`
                : "Token Vault still reports account not connected. Please try connecting again.";
              setError(errorMsg);
              setResponse(result);
            } else if (result.decision === "ESCALATE") {
              setResponse({
                ...result,
                decision: "ALLOW",
                result: {},
                humanApproved: true,
              });
            } else {
              setResponse(result);
            }
          })
          .catch((err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
          )
          .finally(() => setApproving(false));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const userLoading = authUser === undefined;
  const user = authUser;

  const [priorities, setPriorities] =
    useState<Partial<PriorityWeights>>(defaultPriorities());
  const [lastRequest, setLastRequest] = useState<ToolCallRequest | null>(null);
  const [response, setResponse] = useState<GatewayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vaultSynced, setVaultSynced] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [gatewayHealth, setGatewayHealth] = useState<{
    auth0Live: boolean;
    deepSeekLive: boolean;
    auth0Domain?: string;
  } | null>(null);

  // When user logs in, push refresh token to gateway for Token Vault.
  // Also re-sync on window focus so a gateway restart doesn't lose the token.
  function syncVaultToken() {
    if (!syncedRef.current) return; // not logged in yet
    fetch("/api/sync-vault-token", { method: "POST" })
      .then((r) => r.json())
      .then((d: { synced?: boolean }) => {
        if (d.synced) setVaultSynced(true);
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (user && !syncedRef.current) {
      syncedRef.current = true;
      syncVaultToken();
    }
    if (!user && !userLoading) {
      syncedRef.current = false;
      setVaultSynced(false);
    }
  }, [user, userLoading]);

  // Hydrate priority sliders from current gateway state on mount
  useEffect(() => {
    getMockUser()
      .then((state) => {
        if (
          state.moral_priorities &&
          Object.keys(state.moral_priorities).length > 0
        ) {
          setPriorities((prev) => ({ ...prev, ...state.moral_priorities }));
        }
      })
      .catch(() => {});

    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => setGatewayHealth(data as typeof gatewayHealth))
      .catch(() => {});
  }, []);

  async function handleFire(req: ToolCallRequest) {
    setLoading(true);
    setError(null);
    setResponse(null);
    setLastRequest(req);
    try {
      const result = await fireToolCall(req);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove() {
    if (!lastRequest || !response || response.decision !== "ESCALATE") return;

    const title = response.result.requireApproval?.title ?? "";
    if (title.includes("Not Connected")) return; // vault gate - handled by Connect button

    setApproving(true);
    setError(null);

    try {
      const result = await fireToolCall({ ...lastRequest, approved: true });

      if (result.decision !== "ESCALATE") {
        // Gateway returned ALLOW or BLOCK - show as-is
        setResponse(result);
        return;
      }

      const newTitle = result.result.requireApproval?.title ?? "";
      if (newTitle.includes("Not Connected")) {
        // Vault gate fired after approval - user needs to connect account
        // Show the vault-gate escalation (has "Connect Account" button, no loop)
        setResponse(result);
      } else {
        // Gateway returned the same moral-review escalation (running old code without
        // the approved override, or a second-pass calculus concern).
        // Human approval is final - synthesise ALLOW client-side.
        setResponse({
          ...result,
          decision: "ALLOW",
          result: {},
          humanApproved: true,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }

  async function handleReset() {
    setResetting(true);
    setResetError(null);
    setResponse(null);
    setLastRequest(null);
    try {
      await resetDemo();
      setVaultSynced(false);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  }

  function handleConnectAccount(connection: string) {
    // Persist the current request so it auto-fires when the user returns from OAuth
    if (lastRequest) {
      sessionStorage.setItem(
        "moral-sentry:pending-after-connect",
        JSON.stringify({ ...lastRequest, approved: true }),
      );
    }
    const returnTo = encodeURIComponent("/");
    window.location.href = `/api/auth/connect-account?connection=${connection}&returnTo=${returnTo}`;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto max-w-6xl flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-tight">
              <span className="text-indigo-400">Moral Sentry</span>
              <span className="ml-2 text-zinc-500 text-sm font-normal">
                Dev Dashboard
              </span>
            </h1>
            <p className="text-xs text-zinc-600 mt-0.5">
              OpenClaw plugin · Objectifiabilist moral calculus · Auth0 Token
              Vault
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block h-2 w-2 rounded-full animate-pulse ${gatewayHealth?.auth0Live ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              <span className="text-xs text-zinc-500">
                {gatewayHealth?.auth0Live
                  ? `Auth0 live · ${gatewayHealth.auth0Domain}`
                  : "Auth0 & Token Vault mocked"}
              </span>
            </span>
            <span className="text-zinc-700">·</span>
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block h-2 w-2 rounded-full animate-pulse ${gatewayHealth?.deepSeekLive ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              <span className="text-xs text-zinc-500">
                {gatewayHealth?.deepSeekLive
                  ? "DeepSeek assessor live"
                  : "DeepSeek not configured"}
              </span>
            </span>
            <span className="text-zinc-700">·</span>
            <button
              onClick={handleReset}
              disabled={resetting}
              title={resetError ?? undefined}
              className="rounded-md bg-zinc-800 px-3 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-50"
            >
              {resetting ? "Resetting…" : "Reset Demo"}
            </button>
            <span className="text-zinc-700">·</span>
            {userLoading ? (
              <span className="text-xs text-zinc-600">…</span>
            ) : user ? (
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${vaultSynced ? "bg-emerald-500" : "bg-zinc-600"}`}
                />
                <span className="text-xs text-zinc-400 max-w-[140px] truncate">
                  {user.name ?? user.email}
                </span>
                <a
                  href="/api/auth/logout"
                  className="rounded-md bg-zinc-800 px-3 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-700 border border-zinc-700"
                >
                  Sign out
                </a>
              </div>
            ) : (
              <a
                href="/api/auth/login"
                className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                Sign in with Auth0
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Connect-account error banner */}
      {connectError && (
        <div className="mx-auto max-w-6xl px-6 pt-4">
          <div className="flex items-start justify-between rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3">
            <div>
              <p className="text-xs font-semibold text-amber-400">
                Connected Accounts not configured
              </p>
              <p className="mt-0.5 text-xs text-amber-300/70">{connectError}</p>
              <p className="mt-1 text-xs text-zinc-500">
                Enable <strong className="text-zinc-400">My Account API</strong>{" "}
                and <strong className="text-zinc-400">Token Vault</strong> in
                your Auth0 Dashboard, then add a Google social connection.
              </p>
            </div>
            <button
              onClick={() => setConnectError(null)}
              className="ml-4 shrink-0 text-xs text-zinc-600 hover:text-zinc-400"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Main grid */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left column: priorities */}
          <div className="lg:col-span-1">
            <PriorityPanel
              priorities={priorities}
              onChange={setPriorities}
              isSignedIn={!!user}
            />
          </div>

          {/* Right two columns: scenarios + result */}
          <div className="lg:col-span-2 space-y-6">
            <ScenarioPanel onFire={handleFire} loading={loading} />
            <ResultPanel
              response={response}
              loading={loading || approving}
              error={error}
              onApprove={handleApprove}
              approving={approving}
              onConnectAccount={handleConnectAccount}
            />
          </div>
        </div>
      </main>

      {/* Live feed */}
      <div className="mx-auto max-w-6xl px-6 pb-10">
        <LiveFeed />
      </div>
    </div>
  );
}
