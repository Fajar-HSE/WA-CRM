# Embeddings from any OpenAI-compatible provider

The knowledge base can search by meaning (semantic search) when the account
has an embeddings key. The embeddings provider is independent of the chat
model: chat can use Anthropic while embeddings use OpenAI, Gemini, Jina, or a
self-hosted server.

## Settings (Agen AI → Pengaturan → Embeddings)

| Field | Meaning |
| --- | --- |
| Provider preset | Fills the fields below. `OpenAI` leaves them blank. |
| Base URL | OpenAI-compatible base, e.g. `https://host/v1`. Requests go to `{base}/embeddings`. A trailing `/embeddings` is accepted. Blank = OpenAI. |
| Model | Required when a base URL is set. Blank = `text-embedding-3-small` (OpenAI only). |
| Dimensions | Optional. Sent as `dimensions`. If the provider returns another size, the save fails. Allowed 8–8192. |
| API key | Encrypted at rest. Stored separately from the chat key. |

Saving runs a one-input test embed, so a wrong URL, model or key is rejected
before anything is stored.

Presets (Gemini, Jina) are starting points: check the model name against the
provider's own documentation.

## After changing provider or model

Vectors from different models cannot be compared. Click **Indeks ulang**
(Reindex) so every document is embedded again. Until then, the database ignores
vectors whose size differs from the question's, so search keeps working through
keyword matching and nothing errors.

## Security

- https only; no credentials, query or fragment in the URL.
- Private/internal hosts are blocked unless listed in
  `AI_PROVIDER_ALLOWED_PRIVATE_HOSTS` (same rule as custom chat providers).
- Redirects are not followed, so the key cannot be forwarded to another host.

## Database

Migration `067_embeddings_any_provider.sql` adds the three columns to
`ai_configs`, makes `ai_knowledge_chunks.embedding` an unconstrained `vector`,
drops the fixed-size HNSW index, and rewrites `match_ai_knowledge_semantic` to
compare only vectors of the same size. The app keeps working if the code is
deployed before the migration (it falls back to the old columns); apply the
migration before saving a custom provider.
