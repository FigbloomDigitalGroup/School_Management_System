import { useState, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@figbloom/shared";

/**
 * A Bloom reply's Markdown as React elements. Built from parseMarkdown's tree,
 * never dangerouslySetInnerHTML: whatever a model writes stays text.
 */
export function Markdown({ source }: { source: string }) {
  return <div className="flex flex-col gap-3 text-[13.5px] leading-relaxed">{parseMarkdown(source).map((b, i) => <BlockView key={i} block={b} />)}</div>;
}

const HEADING_CLASS = ["", "text-[18px] font-semibold", "text-[16px] font-semibold", "text-[14.5px] font-semibold", "text-[13.5px] font-semibold"];

function BlockView({ block }: { block: Block }): JSX.Element {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${block.level + 1}` as "h2" | "h3" | "h4" | "h5";
      return <Tag className={`${HEADING_CLASS[block.level]} mt-1 tracking-tight`}><InlineView nodes={block.children} /></Tag>;
    }
    case "paragraph":
      return <p><InlineView nodes={block.children} /></p>;
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} />;
    case "rule":
      return <hr className="border-line" />;
    case "quote":
      return <blockquote className="flex flex-col gap-2 border-l-[3px] border-line pl-3 text-ink-muted">{block.children.map((b, i) => <BlockView key={i} block={b} />)}</blockquote>;
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className="pl-1">
          <div className="flex flex-col gap-1.5">{item.map((b, j) => <BlockView key={j} block={b} />)}</div>
        </li>
      ));
      return block.ordered
        ? <ol start={block.start} className="flex list-decimal flex-col gap-1 pl-5 marker:text-ink-faint">{items}</ol>
        : <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-ink-faint">{items}</ul>;
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-sunken">
              <tr>{block.head.map((h, i) => <th key={i} className="border-b border-line px-3 py-2 font-semibold" style={{ textAlign: block.align[i] ?? "left" }}><InlineView nodes={h} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i} className="border-b border-line-soft last:border-0">
                  {r.map((c, j) => <td key={j} className="px-3 py-2 align-top" style={{ textAlign: block.align[j] ?? "left" }}><InlineView nodes={c} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function InlineView({ nodes }: { nodes: Inline[] }): JSX.Element {
  return <>{nodes.map((n, i) => <InlineNode key={i} node={n} />)}</>;
}

function InlineNode({ node }: { node: Inline }): ReactNode {
  switch (node.kind) {
    case "text": return node.text;
    case "break": return <br />;
    case "code": return <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[12px]">{node.text}</code>;
    case "strong": return <strong className="font-semibold"><InlineView nodes={node.children} /></strong>;
    case "em": return <em><InlineView nodes={node.children} /></em>;
    case "link": return <a href={node.href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2"><InlineView nodes={node.children} /></a>;
  }
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the text is still there to select */ }
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-[#0F1A14] text-[#E4EBE6]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-[11px] text-white/60">
        <span className="font-mono">{lang || "code"}</span>
        <button type="button" onClick={() => void copy()} className="rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-white">
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed"><code>{text}</code></pre>
    </div>
  );
}
