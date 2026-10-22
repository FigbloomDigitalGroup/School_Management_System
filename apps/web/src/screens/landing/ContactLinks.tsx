import { useState, type MouseEvent, type ReactNode } from 'react';
import contactDetails, { emailLink, isPhone, phoneLink } from './contactDetails';

// Copies text to the clipboard and reports `copied` for two seconds.
function useCopy() {
  const [copied, setCopied] = useState(false);

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return [copied, copy] as const;
}

// Opens a new Gmail message to us in a new tab.
export function EmailLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <a className={className} href={emailLink()} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

// Dials on phones. Laptops can't place calls, so the number is copied instead.
// `children` is a function that receives whether the number was just copied.
export function CallLink({ className, children }: { className?: string; children: (copied: boolean) => ReactNode }) {
  const [copied, copy] = useCopy();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isPhone) return;
    event.preventDefault();
    copy(contactDetails.phone);
  };

  return (
    <a
      className={className}
      href={phoneLink}
      onClick={handleClick}
      title={isPhone ? undefined : 'Click to copy the number'}
    >
      {children(copied)}
    </a>
  );
}

// For visitors who don't use Gmail.
export function CopyEmailButton({ className }: { className?: string }) {
  const [copied, copy] = useCopy();

  return (
    <button className={className} onClick={() => copy(contactDetails.email)} type="button">
    </button>
  );
}
