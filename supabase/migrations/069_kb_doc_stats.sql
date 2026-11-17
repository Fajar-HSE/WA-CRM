-- ============================================================
-- 069_kb_doc_stats.sql — per-document chunk / index status
--
-- Surfaces two facts the dashboard never showed before:
--   * chunk_count  — how many retrieval units a document produced
--                    (chunker budget is 1200 chars/paragraph-pack).
--   * index_status — 'semantic' when at least one chunk carries an
--                    embedding (semantic search live for this doc),
--                    'lexical' otherwise (keyword-only, either by
--                    design — no embeddings key — or because embedding
--                    failed). Drives the badge in the KB list so an
--                    admin can see at a glance which docs are
--                    semantically indexed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0;

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS index_status text NOT NULL DEFAULT 'lexical';

ALTER TABLE ai_knowledge_documents
  DROP CONSTRAINT IF EXISTS ai_knowledge_documents_index_status_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_index_status_check
  CHECK (index_status IN ('semantic', 'lexical'));

-- Backfill from existing chunks so already-ingested documents don't
-- show "0 chunks / lexical" until their next reindex.
UPDATE ai_knowledge_documents d
SET chunk_count = COALESCE(s.cnt, 0),
    index_status = CASE
      WHEN COALESCE(s.cnt, 0) = 0 THEN 'lexical'
      WHEN COALESCE(s.sem, 0) > 0 THEN 'semantic'
      ELSE 'lexical'
    END
FROM (
  SELECT document_id,
         count(*)::int AS cnt,
         count(*) FILTER (WHERE embedding IS NOT NULL)::int AS sem
  FROM ai_knowledge_chunks
  GROUP BY document_id
) s
WHERE d.id = s.document_id;
