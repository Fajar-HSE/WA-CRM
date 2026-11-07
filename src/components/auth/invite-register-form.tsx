'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import type { InvitationKind } from '@/lib/auth/peek-result';

const MIN_PASSWORD = 8;

/**
 * Registration form shown on /join/<token>. Sign-up is closed, so this is the
 * only way to get a login: it posts to the invitation-gated register
 * endpoint, then signs the new user in.
 */
export function InviteRegisterForm({
  token,
  kind,
}: {
  token: string;
  kind: InvitationKind;
}) {
  const t = useTranslations('JoinPage.register');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) {
      toast.error(t('passwordTooShort', { min: MIN_PASSWORD }));
      return;
    }
    if (password !== confirm) {
      toast.error(t('passwordsMismatch'));
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fullName, email, password }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(payload.error || t('failed'));
        setBusy(false);
        return;
      }

      const { error } = await createClient().auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) {
        toast.error(t('signInFailed'));
        setBusy(false);
        return;
      }

      // Full load so the auth provider reads the new profile and account.
      // A workspace owner goes straight to connecting their WhatsApp number;
      // a member lands back here and presses "Accept".
      window.location.href =
        kind === 'workspace'
          ? '/settings?tab=whatsapp'
          : `/join/${encodeURIComponent(token)}`;
    } catch (err) {
      console.error('[join] register error:', err);
      toast.error(t('failed'));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="reg-name" className="text-muted-foreground">
          {t('fullName')}
        </Label>
        <Input
          id="reg-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          maxLength={80}
          autoComplete="name"
          className="bg-muted border-border text-foreground"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="reg-email" className="text-muted-foreground">
          {t('email')}
        </Label>
        <Input
          id="reg-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          className="bg-muted border-border text-foreground"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="reg-password" className="text-muted-foreground">
          {t('password')}
        </Label>
        <PasswordInput
          id="reg-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD}
          autoComplete="new-password"
          placeholder={t('passwordPlaceholder', { min: MIN_PASSWORD })}
          className="bg-muted border-border text-foreground"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="reg-confirm" className="text-muted-foreground">
          {t('confirmPassword')}
        </Label>
        <PasswordInput
          id="reg-confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          autoComplete="new-password"
          className="bg-muted border-border text-foreground"
        />
      </div>
      <Button
        type="submit"
        disabled={busy}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {t('creating')}
          </>
        ) : (
          t('submit')
        )}
      </Button>
    </form>
  );
}
