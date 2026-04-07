"use client";

import { useState } from "react";
import { FACETS } from "@/lib/scenarios";
import type { PriorityWeights } from "@/lib/types";
import { savePriorities, setMockUser } from "@/lib/gateway";

interface Props {
  priorities: Partial<PriorityWeights>;
  onChange: (updated: Partial<PriorityWeights>) => void;
  isSignedIn?: boolean;
}

function qualitativeLabel(value: number): { label: string; color: string } {
  if (value < 0.2) return { label: "Negligible", color: "text-zinc-500" };
  if (value < 0.4) return { label: "Low", color: "text-blue-400" };
  if (value < 0.6) return { label: "Moderate", color: "text-indigo-400" };
  if (value < 0.8) return { label: "High", color: "text-amber-400" };
  return { label: "Critical", color: "text-red-400" };
}

export function PriorityPanel({
  priorities,
  onChange,
  isSignedIn = false,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSlider(name: string, value: number) {
    onChange({ ...priorities, [name]: value });
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const p = priorities as Record<string, number>;
      // Always sync to the local dev gateway so sliders are reflected immediately.
      // Only persist to Auth0 user_metadata when signed in.
      await setMockUser(p).catch(() => {
        /* gateway may not be running */
      });
      if (isSignedIn) {
        await savePriorities(p);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-700 bg-zinc-900 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">
            Auth0 Moral Priorities
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            {isSignedIn ? (
              <>
                Saved to Auth0{" "}
                <code className="text-zinc-400">user_metadata</code>
              </>
            ) : (
              "Sign in to persist across sessions"
            )}
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : isSignedIn ? "Save Priorities" : "Apply"}
        </button>
      </div>

      {isSignedIn && saved && (
        <p className="mb-3 text-xs text-emerald-400">
          ✓ Saved to Auth0 user_metadata
        </p>
      )}
      {error && <p className="mb-3 text-xs text-red-400">✗ {error}</p>}

      <div className="mb-3 flex justify-between text-[10px] text-zinc-600">
        <span>◄ Negligible</span>
        <span>Critical ►</span>
      </div>

      <div className="space-y-5">
        {FACETS.map((facet) => {
          const value = priorities[facet.name] ?? facet.defaultWeight;
          const { label, color } = qualitativeLabel(value);
          return (
            <div key={facet.name}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs text-zinc-300">{facet.label}</span>
                <div className="flex items-baseline gap-2">
                  <span className={`text-xs font-semibold ${color}`}>
                    {label}
                  </span>
                  <span className="font-mono text-xs text-zinc-600">
                    {value.toFixed(2)}
                  </span>
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={value}
                onChange={(e) =>
                  handleSlider(facet.name, parseFloat(e.target.value))
                }
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
