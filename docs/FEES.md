# FARM fee schedule

All rates live in the `fee_configurations` table, keyed by `transaction_type`. Admins edit them in **Admin → Fees** (`PATCH` via `AdminService.updateFee`; 0–100%, audited, cache invalidated). When no row exists, the code default applies; `FEE_<KEY>_PCT` env overrides that default. Apps read rates from `GET /api/v1/fees` and `GET /api/v1/fees/quote?type=<key>&amount=<n>` and must not hardcode them. `FeesService` caches the rates for 30 seconds.

| key | default | who pays | where |
|---|---|---|---|
| escrow_creation | 1.5% | buyer, on top | escrow funding |
| escrow_release | 1.5% | seller, deducted | full and milestone release (escrow total 3% = 1.5% + 1.5%) |
| withdrawal | 1.5% | user, deducted | all withdrawal methods |
| investment | 3% | investor, on top | each project investment (share purchase); credited to the platform wallet; not refunded on cancellation |
| travel_commission | 5% | traveller, on top | hotels and flights, shown as a separate "FARM fee" line (`service_fee_farm`; `base_price_farm` is the provider price). `TRAVEL_FX_MARKUP_BPS` now defaults to 0; the optional flat fee is `TRAVEL_SERVICE_FEE_FARM` |
| merchant | 1% | merchant, deducted | QR sales (wallet, card and crypto), payment links, invoices, pay-business and API-created links/invoices |
| transfer | 0% | — | P2P and cross-border FARM transfers, transfer and payment requests |
| project_listing | 15% | project | Consolidation fund: once at round close, refundable per-project reserve (see below) |
| received_chain | 0% | — | ALGO/USDC received on Algorand (flagged: stays 0) |
| agent_payment | 0% | — | Mkulima and agent payments (flagged: stays 0) |

There is no subscription fee.

Fee semantics: `percent × amount + flat`, floored at `minimum_fee`, capped at `maximum_fee`; 0 means no cap. Previously a 0 maximum zeroed the fee. Fees are credited to the platform (super-admin) wallet with a ledger entry.

`payments.service.ts`: the old `fee_fiat = 2%` was dead code. It was never charged or stored (the ledger recorded `fee: 0` and Paystack was charged `amount_fiat`), so it has been removed.

## Project consolidation fund (15%, user-approved)

- **When:** once, when the funding round closes: automatically when the target is reached (`status → funded`), or when an admin closes the round (`close`). Before the first milestone release the backend also ensures it was taken. Idempotent per project (`consolidation_fee_at`).
- **Amount:** `project_listing`% (default 15) of the total raised.
- **Where:** the main platform (super_admin) wallet. No separate wallet. Ledger entries carry `category = 'consolidation_fund'`; the transaction is `transaction_type = 'fee'` with `metadata.category = 'consolidation_fund'` and `metadata.project_id`.
- **Per-project reserve, never pooled:** `investment_projects.consolidation_fee` (taken in), `consolidation_refunded` (paid back to investors) and `consolidation_released` (released to FARM). Reserve left = fee − refunded − released. Each payout is a guarded SQL claim on that project's row, so a project can never pay out more than its own reserve.
- **Milestones:** the business receives at most raised − fee (85%); each milestone is scaled by (raised − fee)/target.
- **Cancelled project:** each investor gets `amount × (held + reserve_left) / raised`: their share of the unreleased funds plus their share of the reserve. The reserve part debits the platform wallet (`category consolidation_fund`).
- **Project makes a loss:** admin `POST /admin/projects/:id/consolidation-refund` with notes. Pays the remaining reserve pro-rata to investors, all-or-nothing, once.
- **Project completes successfully:** admin `POST /admin/projects/:id/consolidation-release` with notes, only after all funds are released. The reserve stays in the platform wallet and is reclassified to FARM revenue: a debit `consolidation_fund` entry plus a credit `fee_revenue` entry, so the balance doesn't change.
- **Investment fee (3%)** is never refunded.
- **Investors are shown the terms before investing:** the project detail returns `fees.points` with live rates, and the risk disclosure (version 2026-10-v2, re-acceptance required) includes the fee terms.
- Reporting: `SELECT SUM(CASE entry_type WHEN 'credit' THEN amount ELSE -amount END) FROM ledger_entries WHERE category='consolidation_fund'` = total reserve held.


## Token buyback (sell-back) from the 15% fund — `TOKEN_BUYBACK_ENABLED` (default off)

- **Who pays what:** investors pay only the 3% `investment` fee on top of each purchase, tokenized projects included; tokens are issued on the principal (1 FARM = 1 token). The 15% is never charged to investors.
- **Business commitment:** when a business requests tokenization it must accept (`accept_buyback_commitment: true`, stored as `project_tokens.buyback_commitment_at`) that 15% of what the project raises is held back from it (the consolidation fund above) as the buyback pool.
- **Per investor:** each investor can sell back at most `consolidation_fee / raised` (15%) of what they invested in that project, cumulative. Over the limit is rejected, not queued. The pool left (fee − refunded − released − bought_back) is also checked, at request and in a guarded SQL claim at payout.
- **Only after the fund exists:** project `funded`/`closed` with `consolidation_fee_at` set.
- **Admin approval** for every buyback. Delivered tokens are clawed back to the issuer on-chain first (txId stored before sending, idempotent); FARM is credited only after. Held/owed tokens are DB-only.
- **Accounting:** `token_buyback` transaction, credit to the investor wallet, debit from the platform wallet with category `consolidation_fund`; `investment_projects.consolidation_bought_back`, `user_investments.sold_back_amount`, `token_allocations.sold_units`. Cancel/loss refunds use amount − sold_back_amount.
- **Open decision:** on successful completion the remaining 15% fund is currently reclassified to FARM revenue (not returned to the business). That was left unchanged.

## Token holder income — `TOKEN_DISTRIBUTIONS_ENABLED` (default off)

- The business (or an admin on its behalf) requests a profit or rental distribution in FARM. An admin approves it.
- On approval the backend takes a snapshot of current holders. Delivered holdings count by their on-chain balance in the holder's in-app wallet; held or owed holdings count by DB units minus sold-back units. The issuer's unsold and returned tokens are not counted. No snapshot is taken while tokens are moving.
- One DB transaction debits the business owner's FARM wallet (guarded on balance) and credits each holder pro-rata, rounded down to 0.01 FARM. The rounding dust stays with the business. Each holder gets a payout row in `token_distribution_payouts`, unique per holder. Transaction type `token_distribution`, ledger category `token_distribution`.
- **Fee: 2% to FARM** (`TOKEN_DISTRIBUTION_FEE_PERCENT`, default 2, allowed 0–20). The fee is fixed on the request (`token_distributions.fee`). Holders split the other 98% pro-rata. The payer is debited payout + fee, and the fee is credited to the super admin wallet under ledger category `token_distribution_fee`, which is a FARM revenue line.
- No earlier profit-sharing code existed; the marketplace strips return promises (`stripReturns`).

## Token transfers — `TOKEN_TRANSFERS_ENABLED` (default off)

- Holders can send tokens to any FARM user by username or phone. Transaction PIN required.
- Held or owed tokens move in the DB. Delivered tokens move on-chain from wallet to wallet; FARM's issuer signs as clawback account and the funder pays the network fee. The backend opts the recipient in, with ALGO from the capped top-up only.
- **No transfer fee.** Only the network fee, paid by FARM.
- Received tokens earn income but carry **no sell-back allowance**. Sell-back stays tied to the holder's own investment (15% of what they invested, limited to tokens they still hold).
- On cancel, refunds still follow investments, so the original investor is refunded and received tokens are clawed back.

## Project funds flow: `PROJECT_FUNDS_FLOW_ENABLED` and `PROJECT_AUTO_PAYOUTS_ENABLED` (both default off)

- **Locked balance** = raised − 15% buyback hold − already spent (`released_amount`, which milestone releases also use).
- **Spending:** the business pays an **invoice** or **payment link** from another *approved* FARM business with "pay from project funds" (`POST /business/projects/:id/spend`). It needs a PIN and can carry an optional deliverable tag or note. Money can never go to the project's own business or to its owner, and there is no withdrawal or cash-out. There is no per-payment approval. The recipient is credited with ledger category `project_spend`. **Fee: 0** on project spends; no merchant fee is charged.
- **Safety rails:**
  - `PROJECT_SPEND_MAX_PER_PAYMENT`: 10,000 FARM per payment.
  - `PROJECT_PAYOUT_DAILY_CAP`: 25,000 FARM per project per rolling 24 hours, counting spends and holder payouts.
  - `PROJECT_PAYOUT_GLOBAL_DAILY_CAP`: 100,000 FARM across all projects per 24 hours.
  - The caps are checked inside the money transaction under an advisory lock.
  - `PROJECT_PAYOUTS_KILL_SWITCH=true` stops everything.
  - Admins can pause a project (`PATCH /admin/projects/:id/funds-pause`).
  - Every payment uses an idempotency key, is written to the audit log (`project_funds_audit`), and sends an in-app alert to super admins.
- **Returns:** the business deposits returns, either manually or by tagging a merchant payment it received (each payment can be tagged only once). The amount is debited from the owner's wallet and held under ledger category `project_returns`. Per the project settings (monthly / on each deposit / at period end, X%), the system creates a pro-rata holder payout. With `PROJECT_AUTO_PAYOUTS_ENABLED`, it pays automatically if the caps pass, minus the 2% fee. Otherwise it waits for an admin.
- **On-chain (TestNet only, `PROJECT_AUTO_PAYOUTS_ENABLED`):**
  - Each project has a dedicated custodial escrow account. Its key is sealed with `WALLET_KEY_ENCRYPTION_KEY`, and the funder pays its min balance, FARM opt-in and fees.
  - At round close the reserve funds the escrow with the locked balance.
  - Spends go escrow → recipient. Returns go owner → escrow. Holder shares go escrow → holder, and the fee goes escrow → reserve.
  - A user with no ready custodial wallet is backed by the reserve.
  - Moves are sent through an outbox (`project_chain_moves`): compare-and-set claim, txId stored before sending, and a resolver.
  - Moves are held while the funder ALGO balance is below `PROJECT_FUNDER_FLOOR_MICROALGOS` (2 ALGO) or the source FARM balance is too low. After 5 failures a move is blocked, an admin is alerted, and it can be retried with `POST /admin/projects/funds-moves/:id/retry`.
  - MainNet is refused even when `ALGORAND_ALLOW_MAINNET` is set.
