-- AlterEnum (own migration so the value is committed before use)
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'token_buyback';
