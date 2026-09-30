/** Sample-mode profile driven by OPENROADS_PERSONA. Unset keeps the stock sample name. */
export function sampleProfile(persona: string | undefined): { name: string; email: string } {
  const trimmed = persona?.trim() ?? "";
  if (!trimmed) return { name: "Alex", email: "alex@example.com" };
  const person = trimmed.split("·")[0]?.trim() || trimmed;
  const local = person
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return { name: trimmed, email: `${local || "user"}@example.com` };
}
