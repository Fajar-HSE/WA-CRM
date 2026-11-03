'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { fetchAccountTemplates } from '@/lib/settings/account-catalog';
import { isLocalTemplateId } from '@/lib/whatsapp/local-template';
import { renderTemplateBody } from '@/lib/whatsapp/template-body';
import {
  TEMPLATE_LIMITS,
  extractTemplateVariables,
} from '@/lib/whatsapp/template-validators';
import type { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';

// Templates are saved on this server only. WAHA has no template review, so
// a saved template is usable at once in broadcasts, the inbox and automations.
// The language is fixed: WAHA ignores it, but the column is part of the key.
const TEMPLATE_LANGUAGE = 'id';
const TEMPLATE_CATEGORY = 'Utility' as const;
const NAME_RE = /[^a-z0-9_]+/g;

interface FormState {
  name: string;
  body: string;
  footer: string;
  samples: Record<string, string>;
}

const EMPTY_FORM: FormState = { name: '', body: '', footer: '', samples: {} };

/** `Sambutan Baru!` → `sambutan_baru`: the name rules are lowercase, digits, underscore. */
function toTemplateName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(NAME_RE, '')
    .slice(0, 80);
}

export function TemplateManager() {
  const t = useTranslations('Settings.templates');
  const supabase = useMemo(() => createClient(), []);
  const { accountId, canEditSettings, loading: authLoading, profileLoading } = useAuth();

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MessageTemplate | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      setTemplates(await fetchAccountTemplates(supabase, accountId));
    } catch (err) {
      console.error('Failed to fetch templates:', err);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [accountId, supabase, t]);

  useEffect(() => {
    if (authLoading || profileLoading || !accountId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-open: the loader sets the list
    void load();
  }, [authLoading, profileLoading, accountId, load]);

  // Placeholders found in the body, in the order they first appear.
  const variables = useMemo(
    () => (form.body ? extractTemplateVariables(form.body) : []),
    [form.body],
  );

  const preview = useMemo(
    () =>
      form.body
        ? renderTemplateBody(
            form.body,
            variables.map((v) => form.samples[v]?.trim() || t('sampleFallback')),
          )
        : '',
    [form.body, form.samples, variables, t],
  );

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(template: MessageTemplate) {
    const stored = template.sample_values?.body ?? [];
    const keys = extractTemplateVariables(template.body_text);
    setEditing(template);
    setForm({
      name: template.name,
      body: template.body_text,
      footer: template.footer_text ?? '',
      samples: Object.fromEntries(keys.map((k, i) => [k, stored[i] ?? ''])),
    });
    setDialogOpen(true);
  }

  function addVariable() {
    // Next positional number after the highest one already in the text.
    const used = variables.map((v) => Number(v)).filter((n) => Number.isInteger(n));
    const next = (used.length ? Math.max(...used) : 0) + 1;
    setForm((f) => ({ ...f, body: `${f.body}{{${next}}}` }));
  }

  async function handleSave() {
    const name = editing ? editing.name : toTemplateName(form.name);
    const body = form.body.trim();
    if (!name) {
      toast.error(t('nameRequired'));
      return;
    }
    if (!body) {
      toast.error(t('bodyRequired'));
      return;
    }

    const bodySamples = variables.map((v) => form.samples[v]?.trim() || t('sampleFallback'));
    const payload = {
      name,
      category: TEMPLATE_CATEGORY,
      language: editing?.language ?? TEMPLATE_LANGUAGE,
      body_text: body,
      footer_text: form.footer.trim() || undefined,
      sample_values: bodySamples.length ? { body: bodySamples } : undefined,
    };

    setSaving(true);
    try {
      const res = await fetch(
        editing ? `/api/whatsapp/templates/${editing.id}` : '/api/whatsapp/templates/submit',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || t('saveFailed'));
      toast.success(t(editing ? 'updated' : 'saved'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(template: MessageTemplate) {
    if (!window.confirm(t('deleteConfirm', { name: template.name }))) return;
    setDeletingId(template.id);
    try {
      const res = await fetch(`/api/whatsapp/templates/${template.id}`, { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || t('deleteFailed'));
      toast.success(t('deleted'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="max-w-3xl space-y-6 animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          canEditSettings ? (
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              {t('newTemplate')}
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('loading')}
        </div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {templates.map((template) => {
            const count = extractTemplateVariables(template.body_text).length;
            const editable = isLocalTemplateId(template.meta_template_id);
            return (
              <Card key={template.id}>
                <CardContent className="flex items-start justify-between gap-3 pt-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-foreground">{template.name}</h3>
                      {count > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {t('variableCount', { count })}
                        </Badge>
                      )}
                    </div>
                    <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
                      {template.body_text}
                    </p>
                  </div>
                  {canEditSettings && (
                    <div className="flex shrink-0 gap-1">
                      {editable && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(template)}
                          aria-label={t('edit')}
                          title={t('edit')}
                        >
                          <Pencil className="size-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(template)}
                        disabled={deletingId === template.id}
                        aria-label={t('delete')}
                        title={t('delete')}
                      >
                        {deletingId === template.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t(editing ? 'dialogEditTitle' : 'dialogNewTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('dialogDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name" className="text-muted-foreground">
                {t('nameLabel')}
              </Label>
              <Input
                id="tpl-name"
                value={editing ? editing.name : form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                disabled={!!editing}
                placeholder={t('namePlaceholder')}
                className="bg-muted border-border text-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {editing
                  ? t('nameFixed')
                  : form.name.trim()
                    ? t('nameWillBe', { name: toTemplateName(form.name) || '…' })
                    : t('nameHint')}
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="tpl-body" className="text-muted-foreground">
                  {t('bodyLabel')}
                </Label>
                <Button type="button" variant="outline" size="sm" onClick={addVariable}>
                  <Plus className="size-3.5" />
                  {t('addVariable')}
                </Button>
              </div>
              <Textarea
                id="tpl-body"
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                maxLength={TEMPLATE_LIMITS.bodyMaxLength}
                rows={5}
                className="bg-muted border-border text-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('bodyHint')} <code>{'{{1}}'}</code>, <code>{'{{2}}'}</code>
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tpl-footer" className="text-muted-foreground">
                {t('footerLabel')}
              </Label>
              <Input
                id="tpl-footer"
                value={form.footer}
                onChange={(e) => setForm((f) => ({ ...f, footer: e.target.value }))}
                maxLength={TEMPLATE_LIMITS.footerMaxLength}
                className="bg-muted border-border text-foreground"
              />
            </div>

            {variables.length > 0 && (
              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('samplesLabel')}</Label>
                {variables.map((v) => (
                  <div key={v} className="flex items-center gap-2">
                    <code className="w-14 shrink-0 text-xs text-muted-foreground">{`{{${v}}}`}</code>
                    <Input
                      value={form.samples[v] ?? ''}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, samples: { ...f.samples, [v]: e.target.value } }))
                      }
                      placeholder={t('samplePlaceholder')}
                      className="bg-muted border-border text-foreground"
                    />
                  </div>
                ))}
              </div>
            )}

            {preview && (
              <div className="space-y-1.5">
                <Label className="text-muted-foreground">{t('previewLabel')}</Label>
                <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-sm text-foreground">
                  {preview}
                  {form.footer.trim() && (
                    <span className="mt-2 block text-xs text-muted-foreground">{form.footer.trim()}</span>
                  )}
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('save')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
