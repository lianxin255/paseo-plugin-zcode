import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  hashAccountKey,
  unavailable,
  windowFromUsedPct,
  toneFromUsedPct,
} from "@getpaseo/plugin/server/usage";
import type { UsageAccount, UsageReport, UsageSourceRegistration } from "@getpaseo/plugin/server/usage";

// A Paseo usage source for the GLM Coding Plan. It mirrors what the bridge's
// `zcode-acp quota` shows, reading the same `~/.zcode/v2/config.json`
// credentials and hitting the same quota endpoint — no bridge or backend
// process is spawned. Unknown limit types surface verbatim rather than
// disappearing, matching the bridge's parse philosophy.

const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const HOST_CN = "https://open.bigmodel.cn";
const HOST_INTL = "https://api.z.ai";
const FETCH_TIMEOUT_MS = 8000;

const inputSchema = z.object({ account: z.string() }).strict();

interface RawLimit {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  usage?: unknown;
  remaining?: unknown;
  currentValue?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Fallback chain mirrors the bridge: absolute remaining/current counters,
// then used/total, then the legacy percentage field (treated as USED percent).
function usedPercentOf(limit: RawLimit): number | null {
  const remaining = asFiniteNumber(limit.remaining);
  const current = asFiniteNumber(limit.currentValue);
  const usage = asFiniteNumber(limit.usage);
  const totalFromParts = remaining !== null && current !== null ? remaining + current : null;
  const total = totalFromParts !== null && totalFromParts > 0 ? totalFromParts : usage;
  if (total !== null && total > 0) {
    if (remaining !== null && remaining >= 0 && remaining <= total) {
      return clampPercent(100 - (remaining / total) * 100);
    }
    if (current !== null && current >= 0 && current <= total) {
      return clampPercent((current / total) * 100);
    }
  }
  return clampPercent(asFiniteNumber(limit.percentage));
}

// GLM convention: legacy payloads name token windows TOKENS_LIMIT with
// number 5 → the 5-hour window, 7 → weekly; current payloads send the same
// windows as CREDIT_LIMIT with a numeric unit (3 = hour, 6 = week), which
// must resolve to the same semantic ids. Include reported unit/number in
// fallback ids to distinguish windows with the same unrecognized type.
export function describeLimit(
  limit: RawLimit,
): { id: string; label: string; shortLabel: string; summary: boolean } {
  const type = typeof limit.type === "string" ? limit.type : "";
  const number = asFiniteNumber(limit.number);
  const unit = asFiniteNumber(limit.unit);
  if (type === "TOKENS_LIMIT") {
    if (number === 5) return { id: "token_5h", label: "5-hour", shortLabel: "5h", summary: true };
    if (number === 7) return { id: "token_week", label: "Weekly", shortLabel: "wk", summary: true };
    if (number !== null)
      return { id: `token_${number}`, label: `Token ${number}h`, shortLabel: `${number}h`, summary: false };
    return { id: "token", label: "Token", shortLabel: "", summary: false };
  }
  if (type === "MCP_LIMIT" || type === "TIME_LIMIT") {
    return { id: "mcp", label: "MCP", shortLabel: "mcp", summary: false };
  }
  if (type === "CREDIT_LIMIT" && unit === 3 && number === 5) {
    return { id: "token_5h", label: "5-hour", shortLabel: "5h", summary: true };
  }
  if (type === "CREDIT_LIMIT" && unit === 6 && number === 1) {
    return { id: "token_week", label: "Weekly", shortLabel: "wk", summary: true };
  }
  const fallback = type || "Quota";
  const parts = [fallback.toLowerCase()];
  if (unit !== null) parts.push(`u${unit}`);
  if (number !== null) parts.push(`n${number}`);
  return { id: parts.join("_"), label: fallback, shortLabel: "", summary: false };
}

function zcodeHome(): string {
  const explicit = process.env.ZCODE_HOME?.trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), ".zcode");
}

function configPath(): string {
  return path.join(zcodeHome(), "v2", "config.json");
}

interface Account {
  providerId: string;
  apiKey: string;
  // Set only for providers whose baseURL is an official quota host.
  quotaHost?: string;
}

// The quota endpoint belongs to Z.ai/BigModel only. Accept exactly the two
// official hosts over https (the API path in the provider baseURL is
// irrelevant). Any other baseURL — a custom gateway, a local endpoint —
// yields nothing, so its key can never be attached to this request.
function officialQuotaHost(baseURL: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.port) return undefined;
  const host = url.hostname.toLowerCase();
  if (host === "api.z.ai") return HOST_INTL;
  if (host === "open.bigmodel.cn") return HOST_CN;
  return undefined;
}

// Pick the account to report. An explicit ZCODE_PROVIDER pin is honored
// exactly (a pinned custom provider only ever reports unavailable, never
// falls back to another account). Without a pin, prefer the first enabled,
// key-carrying provider on an official host — gateway users who also hold a
// Coding Plan still see its card; custom-only users get the candidate for
// the no-request unavailable path.
function activeAccount(): Account | undefined {
  let cfg: unknown;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return undefined;
  }
  const providers = (cfg as { provider?: Record<string, unknown> })?.provider ?? {};
  const pinned = process.env.ZCODE_PROVIDER?.trim();
  let fallback: Account | undefined;
  for (const [id, raw] of Object.entries(providers)) {
    if (pinned && id !== pinned) continue;
    const p = raw as {
      enabled?: unknown;
      options?: { apiKey?: unknown; baseURL?: unknown };
    };
    const apiKey = typeof p?.options?.apiKey === "string" ? p.options.apiKey : "";
    const baseURL = typeof p?.options?.baseURL === "string" ? p.options.baseURL : "";
    if (p?.enabled !== true || !apiKey) continue;
    const quotaHost = officialQuotaHost(baseURL);
    if (quotaHost) return { providerId: id, apiKey, quotaHost };
    if (!fallback) fallback = { providerId: id, apiKey };
  }
  return fallback;
}

function accountKey(): string {
  return hashAccountKey(`${configPath()}|zcode`);
}

async function fetchQuota(account: Account): Promise<UsageReport> {
  // No official host — a custom gateway/local endpoint account: report
  // unavailable WITHOUT sending anything (its key never leaves for quota).
  if (!account.quotaHost) {
    return unavailable({
      kind: "no_quota",
      detail: "the active ZCode provider is not an official Z.ai/BigModel endpoint",
    });
  }
  let resp: Response;
  try {
    resp = await fetch(`${account.quotaHost}${QUOTA_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json, text/plain, */*", Authorization: `Bearer ${account.apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: "error", error: `quota request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (resp.status === 401 || resp.status === 403) {
    return unavailable({ kind: "rejected", status: resp.status });
  }
  if (resp.status === 429) {
    return unavailable({ kind: "rejected", status: 429 });
  }
  if (!resp.ok) {
    return { status: "error", error: `quota endpoint returned HTTP ${resp.status}` };
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    return { status: "error", error: "quota endpoint returned non-JSON" };
  }
  const body = payload as { success?: unknown; data?: { level?: unknown; limits?: unknown } };
  if (body?.success !== true || !Array.isArray(body.data?.limits)) {
    return unavailable({ kind: "no_quota", detail: "quota endpoint reported no limits" });
  }
  const items = body.data.limits
    .map((raw) => {
      const limit = raw as RawLimit;
      const used = usedPercentOf(limit);
      if (used === null) return undefined;
      const { id, label, shortLabel, summary } = describeLimit(limit);
      const resetsMs = asFiniteNumber(limit.nextResetTime);
      return windowFromUsedPct({
        id,
        label,
        shortLabel,
        summary,
        utilizationPct: used,
        resetsAt: resetsMs !== null ? new Date(resetsMs).toISOString() : null,
        tone: toneFromUsedPct(used),
      });
    })
    .filter((w): w is NonNullable<typeof w> => w !== undefined);
  if (items.length === 0) {
    return unavailable({ kind: "no_quota", detail: "no computable quota windows" });
  }
  const level = typeof body.data.level === "string" ? body.data.level : undefined;
  return { status: "available", ...(level ? { planLabel: level } : {}), windows: items };
}

export function zcodeUsageRegistration(): UsageSourceRegistration {
  return {
    id: "zcode",
    label: "ZCode",
    icon: "icon.svg",
    input: inputSchema,
    discover: async () => {
      const account = activeAccount();
      if (!account) return [];
      const entry: UsageAccount = {
        key: accountKey(),
        label: account.providerId,
        harness: "ZCode",
        input: { account: accountKey() },
      };
      return [entry];
    },
    fetch: async (input) => {
      inputSchema.parse(input);
      const account = activeAccount();
      if (!account) {
        return unavailable({ kind: "no_quota", detail: "ZCode is not signed in on this host" });
      }
      return fetchQuota(account);
    },
  };
}
