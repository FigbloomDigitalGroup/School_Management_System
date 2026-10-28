import { createContext, useContext } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { parseMarkdown, safeHref, type AiChatSource, type Block, type Inline } from "@figbloom/shared";
import { t } from "../theme";

/** The answer's sources, for its [^n] markers. */
const SourcesContext = createContext<AiChatSource[]>([]);

const HEADING_SIZE = [0, 18, 16, 14.5, 13.5];
const open = (url: string) => { void Linking.openURL(url).catch(() => {}); };

/**
 * A Bloom reply's Markdown as native elements, built from parseMarkdown's tree
 * and never as anything a model could turn into a link target it chose: links
 * are http(s) and mailto only (safeHref). A [^n] marker opens the nth of
 * `sources` (already http(s) only, parseChatSources). Same tree the website renders.
 */
export function Markdown({ source, sources = [], tint }: { source: string; sources?: AiChatSource[]; tint: string }) {
  return (
    <SourcesContext.Provider value={sources}>
      <View style={{ gap: 8 }}>{parseMarkdown(source).map((b, i) => <BlockView key={i} block={b} tint={tint} />)}</View>
    </SourcesContext.Provider>
  );
}

function InlineView({ nodes, tint }: { nodes: Inline[]; tint: string }) {
  return <>{nodes.map((n, i) => <InlineNode key={i} node={n} tint={tint} />)}</>;
}

function InlineNode({ node, tint }: { node: Inline; tint: string }) {
  const sources = useContext(SourcesContext);
  switch (node.kind) {
    case "text":
      return <Text>{node.text}</Text>;
    case "code":
      return <Text style={{ fontFamily: "monospace", backgroundColor: t.appSurface.lineSoft }}>{node.text}</Text>;
    case "strong":
      return <Text style={{ fontWeight: "700" }}><InlineView nodes={node.children} tint={tint} /></Text>;
    case "em":
      return <Text style={{ fontStyle: "italic" }}><InlineView nodes={node.children} tint={tint} /></Text>;
    case "link": {
      const href = safeHref(node.href);
      return href
        ? <Text accessibilityRole="link" style={{ color: tint, textDecorationLine: "underline" }} onPress={() => open(href)}><InlineView nodes={node.children} tint={tint} /></Text>
        : <Text><InlineView nodes={node.children} tint={tint} /></Text>;
    }
    case "cite": {
      const src = sources[node.n - 1];
      return src?.url
        ? <Text accessibilityRole="link" accessibilityLabel={`Source ${node.n}: ${src.title}`} style={{ fontSize: 11, fontWeight: "700", color: tint }} onPress={() => open(src.url)}> [{node.n}]</Text>
        : <Text style={{ fontSize: 11, color: t.appSurface.inkFaint }}> [{node.n}]</Text>;
    }
    case "break":
      return <Text>{"\n"}</Text>;
  }
}

function BlockView({ block, tint }: { block: Block; tint: string }): JSX.Element {
  const body = { fontSize: 14.5, lineHeight: 22, color: t.appSurface.ink };
  switch (block.kind) {
    case "heading":
      return (
        <Text selectable style={{ ...body, fontSize: HEADING_SIZE[block.level], fontWeight: "600", marginTop: 4 }}>
          <InlineView nodes={block.children} tint={tint} />
        </Text>
      );
    case "paragraph":
      return <Text selectable style={body}><InlineView nodes={block.children} tint={tint} /></Text>;
    case "code":
      return (
        <ScrollView horizontal style={{ borderRadius: 8, backgroundColor: t.appSurface.lineSoft }} contentContainerStyle={{ padding: 10 }}>
          <Text selectable style={{ fontFamily: "monospace", fontSize: 12.5, color: t.appSurface.ink }}>{block.text}</Text>
        </ScrollView>
      );
    case "rule":
      return <View style={{ height: 1, backgroundColor: t.appSurface.line }} />;
    case "quote":
      return (
        <View style={{ gap: 6, borderLeftWidth: 3, borderLeftColor: t.appSurface.line, paddingLeft: 10 }}>
          {block.children.map((b, i) => <BlockView key={i} block={b} tint={tint} />)}
        </View>
      );
    case "list":
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 6 }}>
              <Text style={{ ...body, width: 24, textAlign: "right", color: t.appSurface.inkMuted }}>{block.ordered ? `${block.start + i}.` : "•"}</Text>
              <View style={{ flex: 1, gap: 4 }}>{item.map((b, j) => <BlockView key={j} block={b} tint={tint} />)}</View>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View style={{ borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 8, overflow: "hidden" }}>
            {[block.head, ...block.rows].map((row, r) => (
              <View key={r} style={{ flexDirection: "row", backgroundColor: r === 0 ? t.appSurface.lineSoft : undefined, borderTopWidth: r === 0 ? 0 : 1, borderTopColor: t.appSurface.line }}>
                {row.map((cell, c) => (
                  <View key={c} style={{ minWidth: 96, maxWidth: 220, padding: 8 }}>
                    <Text selectable style={{ fontSize: 13, color: t.appSurface.ink, fontWeight: r === 0 ? "700" : "400", textAlign: block.align[c] ?? "left" }}>
                      <InlineView nodes={cell} tint={tint} />
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
  }
}
