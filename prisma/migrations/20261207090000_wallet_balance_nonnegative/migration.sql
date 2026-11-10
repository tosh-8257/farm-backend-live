-- Additive. Stops a concurrent debit from driving a wallet below zero.
-- NOT VALID so existing rows are not scanned or rewritten; new updates are checked.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_balance_nonnegative"
  CHECK (
    COALESCE(balance, 0) >= 0
    AND COALESCE(locked_balance, 0) >= 0
  ) NOT VALID;
