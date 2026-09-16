-- Pin a KYC approval to the dossier the reviewer actually read.
--
-- `dossierVersion` counts edits to the submitted `raw` payload; `reviewedVersion`
-- is what it was when an elevated caller approved. `enable` refuses to create the
-- receiver at BlindPay unless the two match, so "approve, then edit, then enable"
-- can no longer put never-reviewed identity data in front of the provider.
ALTER TABLE "blindpay_receiver"
  ADD COLUMN "dossierVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "reviewedVersion" INTEGER;

-- Rows already past the review gate were reviewed under the rules of the day, and
-- a NULL here would read as "never reviewed" and refuse their enable. Anything
-- still awaiting review (or with no KYC data yet) keeps NULL, which is the truth.
UPDATE "blindpay_receiver"
SET "reviewedVersion" = "dossierVersion"
WHERE "kycStatus" NOT IN ('inactive', 'pending_review');

-- A NULL status is left NULL on purpose: the transition table has no move out of
-- 'unknown', so such a row cannot be enabled whatever this column says.
