# Proven-Runner + Dip Bot — Pump.fun Replay Sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leonsis6/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leonsis6/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the pump.fun replay sprint (agent-fun/replay/v2). It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity.

## Strategy

- **Runner entry:** buy only once a launch has proven itself — price already 2x+ off create, 40–120 slots in, with ≥5 SOL real reserve, ≥8 distinct buyers and positive net buy flow; skip coins whose creator already sold.
- **Dip entry:** a second, smaller buy on a sharp (25%+) pullback of a coin that already peaked ≥2x, once buyers step back in — buying the overhang exhaustion, not the falling knife.
- **Ride and bank:** ladder adds (+0.1 SOL per +10% rise, up to 0.6 SOL per coin), sell half at +30%, half of the rest at +80%, trail the remainder 20% from peak, hard stop at −8%, max hold 800 slots; exit early if the creator sells or buy flow turns negative.

## Dev result

On the dev window: net PnL **+0.111 SOL (+1.11%)** (mean over 4 fail keys; worst +0.107 SOL), max drawdown **1.1%**, 27 distinct mints, 28 round trips, 65 fills — positive on every fail-key run, and byte-identical on two repeated runs (deterministic).

## Files

- `main.ts` — entrypoint (`node /bot/main.ts`)
- `strategy.ts` — the strategy (all logic, swept parameters)
- `vendor/agentfun-bot.ts` — the kit SDK, vendored byte for byte
- `LICENSE` — MIT
