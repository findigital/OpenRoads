import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  type TextStyle,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import type { SnippetField, SnippetLeaf, SnippetModel } from "./snippet";
import { Card, colors, s } from "./ui";

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

function withKeys<T>(items: readonly T[], label: (item: T) => string): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = label(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: `${count}:${base}`, item };
  });
}

function leafLabel(item: SnippetLeaf): string {
  if (item.type === "text" || item.type === "chips") {
    return item.type === "text" ? item.text : item.items.join("\n");
  }
  if (item.type === "summary") return `${item.type}:${item.count}:${item.fields.length}`;
  if (item.type === "group") return item.fields.map((field) => field.key).join(".");
  return item.items.map(leafLabel).join("\n");
}
const fieldLabel: TextStyle = {
  color: colors.muted,
  fontSize: 12,
  lineHeight: 16,
  fontWeight: "600",
};
const valueText: TextStyle = { color: colors.text, fontSize: 15, lineHeight: 22 };
const toggleText: TextStyle = { color: colors.navy, fontSize: 14, fontWeight: "600" };
const webCodeLine = {
  display: "block",
  whiteSpace: "pre",
  wordWrap: "normal",
} as unknown as TextStyle;

function useCardWidth(): number {
  const { width } = useWindowDimensions();
  // Page gutter, bubble padding, and the assistant bubble's max width.
  return Math.max(200, Math.min(Math.round(width * 0.95 - 72), 480));
}

const shell = (width: number): ViewStyle => ({
  width,
  maxWidth: "100%",
  alignSelf: "flex-start",
  minWidth: 0,
  marginVertical: 4,
});

export function SnippetCard({ model }: { model: SnippetModel }) {
  const width = useCardWidth();
  return (
    <Card
      style={{
        ...shell(width),
        padding: 14,
        gap: 12,
        borderWidth: 1,
        borderColor: "#E3E5E8",
        borderRadius: 18,
        overflow: "hidden",
      }}
    >
      <View style={[s.row, { gap: 8 }]}>
        <View style={{ width: 4, height: 18, borderRadius: 2, backgroundColor: colors.gold }} />
        <Text
          accessibilityRole="header"
          selectable
          style={[s.heading, { color: colors.navy, flex: 1 }]}
        >
          {model.title}
        </Text>
      </View>
      {model.fields.length ? (
        <View style={{ gap: 10 }}>
          {model.fields.map((field) => (
            <FieldRow key={field.key} field={field} />
          ))}
        </View>
      ) : model.body ? (
        <ValueView value={model.body} />
      ) : (
        <Text style={s.muted}>No fields</Text>
      )}
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <JsonToggle json={model.json} />
    </Card>
  );
}

export function CodeCard({ code, language }: { code: string; language?: string }) {
  const width = useCardWidth();
  const label = language?.trim();
  return (
    <View
      style={[
        shell(width),
        {
          backgroundColor: colors.card,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: "#E3E5E8",
          overflow: "hidden",
        },
      ]}
    >
      {label ? (
        <Text numberOfLines={1} style={[fieldLabel, { paddingHorizontal: 12, paddingTop: 10 }]}>
          {label}
        </Text>
      ) : null}
      <CodeWell text={code} />
    </View>
  );
}

function FieldRow({ field }: { field: SnippetField }) {
  return (
    <View style={{ gap: 3 }}>
      <Text style={fieldLabel}>{field.label}</Text>
      <ValueView value={field.value} />
    </View>
  );
}

function ValueView({ value }: { value: SnippetLeaf }) {
  switch (value.type) {
    case "text":
      return <WrappedText text={value.text} />;
    case "chips":
      return <ChipRow items={value.items} />;
    case "list":
      return <LeafList items={value.items} />;
    case "group":
      return (
        <View
          style={{
            gap: 8,
            marginTop: 2,
            paddingLeft: 10,
            borderLeftWidth: 2,
            borderLeftColor: colors.gold,
          }}
        >
          {value.fields.map((field) => (
            <FieldRow key={field.key} field={field} />
          ))}
        </View>
      );
    case "summary":
      return <FieldSummary count={value.count} fields={value.fields} />;
  }
}

function WrappedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const limit = 220;
  const clipped = !open && text.length > limit;
  return (
    <View style={{ gap: 4 }}>
      <Text selectable style={valueText}>
        {clipped ? `${text.slice(0, limit).trimEnd()}…` : text}
      </Text>
      {text.length > limit ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => setOpen((value) => !value)}
        >
          <Text style={toggleText}>{open ? "Show less" : "Show more"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ChipRow({ items }: { items: string[] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {withKeys(items, (item) => item).map((entry) => (
        <View
          key={entry.key}
          style={[s.chip, { backgroundColor: colors.sky, maxWidth: "100%", paddingVertical: 5 }]}
        >
          <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: "600", color: colors.navy }}>
            {entry.item}
          </Text>
        </View>
      ))}
    </View>
  );
}

function LeafList({ items }: { items: SnippetLeaf[] }) {
  const [open, setOpen] = useState(false);
  const visible = open ? items : items.slice(0, 8);
  const hidden = items.length - visible.length;
  return (
    <View style={{ gap: 6 }}>
      {withKeys(visible, leafLabel).map((entry) =>
        entry.item.type === "text" ? (
          <Text key={entry.key} selectable style={valueText}>
            • {entry.item.text}
          </Text>
        ) : (
          <ValueView key={entry.key} value={entry.item} />
        ),
      )}
      {hidden > 0 ? (
        <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setOpen(true)}>
          <Text style={toggleText}>Show {hidden} more</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function FieldSummary({ count, fields }: { count: number; fields: SnippetField[] }) {
  const [open, setOpen] = useState(false);
  const noun = count === 1 ? "field" : "fields";
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? `Hide ${count} ${noun}` : `Show ${count} ${noun}`}
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [
          s.row,
          { gap: 4, alignSelf: "flex-start", opacity: pressed ? 0.6 : 1 },
        ]}
      >
        {open ? (
          <ChevronDown size={15} color={colors.navy} />
        ) : (
          <ChevronRight size={15} color={colors.navy} />
        )}
        <Text style={toggleText}>
          {count} {noun}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={{
            gap: 8,
            paddingLeft: 10,
            borderLeftWidth: 2,
            borderLeftColor: colors.line,
          }}
        >
          {fields.map((field) => (
            <FieldRow key={field.key} field={field} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function JsonToggle({ json }: { json: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? "Hide JSON" : "View JSON"}
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [
          s.row,
          { gap: 4, alignSelf: "flex-start", opacity: pressed ? 0.6 : 1 },
        ]}
      >
        {open ? (
          <ChevronDown size={15} color={colors.navy} />
        ) : (
          <ChevronRight size={15} color={colors.navy} />
        )}
        <Text style={toggleText}>{open ? "Hide JSON" : "View JSON"}</Text>
      </Pressable>
      {open ? <CodeWell text={json} /> : null}
    </View>
  );
}

function CodeWell({ text }: { text: string }) {
  const lines = text.split("\n");
  const codeColor = "#F4F7FB";
  const lineStyle: TextStyle = {
    fontFamily: mono,
    fontSize: 12,
    lineHeight: 18,
    color: codeColor,
  };
  const body = withKeys(lines, (line) => line).map((entry) => (
    <Text
      key={entry.key}
      selectable
      style={[lineStyle, Platform.OS === "web" ? webCodeLine : null]}
    >
      {entry.item.length ? entry.item : " "}
    </Text>
  ));
  if (Platform.OS === "web") {
    return (
      <View
        style={
          {
            width: "100%",
            maxWidth: "100%",
            minWidth: 0,
            backgroundColor: colors.navy,
            borderRadius: 12,
            padding: 12,
            overflowX: "auto",
            overflowY: "hidden",
          } as ViewStyle
        }
      >
        {body}
      </View>
    );
  }
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      style={{ maxWidth: "100%", backgroundColor: colors.navy, borderRadius: 12 }}
    >
      <View style={{ padding: 12 }}>{body}</View>
    </ScrollView>
  );
}
