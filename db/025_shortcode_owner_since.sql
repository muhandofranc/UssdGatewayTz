-- 025_shortcode_owner_since.sql
--
-- Scope a client's traffic visibility to the period they have actually
-- owned the shortcode.
--
-- Pre-025: the dashboard's per-row ACL was a flat list of shortcode ids
-- (JWT `shortcodeIds`, applied as `shortcode_id = ANY(...)`). Ownership
-- had no time dimension, so re-allocating a shortcode handed the NEW
-- owner every session the PREVIOUS owner had ever run through it —
-- MSISDNs, dialed strings, volumes, error rates. That is another
-- client's data.
--
-- Post-025: `shortcodes.owner_since` records when the current owner was
-- given the shortcode, and the dashboard AND's a per-shortcode time
-- floor into every report predicate. The new owner's reports start at
-- the hand-over; the traffic before it stays invisible to them.
--
-- Backfill: existing rows get `created_at`, i.e. "owned since the
-- shortcode existed". Nothing a current owner can see today disappears
-- tomorrow — only FUTURE re-allocations create a floor.
--
-- The stamp is maintained by a trigger, not by application code, so it
-- holds for every path that can change an owner: the dashboard, a
-- support fix applied by hand in psql, or any future service. An UPDATE
-- may still set `owner_since` explicitly (to correct a mis-stamped
-- hand-over) — the trigger only fills it in when the caller didn't.
--
-- Note on the OLD owner: re-allocation removes the shortcode from their
-- allowlist entirely, exactly as before this migration. They do not
-- keep a read-only window onto their own history. If that is wanted it
-- is a separate change (a per-user grant with a closed [from, to)).
--
-- Idempotent. Safe to re-run.

-- 1. Column, backfilled to created_at so today's visibility is unchanged.
ALTER TABLE shortcodes
    ADD COLUMN IF NOT EXISTS owner_since TIMESTAMPTZ;

UPDATE shortcodes
   SET owner_since = created_at
 WHERE owner_since IS NULL;

ALTER TABLE shortcodes
    ALTER COLUMN owner_since SET DEFAULT now();

ALTER TABLE shortcodes
    ALTER COLUMN owner_since SET NOT NULL;

COMMENT ON COLUMN shortcodes.owner_since IS
    'When owner_user_id was last changed. The dashboard hides traffic '
    'older than this from the owner, so a re-allocated shortcode does '
    'not expose the previous owner''s sessions. Maintained by '
    'trg_shortcodes_owner_since.';

-- 2. Trigger: stamp on every ownership change, wherever it comes from.
CREATE OR REPLACE FUNCTION shortcodes_stamp_owner_since()
RETURNS TRIGGER AS $$
BEGIN
    -- Only when the owner actually changes. An UPDATE that rewrites the
    -- handler URL must not silently re-date the ownership window and
    -- blank out the owner's own history.
    IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       -- ...and only when the caller didn't set owner_since itself, so a
       -- deliberate correction ("this hand-over really happened on the
       -- 3rd") survives.
       AND NEW.owner_since IS NOT DISTINCT FROM OLD.owner_since
    THEN
        NEW.owner_since := now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shortcodes_owner_since ON shortcodes;
CREATE TRIGGER trg_shortcodes_owner_since
    BEFORE UPDATE ON shortcodes
    FOR EACH ROW
    EXECUTE FUNCTION shortcodes_stamp_owner_since();

-- 3. The ACL query reads (owner_user_id, id, owner_since) at login.
--    idx_shortcodes_owner_user already covers the lookup; owner_since
--    rides along as a heap fetch of a handful of rows. No new index.
