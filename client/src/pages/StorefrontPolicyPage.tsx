/**
 * ق-199 / ق-211 — a written page of the store, as the footer links to it.
 *
 * TWO sources, one screen: `/policies/:kind` reads one of the three policies the
 * checkout screen also names, and `/pages/:slug` reads one of the pages the
 * merchant wrote himself («من نحن», «اتفاقية المستخدم», whatever his shop needed
 * to say). Both answer with a title and a body, so both are drawn here — a second
 * component would have been the same prose twice.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { ArrowRight, FileText } from "lucide-react";
import { ErrorState, LoadingState } from "@/components/StorefrontStates";
import { useStorefront } from "@/components/StorefrontProvider";
import { errorMessage, PolicyKind, storefrontApi } from "@/lib/storefront-api";

export default function StorefrontPolicyPage() {
  const { storeSlug, kind, pageSlug } = useParams<{
    storeSlug: string;
    kind?: string;
    pageSlug?: string;
  }>();
  const { config } = useStorefront();
  const [document, setDocument] = useState<{ title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setError(null);
    const request = pageSlug
      ? storefrontApi.page(storeSlug, pageSlug).then((data) => data.page)
      : storefrontApi.policy(storeSlug, kind as PolicyKind).then((data) => data.policy);
    request
      .then((loaded) => {
        if (!cancelled) setDocument(loaded);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [storeSlug, kind, pageSlug]);
  if (error) return <ErrorState message={error} />;
  if (!document) return <LoadingState label="جارٍ تحميل الصفحة…" />;
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Link
        href={`/store/${storeSlug}`}
        className="inline-flex items-center gap-2 text-sm font-bold text-[var(--storefront-accent)] hover:underline"
      >
        <ArrowRight className="h-4 w-4" />
        العودة إلى {config?.name ?? "المتجر"}
      </Link>
      <header className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--storefront-accent-soft)] text-[var(--storefront-accent)]">
          <FileText className="h-5 w-5" />
        </span>
        <h1 className="text-2xl font-black text-[var(--storefront-text)] sm:text-3xl">
          {document.title}
        </h1>
      </header>
      <div className="rounded-[26px] border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-6 sm:p-8">
        {document.body.split(/\n{2,}/).map((paragraph, index) => (
          <p
            key={index}
            className="whitespace-pre-line text-sm leading-8 text-[var(--storefront-text)] [&:not(:first-child)]:mt-4"
          >
            {paragraph}
          </p>
        ))}
      </div>
    </article>
  );
}
