import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

interface Wrap {
  label: string;
  hint?: string;
  /** Shown in warn ink under the control, with an icon. Never a bare "Invalid". */
  error?: string;
  children: ReactNode;
  id: string;
}

function Wrapper({ label, hint, error, children, id }: Wrap) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-small font-semibold">{label}</label>
      {children}
      {error ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-warn-ink">
          <span aria-hidden>✕</span>{error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

const BASE =
  "w-full rounded-md border border-[#D3DAD5] px-3 py-2.5 font-sans text-body outline-none focus:border-forest";

export function TextField({ label, hint, error, id, mono, ...rest }: Wrap extends never ? never : Omit<Wrap, "children"> & InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <Wrapper label={label} hint={hint} error={error} id={id}>
      <input
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`${BASE} ${mono ? "font-mono text-[13px]" : ""} ${error ? "border-warn-ink" : ""}`}
        {...rest}
      />
    </Wrapper>
  );
}

export function SelectField({ label, hint, error, id, options, ...rest }: Omit<Wrap, "children"> & SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  return (
    <Wrapper label={label} hint={hint} error={error} id={id}>
      <select id={id} className={`${BASE} bg-white`} {...rest}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Wrapper>
  );
}

export function TextArea({ label, hint, error, id, ...rest }: Omit<Wrap, "children"> & InputHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Wrapper label={label} hint={hint} error={error} id={id}>
      <textarea id={id} rows={4} className={`${BASE} resize-y`} {...rest} />
    </Wrapper>
  );
}
