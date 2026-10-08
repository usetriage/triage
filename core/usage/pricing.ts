/**
 * List prices for the models Claude Code runs, in dollars per million tokens.
 *
 * Claude Code's transcripts record tokens, never money — cost is derived here.
 * Two honest caveats travel with every number this produces:
 *
 *  - These are first-party API list prices. On a Pro/Max subscription nothing
 *    is billed per token, so the figure is "what this would have cost on the
 *    API", not a bill.
 *  - A model we have no row for is counted in tokens and reported as unpriced
 *    rather than guessed at, so a new model never silently reads as free.
 */

export type Price = {
  /** $ per million input tokens. */
  input: number
  /** $ per million output tokens. */
  output: number
  /** $ per million cache-read tokens. Defaults to 0.1 × input. */
  cacheRead?: number
  /** Fast-mode rates, for the models that have one. */
  fast?: Price
  /** Rates once a prompt (input + cache reads/writes) runs past `over` tokens. */
  long?: { over: number; price: Price }
}

/** Cache writes cost a premium over base input: 1.25× at 5m TTL, 2× at 1h. */
const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: { input: 8, output: 40, cacheRead: 0.4 } },
  'claude-opus-5': { input: 5, output: 25, fast: { input: 10, output: 50 } },
  'claude-opus-4-8': { input: 5, output: 25, fast: { input: 10, output: 50 } },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, long: { over: 100_000, price: { input: 0.5, output: 2.5 } } },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/**
 * `claude-opus-5[1m]`, `claude-opus-5-20260401` → `claude-opus-5`. The context
 * suffix the harness appends and any dated snapshot are the same model.
 */
export function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
}

export function priceOf(model: string, fast = false): Price | undefined {
  const id = normalizeModel(model)
  const base = PRICES[id]
  if (!base) return undefined
  return fast && base.fast ? base.fast : base
}

export type TokenCounts = {
  input: number
  output: number
  /** Cache writes at the 5-minute TTL. */
  cacheWrite5m: number
  /** Cache writes at the 1-hour TTL — twice the write premium. */
  cacheWrite1h: number
  cacheRead: number
}

/** Dollars for one message's tokens, or `undefined` when the model has no row. */
export function costOf(model: string, t: TokenCounts, fast = false): number | undefined {
  let p = priceOf(model, fast)
  if (!p) return undefined
  if (p.long && t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead > p.long.over) p = p.long.price
  const read = p.cacheRead ?? p.input * 0.1
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheWrite5m * p.input * CACHE_WRITE_5M +
      t.cacheWrite1h * p.input * CACHE_WRITE_1H +
      t.cacheRead * read) /
    1_000_000
  )
}
