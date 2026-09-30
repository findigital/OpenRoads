import { useCallback, useState } from "react";
import { Linking, Text } from "react-native";
import Markdown, {
  type ASTNode,
  type MarkdownStyles,
  type RenderRules,
} from "react-native-markdown-renderer";
import { assistantMarkdown, isSafeAssistantUrl } from "./assistant-markdown";
import { parseSnippet, promoteBareJsonBlocks } from "./snippet";
import { CodeCard, SnippetCard } from "./snippet-card";
import { colors, ErrorNotice } from "./ui";

const textStyle = { color: colors.text, fontSize: 16, lineHeight: 24 };
const style: Partial<MarkdownStyles> = {
  text: textStyle,
  paragraph: { marginTop: 0, marginBottom: 6 },
  list: { marginBottom: 6 },
  headingContainer: { marginTop: 8, marginBottom: 4 },
  heading1: { fontSize: 21, lineHeight: 27 },
  heading2: { fontSize: 19, lineHeight: 25 },
  heading3: { fontSize: 17, lineHeight: 23 },
  link: { color: colors.blueDark, textDecorationLine: "underline" },
  codeInline: { backgroundColor: "#E2E4E7", color: colors.text },
  root: { minWidth: 0, maxWidth: "100%" },
};

function fenceKey(node: ASTNode): string {
  const code = node.content;
  return `${node.tokenIndex}:${node.sourceInfo}:${code.length}:${code.slice(0, 32)}:${code.slice(-16)}`;
}

const renderCodeBlock: RenderRules["fence"] = (node) => {
  const code = node.content.replace(/\n$/, "");
  const key = fenceKey(node);
  const snippet = parseSnippet(code, node.sourceInfo);
  if (snippet) return <SnippetCard key={key} model={snippet} />;
  return <CodeCard key={key} code={code} language={node.sourceInfo} />;
};

const rules: RenderRules = {
  textgroup: (node, children) => (
    <Text key={node.key} selectable style={textStyle}>
      {children}
    </Text>
  ),
  image: (node) => (
    <Text key={node.key} selectable style={{ color: colors.muted }}>
      {node.attributes.alt ? `[Image: ${node.attributes.alt}]` : "[Image]"}
    </Text>
  ),
  code_block: renderCodeBlock,
  fence: renderCodeBlock,
};

export function AssistantResponse({ content }: { content: string }) {
  const [linkError, setLinkError] = useState("");
  const onLinkPress = useCallback((url: string) => {
    if (!isSafeAssistantUrl(url)) return false;
    setLinkError("");
    void Linking.openURL(url).catch((error) =>
      setLinkError(error instanceof Error ? error.message : String(error)),
    );
    return false;
  }, []);
  return (
    <>
      <Markdown
        markdownit={assistantMarkdown}
        style={style}
        rules={rules}
        onLinkPress={onLinkPress}
      >
        {promoteBareJsonBlocks(content)}
      </Markdown>
      <ErrorNotice error={linkError} />
    </>
  );
}
