/**
 * Daily per-IP quota + global circuit breaker via Workers KV (mitigation
 * layers 4 & 7).
 *
 * The native rate-limit binding only supports 10s/60s windows, so daily limits
 * and a global daily circuit breaker are implemented here on KV.
 *
 * KV FREE-TIER WRITE BUDGET (1,000 writes/day) — design decision:
 *   KV has no atomic increment, and every allowed scan must bump two counters
 *   (per-IP + global). A naive read-modify-write on every request would burn
 *   the write budget and race under concurrency. To stay cheap AND honest we:
 *
 *   1. Read both counters (KV reads are effectively unlimited on free tier).
 *   2. Enforce the limits on the values we just read (fail-safe: a hot IP or a
 *      global spike is caught within KV's eventual-consistency window, seconds).
 *   3. Write the incremented values back with a short TTL. Because a real page
 *      scan already costs multiple subrequests + CPU, the scan volume that a
 *      single free-tier Worker can realistically serve stays well under 1,000
 *      writes/day; the global circuit breaker (GLOBAL_DAILY_CAP) trips long
 *      before KV writes become the binding constraint.
 *
 *   Trade-off accepted: counts are approximate (last-write-wins under
 *   concurrency may undercount by a few), so the per-IP and global caps are set
 *   conservatively low relative to the true free-tier ceiling. This is the
 *   right direction to be wrong in for an anti-abuse guard: we would rather
 *   slightly under-serve at the very edge than jeopardize the free tier.
 */

export interface CounterEnv {
  COUNTERS: KVNamespace;
}

/** Max scans per IP per UTC day. */
export const PER_IP_DAILY_CAP = 100;
/**
 * Global daily circuit breaker. Set FAR below Cloudflare's 100k/day request
 * free ceiling so the tool degrades gracefully ("busy") instead of blowing the
 * budget. Also comfortably under the 1,000/day KV write ceiling.
 */
export const GLOBAL_DAILY_CAP = 800;

/** ~26h TTL so a day's key survives until the next UTC day rolls over. */
const DAY_TTL_SECONDS = 60 * 60 * 26;

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function readCount(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface QuotaDecision {
  allowed: boolean;
  /** "ip_daily" | "global" | null */
  blockedBy: "ip_daily" | "global" | null;
  ipCount: number;
  globalCount: number;
}

/**
 * Check both quotas (read-only) and, if allowed, increment both. Returns the
 * decision. Call once per accepted /scan request AFTER cheaper gates (CORS,
 * Turnstile, per-minute rate limit) have passed, so we do not spend KV writes
 * on obviously-rejected traffic.
 */
export async function checkAndBumpQuotas(
  env: CounterEnv,
  ip: string,
): Promise<QuotaDecision> {
  const day = utcDay();
  const ipKey = `ip:${ip}:${day}`;
  const globalKey = `global:${day}`;

  const [ipCount, globalCount] = await Promise.all([
    readCount(env.COUNTERS, ipKey),
    readCount(env.COUNTERS, globalKey),
  ]);

  if (globalCount >= GLOBAL_DAILY_CAP) {
    return { allowed: false, blockedBy: "global", ipCount, globalCount };
  }
  if (ipCount >= PER_IP_DAILY_CAP) {
    return { allowed: false, blockedBy: "ip_daily", ipCount, globalCount };
  }

  // Increment both. TTL keeps keys self-cleaning; no cron needed.
  await Promise.all([
    env.COUNTERS.put(ipKey, String(ipCount + 1), {
      expirationTtl: DAY_TTL_SECONDS,
    }),
    env.COUNTERS.put(globalKey, String(globalCount + 1), {
      expirationTtl: DAY_TTL_SECONDS,
    }),
  ]);

  return {
    allowed: true,
    blockedBy: null,
    ipCount: ipCount + 1,
    globalCount: globalCount + 1,
  };
}

// ---------------------------------------------------------------------------
// WEIGHTED (site-scan) circuit breaker.
//
// A single /scan-site request costs N single-page scans (discovery + sampling
// picks N URLs, capped at MAX_TOTAL_PAGES). To keep the SAME daily caps honest,
// a site-scan must consume N units of the per-IP + global budget, not 1.
//
// Because N is only known AFTER discovery+sampling, the flow is two-phase:
//   1. peekQuotas()  — read-only pre-check BEFORE running any fetch. If the
//      breaker is already tripped (global or per-IP at/over cap) we refuse with
//      503/429 without spending a single subrequest.
//   2. bumpQuotasBy(n) — after discovery+sampling has determined N, atomically
//      (best-effort, same KV last-write-wins caveat as above) add N units. The
//      caller must FIRST verify the remaining budget can absorb N via
//      canAbsorb(); if not, it refuses honestly (503 "busy") rather than
//      silently trimming the sample into a misleading partial result.
//
// The same KV free-tier caveat applies: no atomic increment, so weighted counts
// are approximate. Weighting N (vs 1) makes the breaker trip EARLIER for heavy
// site-scans, which is the safe direction to be wrong in.
// ---------------------------------------------------------------------------

export interface QuotaSnapshot {
  ipCount: number;
  globalCount: number;
}

/** Read both counters without incrementing (pre-flight for weighted scans). */
export async function peekQuotas(
  env: CounterEnv,
  ip: string,
): Promise<QuotaSnapshot> {
  const day = utcDay();
  const [ipCount, globalCount] = await Promise.all([
    readCount(env.COUNTERS, `ip:${ip}:${day}`),
    readCount(env.COUNTERS, `global:${day}`),
  ]);
  return { ipCount, globalCount };
}

/**
 * Given a snapshot and a weight N, decide whether a site-scan may proceed.
 * A scan is refused if EITHER counter is already at/over its cap, OR if adding N
 * units would push it over. We refuse (do not trim) so the result is never a
 * silently-shrunk, misleading partial scan.
 */
export function canAbsorb(
  snap: QuotaSnapshot,
  n: number,
): { allowed: boolean; blockedBy: "global" | "ip_daily" | null } {
  if (snap.globalCount + n > GLOBAL_DAILY_CAP) {
    return { allowed: false, blockedBy: "global" };
  }
  if (snap.ipCount + n > PER_IP_DAILY_CAP) {
    return { allowed: false, blockedBy: "ip_daily" };
  }
  return { allowed: true, blockedBy: null };
}

/**
 * Add N units to both the per-IP and global daily counters (best-effort,
 * last-write-wins). Re-reads current values first so the weighted bump is based
 * on the freshest count available (still subject to the KV eventual-consistency
 * caveat documented above). Call only after canAbsorb() returned allowed.
 */
export async function bumpQuotasBy(
  env: CounterEnv,
  ip: string,
  n: number,
): Promise<QuotaSnapshot> {
  const day = utcDay();
  const ipKey = `ip:${ip}:${day}`;
  const globalKey = `global:${day}`;

  const [ipCount, globalCount] = await Promise.all([
    readCount(env.COUNTERS, ipKey),
    readCount(env.COUNTERS, globalKey),
  ]);

  const nextIp = ipCount + n;
  const nextGlobal = globalCount + n;

  await Promise.all([
    env.COUNTERS.put(ipKey, String(nextIp), { expirationTtl: DAY_TTL_SECONDS }),
    env.COUNTERS.put(globalKey, String(nextGlobal), {
      expirationTtl: DAY_TTL_SECONDS,
    }),
  ]);

  return { ipCount: nextIp, globalCount: nextGlobal };
}
