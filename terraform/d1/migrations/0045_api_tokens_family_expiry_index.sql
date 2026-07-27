-- Refresh-token rows must outlive their whole rotation family so a late
-- replay of a consumed ancestor still reads as reuse (family revocation),
-- never as an unknown token. The retention sweep therefore deletes
-- family-scoped rows by family_expires_at; plain bare-column index on
-- purpose (see migration 0024's lesson).
CREATE INDEX idx_api_tokens_family_expires_at ON api_tokens(family_expires_at);
