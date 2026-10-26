import { useEffect, useRef, useState, type PointerEvent } from "react";
import { normaliseStrokes, SIGNATURE_BOX, type Stroke } from "@figbloom/shared";

type Point = { x: number; y: number };

/**
 * A box to sign in with a finger, pen or mouse. Reports the signature as
 * strokes in the shared signature box (signatures.ts), or null once cleared,
 * so the same mark draws the same way on screen and on a PDF.
 */
export function SignaturePad({ onChange, disabled }: { onChange: (strokes: Stroke[] | null) => void; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  // Sharp lines on high-density screens: the bitmap matches device pixels.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#14296B";
  }, []);

  function at(e: PointerEvent<HTMLCanvasElement>): Point {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = at(e);
    strokes.current.push([p]);
    const ctx = e.currentTarget.getContext("2d");
    ctx?.beginPath();
    ctx?.arc(p.x, p.y, 1.1, 0, Math.PI * 2);
    ctx?.stroke();
    setEmpty(false);
  }

  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const stroke = strokes.current[strokes.current.length - 1];
    const last = stroke?.[stroke.length - 1];
    if (!stroke || !last) return;
    const p = at(e);
    stroke.push(p);
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    const c = canvas.current;
    if (!c) return;
    const out = normaliseStrokes(strokes.current, c.clientWidth, c.clientHeight);
    onChange(out.length ? out : null);
  }

  function clear() {
    const c = canvas.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    strokes.current = [];
    setEmpty(true);
    onChange(null);
  }

  return (
    <div>
      <div className="relative rounded-md border border-[#D3DAD5] bg-white">
        <canvas
          ref={canvas}
          aria-label="Signature box: sign with your finger, a pen or the mouse"
          className="block w-full touch-none"
          style={{ aspectRatio: `${SIGNATURE_BOX.width} / ${SIGNATURE_BOX.height}`, cursor: disabled ? "default" : "crosshair" }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        <div className="pointer-events-none absolute inset-x-6 bottom-[22%] border-b border-dashed border-line" aria-hidden />
        {empty && <span className="pointer-events-none absolute left-6 top-3 text-[12px] text-ink-faint">Sign here</span>}
      </div>
      <div className="mt-1.5 flex justify-end">
        <button type="button" onClick={clear} disabled={disabled || empty} className="text-[12px] font-medium text-ink-muted underline disabled:opacity-40">
          Clear
        </button>
      </div>
    </div>
  );
}
