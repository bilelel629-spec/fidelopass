ALTER TABLE commerces
  ADD COLUMN IF NOT EXISTS review_auto_enabled BOOLEAN DEFAULT false;

ALTER TABLE commerces
  ADD COLUMN IF NOT EXISTS sms_review_enabled BOOLEAN DEFAULT false;

ALTER TABLE commerces
  ADD COLUMN IF NOT EXISTS sms_credits INTEGER DEFAULT 0;

UPDATE commerces
SET review_auto_enabled = COALESCE(review_auto_enabled, sms_review_enabled, false)
WHERE review_auto_enabled IS NULL;
