-- ============================================================
-- 065_ai_knowledge_fts_or_match.sql — looser lexical KB retrieval
--
-- Migration 030's match_ai_knowledge_fts used plainto_tsquery, which
-- ANDs every word of the customer's message: a chunk only matched when
-- it contained ALL of them. Real chat messages are long and full of
-- greetings / filler ("kak", "ya", "bisa", "berapa"), so for accounts
-- without an embeddings key the lexical path almost always returned
-- nothing and the AI answered without any knowledge-base grounding.
--
-- New behaviour:
--   1. Split the query into words (letters/digits only, so no tsquery
--      operator can slip in), lowercase, drop 1-char words and common
--      Indonesian / chat filler words.
--   2. Keep at most 60 distinct words, preferring the most recent ones
--      (the caller may pass several recent customer messages).
--   3. A chunk matches when it contains ANY remaining word.
--   4. Chunks are ranked by the sum of IDF-style weights of the words
--      they contain, so rare, specific words ("bnsp", "k3", "skkni")
--      outweigh words that appear in every chunk.
--
-- Same signature and return type as 030, so callers are unchanged.
-- Still SECURITY DEFINER and hard-scoped to p_account_id.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  WITH raw AS (
    SELECT w, max(ord) AS last_pos
    FROM regexp_split_to_table(lower(coalesce(p_query, '')), '[^[:alnum:]]+')
         WITH ORDINALITY AS t(w, ord)
    WHERE char_length(w) >= 2
      AND w <> ALL (ARRAY[
        'yang','dan','di','ke','dari','untuk','dengan','pada','ini','itu',
        'atau','ada','apa','apakah','bisa','bisakah','berapa','bagaimana',
        'gimana','kapan','dimana','siapa','kak','kakak','min','admin','mas',
        'mbak','pak','bu','ibu','bapak','halo','hai','hallo','selamat','pagi',
        'siang','sore','malam','mau','ingin','minta','tanya','nanya','saya',
        'aku','kami','kita','anda','dong','ya','yah','nih','sih','deh','lah',
        'kah','ga','gak','nggak','tidak','tak','saja','aja','juga','lagi',
        'sudah','udah','belum','akan','lebih','sangat','banget','tolong',
        'mohon','terima','kasih','makasih','terimakasih','trims','ok','oke',
        'baik','jika','kalau','kalo','bila','karena','agar','supaya','oleh',
        'para','adalah','yaitu','jadi','bagi','tentang','soal','mengenai',
        'the','and','is','are','of','to','in','for','what','how','can','do'
      ])
    GROUP BY w
    ORDER BY max(ord) DESC
    LIMIT 60
  ),
  words AS (
    SELECT w, to_tsquery('simple', w) AS tq FROM raw
  ),
  total AS (
    SELECT count(*)::float8 AS n
    FROM ai_knowledge_chunks
    WHERE account_id = p_account_id
  ),
  df AS (
    SELECT words.w, words.tq, count(c.id)::float8 AS df
    FROM words
    LEFT JOIN ai_knowledge_chunks c
      ON c.account_id = p_account_id AND c.fts @@ words.tq
    GROUP BY words.w, words.tq
  ),
  scored AS (
    SELECT c.id, c.content, sum(ln(1 + total.n / df.df)) AS score
    FROM df
    CROSS JOIN total
    JOIN ai_knowledge_chunks c
      ON c.account_id = p_account_id AND c.fts @@ df.tq
    WHERE df.df > 0
    GROUP BY c.id, c.content
  )
  SELECT scored.id, scored.content, scored.score::real AS rank
  FROM scored
  ORDER BY scored.score DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Re-assert the lock-down from 030 (mirrors migrations 018 / 025).
REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
