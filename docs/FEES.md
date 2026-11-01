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
