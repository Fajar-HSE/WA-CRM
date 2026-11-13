-- ============================================================
-- 067_embeddings_any_provider.sql — embeddings from any
-- OpenAI-compatible provider
--
-- Until now semantic knowledge-base search could only use OpenAI's
-- text-embedding-3-small (1536 numbers per chunk, fixed in the column type).
-- This lets an account point embeddings at any provider that speaks the
-- OpenAI `/embeddings` format (Google Gemini, Jina, a self-hosted server...):
--
--   1. ai_configs gets embeddings_base_url, embeddings_model and
--      embeddings_dimensions. All NULL = the old behaviour (OpenAI,
--      text-embedding-3-small).
--   2. ai_knowledge_chunks.embedding becomes an unconstrained `vector`, so a
--      model that returns 768, 1024 or 3072 numbers can be stored. Existing
--      1536-number rows are untouched.
--   3. The HNSW index (which needs a fixed size) is dropped. Search is an
--      exact scan of ONE account's chunks (the account_id index narrows it
--      first), which is instant at knowledge-base scale (hundreds to a few
--      thousand chunks).
--   4. match_ai_knowledge_semantic only compares vectors of the same size as
--      the question's. After a model change the old vectors simply stop
--      matching (search falls back to keywords) until Reindex is run, instead
--      of failing with a "different vector dimensions" error.
--
-- Idempotent — safe to run more than once.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS embeddings_base_url   text,
  ADD COLUMN IF NOT EXISTS embeddings_model      text,
  ADD COLUMN IF NOT EXISTS embeddings_dimensions integer;

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_embeddings_dimensions_range;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_embeddings_dimensions_range
  CHECK (embeddings_dimensions IS NULL OR embeddings_dimensions BETWEEN 8 AND 8192);

DROP INDEX IF EXISTS ai_knowledge_chunks_embedding_idx;

ALTER TABLE ai_knowledge_chunks
  ALTER COLUMN embedding TYPE vector;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  WITH q AS (SELECT p_query_embedding::vector AS v)
  SELECT c.id,
         c.content,
         (c.embedding <=> q.v) AS distance
  FROM ai_knowledge_chunks c, q
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
    AND vector_dims(c.embedding) = vector_dims(q.v)
  ORDER BY c.embedding <=> q.v
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions;

-- Re-assert the lock-down from 030 (mirrors migrations 018 / 025).
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) TO authenticated, service_role;
