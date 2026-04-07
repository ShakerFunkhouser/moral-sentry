"use client";

import { useState } from "react";
import { SCENARIOS } from "@/lib/scenarios";
import type { ToolCallRequest } from "@/lib/types";

interface Interpretation {
  toolName: string;
  toolArgs: Record<string, unknown>;
  agentIntent: string;
  connection?: string | null;
}

interface Props {
  onFire: (req: ToolCallRequest) => void;
  loading: boolean;
}

export function ScenarioPanel({ onFire, loading }: Props) {
  const [mode, setMode] = useState<"prebuilt" | "custom">("prebuilt");
  const [userId, setUserId] = useState("mock-user");

  // Free-form state
  const [prompt, setPrompt] = useState("");
  const [interpreting, setInterpreting] = useState(false);
  const [interpreted, setInterpreted] = useState<Interpretation | null>(null);
  const [interpretError, setInterpretError] = useState<string | null>(null);

  async function analyzePrompt() {
    if (!prompt.trim()) return;
    setInterpreting(true);
    setInterpreted(null);
    setInterpretError(null);
    try {
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const data = (await res.json()) as Partial<Interpretation> & {
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Interpretation failed");
      if (!data.toolName)
        throw new Error("DeepSeek returned an unexpected shape");
      setInterpreted(data as Interpretation);
    } catch (err) {
      setInterpretError(err instanceof Error ? err.message : String(err));
    } finally {
      setInterpreting(false);
    }
  }

  function fireInterpreted() {
    if (!interpreted) return;
    onFire({
      toolName: interpreted.toolName,
      toolArgs: interpreted.toolArgs,
      agentIntent: interpreted.agentIntent,
      userId: userId || undefined,
    });
  }

  function fireScenario(scenarioId: string) {
    const scenario = SCENARIOS.find((s) => s.id === scenarioId);
    if (!scenario) return;
    onFire({ ...scenario.request, userId: userId || undefined });
  }

  const decisionColors: Record<string, string> = {
    BLOCK: "border-red-700 text-red-300 hover:bg-red-950",
    ESCALATE: "border-yellow-600 text-yellow-300 hover:bg-yellow-950",
    ALLOW: "border-emerald-700 text-emerald-300 hover:bg-emerald-950",
  };

  return (
    <section className="rounded-xl border border-zinc-700 bg-zinc-900 p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-zinc-400">
        Tool Call Scenarios
      </h2>

      {/* Mode toggle */}
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setMode("prebuilt")}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            mode === "prebuilt"
              ? "bg-indigo-600 text-white"
              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
          }`}
        >
          Pre-built
        </button>
        <button
          onClick={() => setMode("custom")}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            mode === "custom"
              ? "bg-indigo-600 text-white"
              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
          }`}
        >
          Free-form
        </button>
      </div>

      {/* User ID field (shared) */}
      <div className="mb-4">
        <label className="mb-1 block text-xs text-zinc-500">
          User ID (optional)
        </label>
        <input
          type="text"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="mock-user"
          className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      {mode === "prebuilt" && (
        <div className="space-y-2">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              disabled={loading}
              onClick={() => fireScenario(s.id)}
              className={`w-full rounded-lg border px-4 py-3 text-left transition-colors disabled:opacity-40 ${decisionColors[s.expectedDecision]}`}
            >
              {/* Header row */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{s.label}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-bold ${
                    s.expectedDecision === "BLOCK"
                      ? "bg-red-900 text-red-300"
                      : s.expectedDecision === "ESCALATE"
                        ? "bg-yellow-900 text-yellow-300"
                        : "bg-emerald-900 text-emerald-300"
                  }`}
                >
                  ~{s.expectedDecision}
                </span>
              </div>

              {/* Description */}
              <p className="mt-1 text-xs opacity-60">{s.description}</p>

              {/* Structured metadata */}
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                <div className="flex gap-1">
                  <dt className="text-zinc-600">Tool</dt>
                  <dd className="font-mono text-zinc-400">{s.meta.tool}</dd>
                </div>
                <div className="flex gap-1">
                  <dt className="text-zinc-600">Risk</dt>
                  <dd className="text-zinc-400">{s.meta.riskCategory}</dd>
                </div>
                <div className="flex gap-1">
                  <dt className="text-zinc-600">Action</dt>
                  <dd className="font-mono text-zinc-400">{s.meta.action}</dd>
                </div>
                {s.meta.connection && (
                  <div className="flex gap-1">
                    <dt className="text-zinc-600">Connection</dt>
                    <dd className="text-zinc-400">{s.meta.connection}</dd>
                  </div>
                )}
              </dl>
            </button>
          ))}
        </div>
      )}

      {mode === "custom" && (
        <div className="space-y-4">
          {/* Prompt input */}
          <div>
            <label className="mb-1 block text-xs text-zinc-500">
              Describe the scenario in plain language
            </label>
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setInterpreted(null);
                setInterpretError(null);
              }}
              rows={3}
              placeholder="e.g. Our CI is broken - squash the last 3 commits and force-push main to unblock the deploy."
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {/* Analyze button */}
          <button
            disabled={interpreting || loading || !prompt.trim()}
            onClick={analyzePrompt}
            className="w-full rounded-lg border border-indigo-700 bg-indigo-950 px-4 py-2 text-sm font-semibold text-indigo-300 transition-colors hover:bg-indigo-900 disabled:opacity-40"
          >
            {interpreting ? "Interpreting with DeepSeek…" : "Analyze Scenario"}
          </button>

          {/* Interpretation error */}
          {interpretError && (
            <p className="rounded-md bg-red-950 px-3 py-2 text-xs text-red-300">
              {interpretError}
            </p>
          )}

          {/* Interpreted result preview */}
          {interpreted && (
            <div className="rounded-lg border border-zinc-700 bg-zinc-800/60 p-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                Interpreted as
              </p>
              <dl className="space-y-1.5 text-xs">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-zinc-500">Tool</dt>
                  <dd className="font-mono text-indigo-300">
                    {interpreted.toolName}
                  </dd>
                </div>
                {Object.keys(interpreted.toolArgs).length > 0 && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-zinc-500">Args</dt>
                    <dd className="font-mono text-zinc-300 break-all">
                      {JSON.stringify(interpreted.toolArgs)}
                    </dd>
                  </div>
                )}
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-zinc-500">Intent</dt>
                  <dd className="text-zinc-300 italic">
                    {interpreted.agentIntent}
                  </dd>
                </div>
                {interpreted.connection && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-zinc-500">Connection</dt>
                    <dd className="font-mono text-emerald-400">
                      {interpreted.connection === "google-oauth2"
                        ? "Gmail (google-oauth2)"
                        : interpreted.connection === "github"
                          ? "GitHub"
                          : interpreted.connection}
                    </dd>
                  </div>
                )}
              </dl>

              <button
                disabled={loading}
                onClick={fireInterpreted}
                className="mt-1 w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
              >
                {loading ? "Running…" : "Run through Moral Sentry"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
