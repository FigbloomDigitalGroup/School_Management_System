import { CAPACITY_LABEL, SIGNATURE_BOX, signatureDate, strokeBounds, strokesToSvgPath, type StoredSignature } from "@figbloom/shared";

/** The mark alone: drawn strokes fitted to the space, or the typed name in a handwriting face. */
export function SignatureInk({ signature, height = 40 }: { signature: Pick<StoredSignature, "style" | "strokes" | "fullName">; height?: number }) {
  const b = signature.style === "drawn" && signature.strokes ? strokeBounds(signature.strokes) : null;
  if (b && signature.strokes) {
    const pad = 6;
    const w = b.width + pad * 2;
    const h = b.height + pad * 2;
    return (
      <svg
        role="img"
        aria-label={`Signature of ${signature.fullName}`}
        viewBox={`${-pad} ${-pad} ${w} ${h}`}
        style={{ height, width: Math.min(height * (w / h), height * (SIGNATURE_BOX.width / SIGNATURE_BOX.height)) }}
      >
        <path d={strokesToSvgPath(signature.strokes, { crop: true })} fill="none" stroke="#14296B" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <span className="italic text-[#14296B]" style={{ fontFamily: "'Segoe Script', 'Brush Script MT', cursive", fontSize: height * 0.55, lineHeight: `${height}px` }}>
      {signature.fullName}
    </span>
  );
}

/**
 * One signature as a family or the office sees it: the mark over the line,
 * then who, in what capacity, and when. A document changed since signing
 * says so, rather than looking signed.
 */
export function SignatureMark({ signature, onVoid }: { signature: StoredSignature; onVoid?: () => void }) {
  return (
    <div className="inline-flex min-w-[200px] flex-col">
      <div className="flex h-11 items-end border-b border-ink/40 pb-0.5">
        <SignatureInk signature={signature} />
      </div>
      <div className="mt-1 text-[12px] font-medium">{signature.fullName}</div>
      <div className="text-[11.5px] text-ink-faint">
        {CAPACITY_LABEL[signature.capacity]} · signed {signatureDate(signature.signedAt)}
      </div>
      {signature.isCurrent === false && (
        <div className="mt-0.5 text-[11.5px] font-medium text-warn-ink">Changed after signing: needs signing again</div>
      )}
      {onVoid && (
        <button type="button" onClick={onVoid} className="mt-1 self-start text-[11.5px] text-ink-muted underline">Void</button>
      )}
    </div>
  );
}
