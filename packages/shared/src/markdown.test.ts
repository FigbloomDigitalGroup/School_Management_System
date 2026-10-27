import { describe, expect, it } from "vitest";
import { inlineText, parseInline, parseMarkdown, safeHref } from "./markdown";
import { chatTitleFrom, parseChatSources, sourceHost } from "./aiChat";

describe("parseMarkdown", () => {
  it("reads headings, paragraphs and rules", () => {
    const blocks = parseMarkdown("# Lesson plan\n\nIntro line one\nline two\n\n---\n#### Small");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "rule", "heading"]);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1 });
    expect(blocks[3]).toMatchObject({ kind: "heading", level: 4 });
    const p = blocks[1]!;
    expect(p.kind === "paragraph" && p.children.map((c) => c.kind)).toEqual(["text", "break", "text"]);
  });

  it("keeps fenced code exactly, with its language, even when unclosed", () => {
    const [code] = parseMarkdown("```python\nfor i in range(3):\n    print(**i)\n```");
    expect(code).toEqual({ kind: "code", lang: "python", text: "for i in range(3):\n    print(**i)" });
    expect(parseMarkdown("```\nopen")[0]).toEqual({ kind: "code", lang: "", text: "open" });
  });

  it("reads bulleted and numbered lists, with nesting and a start number", () => {
    const [list] = parseMarkdown("3. Starter\n4. Main\n   - group work\n   - feedback\n5. Plenary");
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 3 });
    if (list?.kind !== "list") throw new Error("not a list");
    expect(list.items).toHaveLength(3);
    expect(list.items[1]!.map((b) => b.kind)).toEqual(["paragraph", "list"]);
    const [bullets] = parseMarkdown("- one\n- two");
    expect(bullets).toMatchObject({ kind: "list", ordered: false });
  });

  it("reads a table with alignment, padding short rows", () => {
    const [t] = parseMarkdown("| Grade | Marks |\n|:--|--:|\n| A | 80 - 100 |\n| B |");
    if (t?.kind !== "table") throw new Error("not a table");
    expect(t.align).toEqual(["left", "right"]);
    expect(t.head.map(inlineText)).toEqual(["Grade", "Marks"]);
    expect(t.rows.map((r) => r.map(inlineText))).toEqual([["A", "80 - 100"], ["B", ""]]);
  });

  it("reads block quotes", () => {
    const [q] = parseMarkdown("> Education is the key\n> to success");
    expect(q).toMatchObject({ kind: "quote" });
  });
});

describe("parseInline", () => {
  it("reads bold, italics and code", () => {
    expect(parseInline("a **bold** and *it* and `x*y`")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", children: [{ kind: "text", text: "bold" }] },
      { kind: "text", text: " and " },
      { kind: "em", children: [{ kind: "text", text: "it" }] },
      { kind: "text", text: " and " },
      { kind: "code", text: "x*y" },
    ]);
  });

  it("leaves snake_case, lone stars and maths alone", () => {
    expect(inlineText(parseInline("student_id and 2 * 3 = 6"))).toBe("student_id and 2 * 3 = 6");
    expect(parseInline("student_id").length).toBe(1);
  });

  it("links only to web and mail addresses", () => {
    expect(parseInline("[KICD](https://kicd.ac.ke)")[0]).toMatchObject({ kind: "link", href: "https://kicd.ac.ke" });
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ kind: "text", text: "click" }]);
    expect(parseInline("see https://knec.ac.ke.")[1]).toMatchObject({ kind: "link", href: "https://knec.ac.ke" });
    expect(safeHref("data:text/html,x")).toBeNull();
  });

  it("keeps HTML as plain text", () => {
    expect(inlineText(parseInline("<script>alert(1)</script>"))).toBe("<script>alert(1)</script>");
  });
});

describe("chatTitleFrom", () => {
  it("uses the first line, cut at a word", () => {
    expect(chatTitleFrom("  \nPlan a lesson\nmore")).toBe("Plan a lesson");
    expect(chatTitleFrom("")).toBe("New chat");
    const long = chatTitleFrom("Write a circular to parents about the half term break and the fees deadline next week");
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(61);
  });
});

describe("source markers", () => {
  it("reads [^n] as a citation of the nth source, and keeps other brackets as they were", () => {
    expect(parseInline("Opens 4 Jan[^1][^12].")).toEqual([
      { kind: "text", text: "Opens 4 Jan" }, { kind: "cite", n: 1 }, { kind: "cite", n: 12 }, { kind: "text", text: "." },
    ]);
    expect(parseInline("[^0] [^x] [^123]")).toEqual([{ kind: "text", text: "[^0] [^x] [^123]" }]);
    expect(parseInline("`[^1]`")).toEqual([{ kind: "code", text: "[^1]" }]);
    expect(inlineText(parseInline("Opens 4 Jan[^2]."))).toBe("Opens 4 Jan[2].");
  });
});

describe("parseChatSources", () => {
  it("keeps http(s) sources in order, and leaves an unsafe one as a gap so the numbers still match", () => {
    expect(parseChatSources([
      { title: "  2027   term dates ", url: "https://www.education.go.ke/dates" },
      { title: "x", url: "javascript:alert(1)" },
      { title: "", url: "http://knec.ac.ke/kcse" },
      { title: "x", url: "data:text/html,<script>" },
      { title: "x", url: "https://" },
    ])).toEqual([
      { title: "2027 term dates", url: "https://www.education.go.ke/dates" },
      { title: "", url: "" },
      { title: "knec.ac.ke", url: "http://knec.ac.ke/kcse" },
      { title: "", url: "" },
      { title: "", url: "" },
    ]);
  });

  it("reads anything else as no sources, and keeps at most 20", () => {
    for (const raw of [null, undefined, "https://a.com", { url: "https://a.com" }, 3]) expect(parseChatSources(raw)).toEqual([]);
    expect(parseChatSources([null, 5, { url: 7 }])).toEqual([{ title: "", url: "" }, { title: "", url: "" }, { title: "", url: "" }]);
    expect(parseChatSources(Array.from({ length: 30 }, (_, i) => ({ title: `${i}`, url: `https://a.com/${i}` })))).toHaveLength(20);
  });

  it("names a source's site", () => {
    expect(sourceHost("https://www.TSC.go.ke/circulars?x=1")).toBe("tsc.go.ke");
    expect(sourceHost("http://user@kicd.ac.ke:8080/a")).toBe("kicd.ac.ke");
  });
});
