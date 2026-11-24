import { useMemo } from "react";
import { encodeQrMatrix } from "@figbloom/shared";

/**
 * Renders a scannable QR code as inline SVG with a standard 4-module quiet zone (FIG-1890).
 * Falls back to null if the payload exceeds our encoder's capacity (the manual setup key is always shown).
 */
export function QrCodeSvg({ value, size = 176, label = "Authenticator QR code" }: { value: string; size?: number; label?: string }) {
  const path = useMemo(() => {
    try {
      const { size: n, modules } = encodeQrMatrix(value);
      const quiet = 4;
      const parts: string[] = [];
      for (let r = 0; r < n; r++) {
        const row = modules[r]!;
        for (let c = 0; c < n; c++) {
          if (row[c]) parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
        }
      }
      return { viewBoxSize: n + quiet * 2, d: parts.join("") };
    } catch {
      return null;
    }
  }, [value]);

  if (!path) return null;

  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="mfa-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${path.viewBoxSize} ${path.viewBoxSize}`}
      shapeRendering="crispEdges"
      className="rounded-lg border border-line bg-white p-1"
    >
      <rect width={path.viewBoxSize} height={path.viewBoxSize} fill="#ffffff" />
      <path d={path.d} fill="#111827" />
    </svg>
  );
}
