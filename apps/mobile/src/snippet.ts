const CODE_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "text",
  "txt",
  "plaintext",
  "ts",
  "tsx",
  "js",
  "jsx",
  "javascript",
  "mjs",
  "cjs",
  "py",
  "python",
  "rb",
  "ruby",
  "go",
  "rs",
  "rust",
  "java",
  "kt",
  "kotlin",
  "sql",
  "html",
  "css",
  "scss",
  "yml",
  "yaml",
  "toml",
  "xml",
  "md",
  "markdown",
  "diff",
  "patch",
  "graphql",
  "ini",
  "env",
]);

const ACRONYMS = new Set(["json", "id", "url", "uri", "api", "uuid"]);

export type SnippetLeaf =
  | { type: "text"; text: string }
  | { type: "chips"; items: string[] }
  | { type: "list"; items: SnippetLeaf[] }
  | { type: "group"; fields: SnippetField[] }
  | { type: "summary"; count: number; fields: SnippetField[] };

export type SnippetField = {
  key: string;
  label: string;
  value: SnippetLeaf;
};

export type SnippetModel = {
  title: string;
  fields: SnippetField[];
  body: SnippetLeaf | null;
  json: string;
};

export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "Value";
  return words.map(titleWord).join(" ");
}

function titleWord(word: string): string {
  const lower = word.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructured(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || isRecord(value);
}

/** Parse JSON, including objects that only fail because of trailing commas. */
function parseJsonValue(source: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = source.replace(/^\uFEFF/, "").trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const relaxed = stripTrailingCommas(trimmed);
    if (relaxed === trimmed) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(relaxed) };
    } catch {
      return { ok: false };
    }
  }
}

function stripTrailingCommas(source: string): string {
  let out = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i] ?? "";
    if (quoted) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j] ?? "")) j++;
      const next = source[j];
      if (next === "}" || next === "]") continue;
    }
    out += char;
  }
  return out;
}

function snippetTitle(info: string, value: unknown): string {
  const tokens = info.trim().split(/\s+/).filter(Boolean);
  const specific = tokens.find((token) => !/^(json|jsonc)$/i.test(token));
  if (specific) return humanizeKey(specific);
  if (tokens.length) return "JSON";
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0]) return humanizeKey(keys[0]);
  }
  return "Snippet";
}

function leaf(value: unknown, depth: number): SnippetLeaf {
  if (value === null || value === undefined) return { type: "text", text: "—" };
  if (typeof value === "string") return { type: "text", text: value || "—" };
  if (typeof value === "number") return { type: "text", text: String(value) };
  if (typeof value === "boolean") return { type: "text", text: value ? "Yes" : "No" };
  if (Array.isArray(value)) return arrayLeaf(value);
  if (isRecord(value)) {
    const fields = objectFields(value, depth + 1);
    if (!fields.length) return { type: "text", text: "Empty" };
    // Top-level values expand. One nested object level expands. Deeper objects summarize.
    if (depth >= 1) return { type: "summary", count: fields.length, fields };
    return { type: "group", fields };
  }
  return { type: "text", text: String(value) };
}

function objectFields(value: Record<string, unknown>, depth: number): SnippetField[] {
  return Object.entries(value).map(([key, child]) => ({
    key,
    label: humanizeKey(key),
    value: leaf(child, depth),
  }));
}

function arrayLeaf(items: unknown[]): SnippetLeaf {
  if (!items.length) return { type: "text", text: "None" };
  if (items.every((item) => typeof item === "string")) {
    const strings = items.map((item) => (item.length ? item : "—"));
    if (strings.length <= 8 && strings.every((item) => item.length <= 28))
      return { type: "chips", items: strings };
    return { type: "list", items: strings.map((text) => ({ type: "text", text })) };
  }
  return { type: "list", items: items.map((item) => leaf(item, 1)) };
}

function looksLikeFenceLabel(label: string): boolean {
  return label.includes("_") || label.includes("-") || label === label.toLowerCase();
}

function separateLabel(source: string, info: string | undefined): { info: string; body: string } {
  const provided = info?.trim() ?? "";
  if (provided) return { info: provided, body: source };
  const match = source.match(/^\s*([A-Za-z][\w-]*)\s*\n([\s\S]*)$/);
  const label = match?.[1];
  const body = match?.[2];
  if (!label || !body || !looksLikeFenceLabel(label)) return { info: "", body: source };
  const parsed = parseJsonValue(body);
  if (!parsed.ok || !isStructured(parsed.value)) return { info: "", body: source };
  return { info: label, body };
}

function presentObject(
  value: Record<string, unknown>,
  title: string,
): { fields: SnippetField[]; body: SnippetLeaf | null } {
  const fields = objectFields(value, 0);
  const only = fields.length === 1 ? fields[0] : undefined;
  // The title already names this key, so show its contents instead of repeating the label.
  if (only && only.label === title) {
    const inner = value[only.key];
    if (isRecord(inner)) return { fields: objectFields(inner, 0), body: null };
    return { fields: [], body: only.value };
  }
  return { fields, body: null };
}

export function parseSnippet(source: string, info?: string): SnippetModel | null {
  const separated = separateLabel(source, info);
  const lang = separated.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (lang && CODE_LANGUAGES.has(lang)) return null;
  const parsed = parseJsonValue(separated.body);
  if (!parsed.ok || !isStructured(parsed.value)) return null;
  const json = JSON.stringify(parsed.value, null, 2);
  const title = snippetTitle(separated.info, parsed.value);
  if (Array.isArray(parsed.value))
    return { title, fields: [], body: arrayLeaf(parsed.value), json };
  const presented = presentObject(parsed.value, title);
  return { title, fields: presented.fields, body: presented.body, json };
}

const CLOSED_FENCE = /(?:^|\n)[ ]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ ]{0,3}\1[ ]*(?=\n|$)/g;

/**
 * Wrap bare JSON objects and arrays so the fence renderer can show a snippet card.
 * Closed fences are left untouched, including non-JSON code samples.
 */
export function promoteBareJsonBlocks(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const pieces: string[] = [];
  let cursor = 0;
  for (const match of normalized.matchAll(CLOSED_FENCE)) {
    const index = match.index ?? 0;
    pieces.push(rewriteLoose(normalized.slice(cursor, index)));
    pieces.push(match[0]);
    cursor = index + match[0].length;
  }
  pieces.push(rewriteLoose(normalized.slice(cursor)));
  return pieces.join("");
}

function rewriteLoose(segment: string): string {
  const marker = segment.search(/(?:^|\n)[ ]{0,3}(`{3,}|~{3,})/);
  if (marker === -1) return rewriteBlocks(segment);
  const splitAt = segment[marker] === "\n" ? marker + 1 : marker;
  return rewriteBlocks(segment.slice(0, splitAt)) + segment.slice(splitAt);
}

function rewriteBlocks(segment: string): string {
  const lines = segment.split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (/^\s*[{[]/.test(line)) {
      const taken = takeJsonLines(lines, index);
      if (taken > 0) {
        const raw = lines
          .slice(index, index + taken)
          .join("\n")
          .trim();
        const fence = raw.includes("```") ? "````" : "```";
        out.push(fence, raw, fence);
        index += taken;
        continue;
      }
    }
    out.push(line);
    index += 1;
  }
  return out.join("\n");
}

function takeJsonLines(lines: string[], start: number): number {
  const collected: string[] = [];
  const limit = Math.min(lines.length, start + 80);
  for (let index = start; index < limit; index++) {
    const line = lines[index] ?? "";
    if (!line.trim() && collected.length > 0) return 0;
    collected.push(line);
    const raw = collected.join("\n").trim();
    const parsed = parseJsonValue(raw);
    if (parsed.ok && isStructured(parsed.value) && (collected.length > 1 || raw.length >= 48)) {
      return collected.length;
    }
  }
  return 0;
}
