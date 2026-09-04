import type { ReactNode } from "react";
import { signOf } from "@/lib/format";

/** Sınıf birleştirici — koşullu sınıflar için. */
export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

/**
 * Marka işareti — altın rengi bir madeni para ve içinde yukarı yönlü işaret.
 * Fotoğraf veya kişiye özel logo içermez. Renkler koyu zeminde de yeterli
 * kontrast versin diye vurgu renginden türetilir.
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <circle cx="256" cy="256" r="248" fill="var(--accent)" />
      <circle cx="256" cy="256" r="238" fill="none" stroke="var(--accent-contrast)" strokeWidth="14" opacity="0.35" />
      <path
        d="M148 300 256 192 364 300"
        fill="none"
        stroke="var(--accent-contrast)"
        strokeWidth="46"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M256 198 256 372"
        fill="none"
        stroke="var(--accent-contrast)"
        strokeWidth="46"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Card({
  children,
  className,
  as: Tag = "div",
  // JSX'te data-* nitelikleri fazlalık özellik denetiminden muaftır; açıkça
  // karşılamazsak sessizce DÜŞER ve test kancası DOM'a hiç ulaşmaz.
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
  "data-testid"?: string;
}) {
  return (
    <Tag className={cx("card", className)} data-testid={testId}>
      {children}
    </Tag>
  );
}

export function SectionTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "notice" | "danger" | "success";
  title?: string;
  children: ReactNode;
}) {
  // Kararlı test kimliği: Next.js'in kendi route announcer'ı da role="alert"
  // kullandığı için testler bu kimliği hedefler.
  const tones: Record<string, string> = {
    info: "border-line bg-surface-2 text-muted",
    notice: "border-[var(--notice-line)] bg-[var(--notice-soft)] text-[var(--notice)]",
    danger: "border-transparent bg-negative-soft text-negative",
    success: "border-transparent bg-positive-soft text-positive",
  };
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-testid={`alert-${tone}`}
      className={cx("rounded-[var(--radius)] border px-3.5 py-3 text-sm", tones[tone])}
    >
      {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
      <div className="[&_a]:underline">{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div
        aria-hidden="true"
        className="flex h-14 w-14 items-center justify-center rounded-full border border-dashed border-line-strong bg-surface-2"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" strokeWidth="1.6">
          <circle cx="12" cy="12" r="8.25" />
          <path d="M12 8.5v7M8.5 12h7" strokeLinecap="round" />
        </svg>
      </div>
      <div>
        <p className="text-base font-semibold text-ink">{title}</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  const hintId = `${htmlFor}-hint`;
  const errorId = `${htmlFor}-error`;
  return (
    <div>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={hintId} className="mt-1 text-xs text-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1 text-xs font-medium text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Kâr/zarar rakamlarını renk + işaretle gösterir; rengi tek bilgi taşıyıcı yapmaz. */
export function DeltaValue({
  value,
  formatted,
  suffix,
  className,
}: {
  value: string | number;
  formatted: string;
  suffix?: string;
  className?: string;
}) {
  const sign = signOf(value);
  const tone = sign > 0 ? "text-positive" : sign < 0 ? "text-negative" : "text-muted";
  return (
    <span className={cx("tabular font-semibold", tone, className)}>
      {formatted}
      {suffix ? <span className="ml-1 text-xs font-medium opacity-80">{suffix}</span> : null}
    </span>
  );
}

/**
 * PARASAL RAKAMIN PUNTOSU — METNİN UZUNLUĞUNA GÖRE.
 *
 * "₺8.958.184,32" (13 karakter) sabit puntoda kartı taşırıyor ve son
 * basamaklar görünmüyordu. Eksik okunan bir tutar, yanlış bir tutardır.
 *
 * Ölçüm/JS hilesi yok: karar yalnızca karakter sayısına bakar, bu yüzden
 * sunucu ve istemci render'ı aynı sonucu verir (hidrasyon uyuşmazlığı olmaz).
 * Eşikler Türkçe biçimlendirmeye göre seçildi:
 *   ₺123.456,78      → 11  (rahat)
 *   ₺8.958.184,32    → 13  (milyon)
 *   -₺1.129.215,66   → 14  (işaretli milyon)
 *   ₺123.456.789,01  → 15+ (yüz milyon)
 */
export function moneySizeClass(text: string, emphasis = false): string {
  const length = text.length;
  if (length >= 16) return emphasis ? "text-lg sm:text-xl" : "text-base sm:text-lg";
  if (length >= 13) return emphasis ? "text-xl sm:text-2xl" : "text-lg sm:text-xl";
  return emphasis ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl";
}
