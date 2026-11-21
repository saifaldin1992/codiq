import { AlertCircle, LoaderCircle, PackageOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function LoadingState({ label = "جارٍ التحميل…" }: { label?: string }) {
  return (
    <div
      aria-live="polite"
      className="flex min-h-48 items-center justify-center gap-3 rounded-[26px] border border-[var(--storefront-border,#E4EBF5)] bg-[var(--storefront-surface,#fff)] p-7 text-sm font-semibold text-[var(--storefront-muted,#63748D)]"
    >
      <LoaderCircle className="h-5 w-5 animate-spin text-[var(--storefront-accent,#1769CF)]" />
      {label}
    </div>
  );
}
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <section className="rounded-[26px] border border-dashed border-[var(--storefront-border,#D6E0ED)] bg-[var(--storefront-surface,#fff)] p-9 text-center">
      <PackageOpen className="mx-auto h-8 w-8 text-[var(--storefront-muted,#83A4CD)]" />
      <h2 className="mt-4 font-black text-[var(--storefront-text,#2C4364)]">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-[var(--storefront-muted,#71819A)]">
        {detail}
      </p>
      {action ? (
        <Button
          type="button"
          variant="outline"
          className="mt-5 rounded-xl"
          onClick={action.onClick}
        >
          <RefreshCw className="ml-2 h-4 w-4" />
          {action.label}
        </Button>
      ) : null}
    </section>
  );
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <section
      role="alert"
      className="rounded-[24px] border border-[#F3D4D1] bg-[#FFF8F7] p-5 text-[#9D3E39]"
    >
      <div className="flex gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="font-bold">تعذر إتمام العملية</p>
          <p className="mt-1 text-sm leading-6">{message}</p>
          {retry ? (
            <Button
              type="button"
              variant="outline"
              className="mt-4 border-[#EFC7C3] bg-[var(--codiq-surface)] text-[#9D3E39]"
              onClick={retry}
            >
              إعادة المحاولة
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
