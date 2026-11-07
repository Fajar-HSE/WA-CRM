import type { ChatMessage } from './types'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/** Max recent customer messages folded into one knowledge-base query. */
export const KNOWLEDGE_QUERY_MESSAGES = 10
/** Hard cap on the query length (chars); the newest text wins. */
const KNOWLEDGE_QUERY_MAX_CHARS = 2000

/**
 * The text to retrieve knowledge against: the last `maxMessages` customer
 * (`user`) turns joined in chronological order. A short follow-up such as
 * "berapa biayanya?" carries no topic on its own; the earlier turns do
 * ("sertifikasi K3 umum"). Falls back to the last message of any role when
 * there are no customer turns, then empty string. Shared by the draft
 * route, the playground and the auto-reply bot.
 */
export function knowledgeQuery(
  messages: ChatMessage[],
  maxMessages: number = KNOWLEDGE_QUERY_MESSAGES,
): string {
  const userTurns = messages
    .filter((m) => m.role === 'user' && m.content.trim())
    .slice(-Math.max(1, maxMessages))
    .map((m) => m.content.trim())
  if (userTurns.length === 0) return latestUserMessage(messages)
  const joined = userTurns.join('\n')
  return joined.length > KNOWLEDGE_QUERY_MAX_CHARS
    ? joined.slice(-KNOWLEDGE_QUERY_MAX_CHARS)
    : joined
}
