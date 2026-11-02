'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2, QrCode, Power, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface Props {
  accountId: string | null;
  sessionName: string;
  onSessionNameChange: (name: string) => void;
}

export function WahaPairing({ accountId, sessionName, onSessionNameChange }: Props) {
  const [status, setStatus] = useState<string>('unknown');
  const [qr, setQr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionName) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/waha/session?name=${encodeURIComponent(sessionName)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed');
      setStatus(data.status || 'unknown');
      setQr(data.qr || null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [sessionName]);

  useEffect(() => {
    if (sessionName) refresh();
  }, [sessionName, refresh]);

  async function start() {
    if (!sessionName) {
      toast.error('Session name required');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/waha/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sessionName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed');
      setStatus(data.status || 'unknown');
      setQr(data.qr || null);
      toast.success('Session started');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    if (!sessionName) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/waha/session?name=${encodeURIComponent(sessionName)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed');
      setStatus('logged_out');
      setQr(null);
      toast.success('Logged out');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground text-base">WAHA Pairing (unofficial)</CardTitle>
        <CardDescription className="text-muted-foreground">
          Start a session and scan the QR code with WhatsApp.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-muted-foreground">Session name</Label>
          <Input
            value={sessionName}
            onChange={(e) => onSessionNameChange(e.target.value)}
            placeholder="wacrm-<account>-<user>"
            className="bg-muted border-border text-foreground"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={start} disabled={loading || !sessionName} size="sm">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />}
            Start
          </Button>
          <Button onClick={refresh} disabled={loading || !sessionName} variant="outline" size="sm">
            <RefreshCw className="size-4" />
            Refresh
          </Button>
          <Button onClick={logout} disabled={loading || !sessionName} variant="outline" size="sm">
            Logout
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          Status: <code>{status}</code>
        </p>

        {qr && (
          <div className="flex justify-center">
            <img src={qr} alt="QR Code" className="max-w-[260px] rounded border border-border" />
          </div>
        )}
        {!qr && status === 'SCAN_QR_CODE' && (
          <div className="flex justify-center text-muted-foreground">
            <QrCode className="size-10" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
