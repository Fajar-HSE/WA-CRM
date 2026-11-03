"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MailX } from "lucide-react";

// Sign-up is closed: an account can only be created from an invitation
// (POST /api/invitations/<token>/register). A visitor who still arrives here
// with an invite token is passed on to the invitation page; everyone else is
// told how it works. `useSearchParams` needs Suspense, same as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("SignupPage");

  useEffect(() => {
    if (inviteToken) router.replace(`/join/${encodeURIComponent(inviteToken)}`);
  }, [inviteToken, router]);

  if (inviteToken) return null;

  return (
    <Card className="w-full max-w-md border-border bg-card">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <MailX className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-xl text-foreground">
          {t("inviteOnlyTitle")}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t("inviteOnlyBody")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/login">
          <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
            {t("signIn")}
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
