// ============================================================
// Write tools — registered only when WA_CRM_ENABLE_WRITES is set.
//
// These change data or send a WhatsApp message. They are gated so a
// read-only deployment never exposes them to the model at all. (The
// API key's scopes are still enforced server-side; a call without the
// right scope returns a clean `forbidden` error.)
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WaCrmClient } from '../client.js';
import { handle, jsonResult } from './shared.js';

const templateSchema = z
  .object({
    name: z.string().describe('Meta-approved template name.'),
    language: z.string().describe('Template language code, e.g. "en_US".'),
    params: z
      .array(z.string())
      .optional()
      .describe('Positional body variables, in order.'),
  })
  .describe('Template payload — required when type is "template".');

export function registerWriteTools(server: McpServer, client: WaCrmClient): void {
  server.registerTool(
    'send_message',
    {
      title: 'Send WhatsApp message',
      description:
        'Send a WhatsApp message to a phone number (E.164, e.g. +14155550123). The contact and conversation are found-or-created automatically. Use type "text" for a free-form message (only valid inside the 24-hour customer-service window), or "template" to send an approved template (required to open a new conversation). Media types (image/video/document/audio) require a media_url. This sends a real message to a real person — confirm the recipient and content with the user before calling.',
      inputSchema: {
        to: z.string().describe('Recipient phone number in E.164 format, e.g. +14155550123.'),
        type: z
          .enum(['text', 'template', 'image', 'video', 'document', 'audio'])
          .default('text')
          .describe('Message type. Defaults to "text".'),
        text: z
          .string()
          .optional()
          .describe('Message body for "text", or the caption for a media type.'),
        media_url: z
          .string()
          .url()
          .optional()
          .describe('Publicly reachable URL of the media file (required for media types).'),
        filename: z.string().optional().describe('File name for a "document" send.'),
        template: templateSchema.optional(),
        reply_to_message_id: z
          .string()
          .optional()
          .describe('Optional id of a message in the same conversation to reply to.'),
      },
      annotations: { title: 'Send WhatsApp message', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.sendMessage(args))),
  );

  server.registerTool(
    'create_contact',
    {
      title: 'Create contact',
      description:
        'Create a contact by phone number (E.164, required). Find-or-create: if a contact with that phone already exists, its name, email and company are left unchanged and any tags you pass are added to the tags it already has (none are removed). Optional: name, email, company, and tags (tag names, created if missing).',
      inputSchema: {
        phone: z.string().describe('Phone number in E.164 format, e.g. +14155550123.'),
        name: z.string().optional(),
        email: z.string().email().optional(),
        company: z.string().optional(),
        tags: z.array(z.string()).optional().describe('Tag names; created if they do not exist. Added to an existing contact’s tags, never replacing them.'),
      },
      annotations: { title: 'Create contact', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createContact(args))),
  );

  server.registerTool(
    'update_contact',
    {
      title: 'Update contact',
      description:
        'Update an existing contact. Only the fields you pass are changed. Pass tags (an array of tag names) to replace the contact’s tags entirely.',
      inputSchema: {
        id: z.string().describe('Contact id.'),
        name: z.string().optional(),
        email: z.string().email().optional(),
        company: z.string().optional(),
        tags: z.array(z.string()).optional().describe('Replaces the contact’s tags.'),
      },
      annotations: { title: 'Update contact', readOnlyHint: false, openWorldHint: true },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateContact(id, body))),
  );

  server.registerTool(
    'add_knowledge_document',
    {
      title: 'Add knowledge-base document',
      description:
        'Add a document to the AI assistant knowledge base. The assistant answers customers from these documents, so write plain, factual text (one topic per document, at most 100,000 characters) and never include secrets or private customer data. The text is chunked and indexed automatically. Set replace_existing to true to update the document with the same title instead of creating a duplicate (safe to re-run). Check the returned index_status: "indexed" is fully searchable, "keyword_only" works for keyword search only, "not_indexed" means it was saved but is not searchable yet.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Short document title, e.g. "Sertifikasi GIS - Biaya".'),
        content: z.string().min(1).max(100000).describe('The document text.'),
        replace_existing: z
          .boolean()
          .optional()
          .describe('If a document with this title exists, replace its content instead of adding a new one.'),
      },
      annotations: { title: 'Add knowledge-base document', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createKnowledgeDocument(args))),
  );

  server.registerTool(
    'update_knowledge_document',
    {
      title: 'Update knowledge-base document',
      description:
        'Change the title and/or text of an existing knowledge-base document. Only the fields you pass are changed; the text is re-indexed when it changes. This changes what the AI assistant tells customers.',
      inputSchema: {
        id: z.string().describe('Document id.'),
        title: z.string().min(1).max(200).optional(),
        content: z.string().min(1).max(100000).optional(),
      },
      annotations: { title: 'Update knowledge-base document', readOnlyHint: false, openWorldHint: true },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateKnowledgeDocument(id, body))),
  );

  server.registerTool(
    'delete_knowledge_document',
    {
      title: 'Delete knowledge-base document',
      description:
        'Permanently delete a knowledge-base document and its indexed chunks. The AI assistant stops using it immediately. Confirm with the user before calling.',
      inputSchema: {
        id: z.string().describe('Document id.'),
      },
      annotations: {
        title: 'Delete knowledge-base document',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    handle(async ({ id }) => jsonResult(await client.deleteKnowledgeDocument(id))),
  );

  server.registerTool(
    'create_template',
    {
      title: 'Create message template',
      description:
        'Create a WhatsApp message template. For WAHA accounts the template is saved locally and usable immediately (status APPROVED). For Meta accounts it is submitted for approval. Body supports {{1}}, {{2}} positional variables (must be contiguous) and named variables. Confirm content with the user before calling.',
      inputSchema: {
        name: z.string().min(1).describe('Template name (lowercase letters, digits, underscores).'),
        category: z.enum(['Marketing', 'Utility', 'Authentication']).default('Utility').describe('Template category.'),
        language: z.string().default('id').describe('Language code, e.g. "id" or "en_US".'),
        body_text: z.string().min(1).max(1024).describe('Template body text. Use {{1}}, {{2}} for variables.'),
        footer_text: z.string().max(60).optional().describe('Optional footer text (no variables).'),
        header_type: z.enum(['text', 'image', 'video', 'document']).optional().describe('Optional header type.'),
        header_content: z.string().max(60).optional().describe('Header text (required if header_type is text).'),
        sample_values: z
          .object({ body: z.array(z.string()).optional(), header: z.array(z.string()).optional() })
          .optional()
          .describe('Sample values for variables, 1:1 with placeholders.'),
      },
      annotations: { title: 'Create message template', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createTemplate(args))),
  );

  server.registerTool(
    'update_template',
    {
      title: 'Update message template',
      description:
        'Update an existing message template. For local (WAHA) templates the body/footer/samples change and it stays usable. For Meta templates the edited version is re-submitted for approval. Only the fields you pass are changed.',
      inputSchema: {
        id: z.string().describe('Template id.'),
        body_text: z.string().min(1).max(1024).optional(),
        footer_text: z.string().max(60).optional(),
        header_type: z.enum(['text', 'image', 'video', 'document']).optional(),
        header_content: z.string().max(60).optional(),
        sample_values: z
          .object({ body: z.array(z.string()).optional(), header: z.array(z.string()).optional() })
          .optional(),
        category: z.enum(['Marketing', 'Utility', 'Authentication']).optional(),
      },
      annotations: { title: 'Update message template', readOnlyHint: false, openWorldHint: true },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateTemplate(id, body))),
  );

  server.registerTool(
    'delete_template',
    {
      title: 'Delete message template',
      description:
        'Permanently delete a message template. For Meta templates the template is also removed from Meta. Confirm with the user before calling.',
      inputSchema: {
        id: z.string().describe('Template id.'),
      },
      annotations: {
        title: 'Delete message template',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    handle(async ({ id }) => jsonResult(await client.deleteTemplate(id))),
  );

  // --- Pipelines & Deals (write) ---

  server.registerTool(
    'create_pipeline',
    {
      title: 'Create pipeline',
      description: 'Create a sales pipeline. Optionally pass initial stages (array of {name, position, color}).',
      inputSchema: {
        name: z.string().min(1).describe('Pipeline name.'),
        stages: z
          .array(z.object({ name: z.string(), position: z.number().optional(), color: z.string().optional() }))
          .optional()
          .describe('Initial stages.'),
      },
      annotations: { title: 'Create pipeline', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createPipeline(args))),
  );

  server.registerTool(
    'update_pipeline',
    {
      title: 'Update pipeline',
      description: 'Rename a pipeline and/or upsert its stages.',
      inputSchema: {
        id: z.string().describe('Pipeline id.'),
        name: z.string().optional().describe('New name.'),
        stages: z
          .array(z.object({ id: z.string().optional(), name: z.string(), position: z.number().optional(), color: z.string().optional() }))
          .optional()
          .describe('Stages to upsert (existing by id, new otherwise).'),
      },
      annotations: { title: 'Update pipeline', readOnlyHint: false, openWorldHint: true },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updatePipeline(id, body))),
  );

  server.registerTool(
    'delete_pipeline',
    {
      title: 'Delete pipeline',
      description: 'Delete a pipeline (cascades to its stages and deals). Confirm with the user before calling.',
      inputSchema: { id: z.string().describe('Pipeline id.') },
      annotations: { title: 'Delete pipeline', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handle(async ({ id }) => jsonResult(await client.deletePipeline(id))),
  );

  server.registerTool(
    'create_deal',
    {
      title: 'Create deal',
      description: 'Create a deal in a pipeline stage. pipeline_id and stage_id are required.',
      inputSchema: {
        title: z.string().min(1).describe('Deal title.'),
        pipeline_id: z.string().describe('Pipeline id.'),
        stage_id: z.string().describe('Stage id.'),
        contact_id: z.string().describe('Contact id (required).'),
        conversation_id: z.string().optional().describe('Conversation id.'),
        value: z.number().optional().describe('Deal value.'),
        currency: z.string().optional().describe('Currency code (default USD).'),
        notes: z.string().optional(),
        expected_close_date: z.string().optional().describe('ISO date (YYYY-MM-DD).'),
        status: z.string().optional().describe('Status (default active).'),
      },
      annotations: { title: 'Create deal', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createDeal(args))),
  );

  server.registerTool(
    'update_deal',
    {
      title: 'Update deal',
      description: 'Update a deal (move stage, change value, status, notes, etc.).',
      inputSchema: {
        id: z.string().describe('Deal id.'),
        title: z.string().optional(),
        stage_id: z.string().optional().describe('Move to this stage.'),
        pipeline_id: z.string().optional(),
        value: z.number().optional(),
        currency: z.string().optional(),
        notes: z.string().optional(),
        expected_close_date: z.string().optional(),
        status: z.string().optional(),
      },
      annotations: { title: 'Update deal', readOnlyHint: false, openWorldHint: true },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateDeal(id, body))),
  );

  server.registerTool(
    'delete_deal',
    {
      title: 'Delete deal',
      description: 'Delete a deal. Confirm with the user before calling.',
      inputSchema: { id: z.string().describe('Deal id.') },
      annotations: { title: 'Delete deal', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handle(async ({ id }) => jsonResult(await client.deleteDeal(id))),
  );

  // --- Conversations (write) ---

  server.registerTool(
    'update_conversation',
    {
      title: 'Update conversation',
      description: 'Update a conversation: status (open/pending/closed), assigned_agent_id, unread_count.',
      inputSchema: {
        id: z.string().describe('Conversation id.'),
        status: z.enum(['open', 'pending', 'closed']).optional(),
        assigned_agent_id: z.string().nullable().optional().describe('Agent user id, or null to unassign.'),
        unread_count: z.number().int().min(0).optional(),
      },
      annotations: { title: 'Update conversation', readOnlyHint: false, openWorldHint: true },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateConversation(id, body))),
  );

  // --- Tags (write) ---

  server.registerTool(
    'create_tag',
    {
      title: 'Create tag',
      description: 'Create a tag (name + optional color).',
      inputSchema: {
        name: z.string().min(1).describe('Tag name.'),
        color: z.string().optional().describe('Hex color, e.g. #3b82f6.'),
      },
      annotations: { title: 'Create tag', readOnlyHint: false, openWorldHint: true },
    },
    handle(async (args) => jsonResult(await client.createTag(args))),
  );

  server.registerTool(
    'update_tag',
    {
      title: 'Update tag',
      description: 'Rename a tag or change its color.',
      inputSchema: {
        id: z.string().describe('Tag id.'),
        name: z.string().optional(),
        color: z.string().optional(),
      },
      annotations: { title: 'Update tag', readOnlyHint: false, openWorldHint: true },
    },
    handle(async ({ id, ...body }) => jsonResult(await client.updateTag(id, body))),
  );

  server.registerTool(
    'delete_tag',
    {
      title: 'Delete tag',
      description: 'Delete a tag. Confirm with the user before calling.',
      inputSchema: { id: z.string().describe('Tag id.') },
      annotations: { title: 'Delete tag', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handle(async ({ id }) => jsonResult(await client.deleteTag(id))),
  );
}
