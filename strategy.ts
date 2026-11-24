// Pump.fun replay bot (agent-fun/replay/v2) — "proven runner + dip" hybrid.
//
// Shape: enter only once a launch has PROVEN it is a runner — price already 2x+
// off create, with real SOL on the curve and many distinct buyers piling in —
// then ride the grind with laddered adds and bank partial profits on the way
// up, trailing the rest. A second, smaller dip entry buys a sharp pullback on a
// coin that already proved it can run, once buyers step back in (overhang
// exhaustion). Losers sit flat (~1.0x) forever, so the filter is the price
// level itself: a coin that never runs never gets bought. A tight 8% stop cuts
// the losers that spike and fade before they can bleed.
//
// Everything is a pure function of the batches: no clock, no randomness, no
// I/O, iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  // ---- runner entry ----
  /** Entry window (slots since create) for a first buy. */
  minAge: number;
  maxAge: number;
  /** Price now over the create price, at least. */
  minMult: number;
  /** Real SOL reserve at decision time, at least. */
  minRqSol: number;
  /** Distinct buyers seen on the coin so far, at least. */
  minBuyers: number;
  /** Net SOL bought over the last flowWin slots, at least. */
  minFlowSol: number;
  /** Flow window (slots). */
  flowWin: number;
  /** Skip the coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** First buy (SOL). Capped by 1% of real SOL per reply. */
  stakeSol: number;
  // ---- dip entry ----
  /** Dip: price at most this share of the recent high (over dipWin slots). */
  dipFrac: number;
  dipWin: number;
  /** Dip: distinct buyers in the dip window, at least. */
  dipMinBuyers: number;
  /** Dip: net SOL bought inside the dip window (exhaustion = flow turning positive), at least. */
  dipMinFlowSol: number;
  /** Dip: real SOL at decision, at least. */
  dipMinRqSol: number;
  /** Dip: first buy (SOL). */
  dipStakeSol: number;
  /** Dip: only coins whose peak multiple reached this (proved it can run). */
  dipMinPeakMult: number;
  // ---- adds ----
  /** SOL per ladder add. 0 = no adds. */
  addSol: number;
  /** Add only once the price is this far above the last add's price. */
  addStep: number;
  /** Most SOL committed to one position in total. */
  maxPositionSol: number;
  /** Adds only while the coin is this young (slots since create). */
  maxAddAge: number;
  // ---- exits ----
  /** Sell all when value falls this far under cost. */
  stopLoss: number;
  /** First take-profit: sell tp1Frac of the tokens at this gain. */
  tp1: number;
  tp1Frac: number;
  /** Second take-profit: sell tp2Frac of the rest at this gain. */
  tp2: number;
  tp2Frac: number;
  /** Trailing stop arms at this gain and sells on a fall of trail from peak value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when net flow over exitFlowWin slots falls below -exitFlowSol. */
  exitFlowWin: number;
  exitFlowSol: number;
  // ---- misc ----
  /** Slippage on buys/sells (bps). */
  buySlipBps: number;
  sellSlipBps: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

/** Swept on the dev window (part-00000): best mean net PnL across 4 fail keys. */
export const DEFAULT_PARAMS: Params = {
  minAge: 40,
  maxAge: 120,
  minMult: 2.0,
  minRqSol: 5,
  minBuyers: 8,
  minFlowSol: 0.5,
  flowWin: 30,
  skipDevSold: true,
  stakeSol: 0.5,
  dipFrac: 0.25,
  dipWin: 100,
  dipMinBuyers: 3,
  dipMinFlowSol: 0,
  dipMinRqSol: 3,
  dipStakeSol: 0.05,
  dipMinPeakMult: 2.0,
  addSol: 0.1,
  addStep: 0.1,
  maxPositionSol: 0.6,
  maxAddAge: 300,
  stopLoss: 0.08,
  tp1: 0.3,
  tp1Frac: 0.5,
  tp2: 0.8,
  tp2Frac: 0.5,
  trailArm: 0.3,
  trail: 0.2,
  maxHold: 800,
  exitOnDevSell: true,
  exitFlowWin: 15,
  exitFlowSol: 1,
  buySlipBps: 5000,
  sellSlipBps: 10_000,
  cooldown: 150,
  maxEntries: 1,
  maxExposureSol: 3,
};

const LAMPORTS = 1e9;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
  rq: number;
}

interface Coin {
  created: number | null;
  creator: string;
  p0: number;
  peakMult: number;
  ticks: Tick[];
  buyers: Set<string>;
  netBuy: number;
  devSold: boolean;
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  filled: boolean;
  lastAddPrice: number;
  tookTp1: boolean;
  tookTp2: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.flowWin, p.dipWin, p.exitFlowWin) + 10;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, creator: '', p0: 0, peakMult: 0, ticks: [], buyers: new Set(), netBuy: 0, devSold: false, entries: 0, lastExit: -1e12 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net SOL (buys minus sells), distinct buyers and the high price over the last `w` slots. */
  const windowStats = (c: Coin, now: number, w: number): { net: number; buyers: number; high: number } => {
    let net = 0;
    let high = 0;
    const buyers = new Set<string>();
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const t = c.ticks[i]!;
      if (t.slot <= now - w) break;
      net += t.buy ? t.sol : -t.sol;
      if (t.buy) buyers.add(t.user);
      if (t.price > high) high = t.price;
    }
    return { net, buyers: buyers.size, high };
  };

  /** SOL received for selling `tokens` at these reserves, after the 1.25% curve fee and one tx fee. */
  const sellValue = (tokens: bigint, vq: bigint, vt: bigint, tx: bigint): number => {
    if (tokens <= 0n || vt <= 0n) return 0;
    const q = (tokens * vq) / (vt + tokens);
    const net = Number(q - (q * 125n + 9999n) / 10_000n) / LAMPORTS;
    return net - Number(tx) / LAMPORTS;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.p0 = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.ticks.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price, rq: Number(e.real_quote_reserves) / LAMPORTS });
          if (e.is_buy) {
            c.buyers.add(e.user);
            c.netBuy += sol;
          } else {
            c.netBuy -= sol;
            if (e.user === c.creator) c.devSold = true;
          }
          if (c.p0 > 0 && price / c.p0 > c.peakMult) c.peakMult = price / c.p0;
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.ticks.length && c.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.ticks.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) if (po.order.side === 'sell') pendingSell.add(po.order.mint);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const txSol = Number(tx) / LAMPORTS;

      // --- exits first ---
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete || pendingSell.has(mint)) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = sellValue(BigInt(pos.token_amount), vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        const gain = cost > 0 ? value / cost - 1 : 0;
        const c = coinOf(mint);
        let exit = false;
        if (gain <= -p.stopLoss) {
          exit = true;
        } else if (!h.tookTp1 && gain >= p.tp1) {
          // Partial take-profit: sell tp1Frac now, keep riding the rest.
          if (orders.length < cap) {
            const amt = (BigInt(pos.token_amount) * BigInt(Math.round(p.tp1Frac * 100))) / 100n;
            if (amt > 0n && amt < BigInt(pos.token_amount)) {
              orders.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: p.sellSlipBps });
              h.tookTp1 = true;
            }
          }
        } else if (h.tookTp1 && !h.tookTp2 && gain >= p.tp2) {
          if (orders.length < cap) {
            const amt = (BigInt(pos.token_amount) * BigInt(Math.round(p.tp2Frac * 100))) / 100n;
            if (amt > 0n && amt < BigInt(pos.token_amount)) {
              orders.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: p.sellSlipBps });
              h.tookTp2 = true;
            }
          }
        }
        if (!exit && gain >= p.trailArm && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && p.exitOnDevSell && c.devSold) exit = true;
        if (!exit && windowStats(c, now, p.exitFlowWin).net < -p.exitFlowSol) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // --- entries and ladder adds ---
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      // Exposure counts the cost still committed to each open position. Use the
      // position's live cost (not the lifetime invested amount): after a partial
      // take-profit banks half the tokens, that freed cost is deployable again.
      let exposure = 0;
      for (const mint of held.keys()) {
        exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.created === null || c.p0 <= 0) continue;
        const age = now - c.created;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const h = held.get(mint);
        if (h !== undefined) {
          // Ladder add into strength only.
          if (p.addSol <= 0 || h.invested >= p.maxPositionSol - 0.001 || age > p.maxAddAge) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined || !h.filled) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (windowStats(c, now, p.flowWin).net < 0) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
          let amount = Math.min(p.addSol, p.maxPositionSol - h.invested, capSol, p.maxExposureSol - exposure);
          if (amount > free - txSol) amount = free - txSol;
          if (amount < 0.01) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + txSol;
          exposure += amount;
          h.invested += amount;
          h.lastAddPrice = price;
          continue;
        }
        // New position: one entry per coin, ever.
        if (slotsLeft <= 0) continue;
        if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
        let want = 0;
        const flow = windowStats(c, now, p.flowWin);
        if (age >= p.minAge && age <= p.maxAge && price / c.p0 >= p.minMult && rqSol >= p.minRqSol &&
            c.buyers.size >= p.minBuyers && flow.net >= p.minFlowSol &&
            (!p.skipDevSold || !c.devSold)) {
          // Runner: proven 2x+ with real SOL and a crowd of buyers.
          want = p.stakeSol;
        } else if (age <= 2000 && c.peakMult >= p.dipMinPeakMult && rqSol >= p.dipMinRqSol) {
          // Dip: sharp pullback on a proven runner, buyers stepping back in.
          const dw = windowStats(c, now, p.dipWin);
          if (dw.high > 0 && price <= dw.high * (1 - p.dipFrac) && dw.buyers >= p.dipMinBuyers && dw.net >= p.dipMinFlowSol &&
              (!p.skipDevSold || !c.devSold)) {
            want = p.dipStakeSol;
          }
        }
        if (want <= 0) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < 0.01) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, filled: false, lastAddPrice: price, tookTp1: false, tookTp2: false });
        c.entries++;
        slotsLeft--;
      }
      return orders;
    },
  };
}
