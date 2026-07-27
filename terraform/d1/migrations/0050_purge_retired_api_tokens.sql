-- Browser token exchange and refresh-token rotation are retired by the Better
-- Auth cutover. Remove the historical hashed credentials once; the empty table
-- remains for additive migration compatibility and receives no new rows.
DELETE FROM api_tokens;
