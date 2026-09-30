export interface FormFieldRef {
  name: string;
  type: "text" | "checkbox" | "unsupported";
}

const LABEL_TO_FIELD: Record<string, string> = {
  "legal name": "legal_name",
  dba: "dba",
  "mc number": "mc_number",
  "usdot number": "usdot_number",
  "contact name": "contact_name",
  phone: "phone",
  email: "email",
  "remit-to address": "remit_to_address",
  "remit to address": "remit_to_address",
  "equipment type": "equipment_type",
  "number of trucks": "truck_count",
  insurer: "insurer",
  "policy number": "policy_number",
  "auto liability limit": "auto_liability_limit",
  "cargo limit": "cargo_limit",
  "coi expiration date": "coi_expiration",
  "coi expiration": "coi_expiration",
  "quick pay requested": "quick_pay_requested",
  "signature name": "signature_name",
  "signature date": "signature_date",
};

export function fieldLabel(name: string): string {
  if (name === "remit_to_address") return "remit-to address";
  if (name === "cargo_limit") return "cargo limit";
  return name.replaceAll("_", " ");
}

export function missingFieldsQuestion(names: string[]): string {
  const labels = names.map(fieldLabel);
  const list =
    labels.length === 0
      ? "a few details"
      : labels.length === 1
        ? labels[0]
        : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `I still need ${list}. The original PDF will stay intact.`;
}

export function hasFieldValue(
  value: string | boolean | undefined,
  type: FormFieldRef["type"],
): boolean {
  if (type === "checkbox") return typeof value === "boolean";
  return typeof value === "string" && value.trim().length > 0;
}

/** Read labeled lines from an untrusted email body. Unknown labels are ignored. */
export function extractFormValues(
  body: string,
  fields: FormFieldRef[],
): Record<string, string | boolean> {
  const allowed = new Map(
    fields.filter((field) => field.type !== "unsupported").map((field) => [field.name, field.type]),
  );
  const values: Record<string, string | boolean> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]{1,80}):\s*(.+?)\s*$/);
    if (!match) continue;
    const key = LABEL_TO_FIELD[match[1].trim().toLowerCase()];
    const type = key ? allowed.get(key) : undefined;
    if (!key || !type) continue;
    const raw = match[2].trim();
    if (!raw || /^(tbd|n\/a|na|unknown|missing|not provided|—|-)$/i.test(raw)) continue;
    if (type === "checkbox") {
      if (/^(yes|true|checked|requested)$/i.test(raw)) values[key] = true;
      else if (/^(no|false|unchecked)$/i.test(raw)) values[key] = false;
    } else values[key] = raw;
  }
  return values;
}
