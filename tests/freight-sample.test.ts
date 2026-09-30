import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { PDFDocument } from "pdf-lib";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { extractFormValues } from "../apps/server/src/engine/form-values.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { createCarrierProfilePdf, inspectPdf } from "../packages/integrations/src/pdf.ts";

const persona = "Dana Brooks · Billing, AR & quick pay";

test("carrier profile PDF is fillable and starts blank", async () => {
  const details = await inspectPdf(await createCarrierProfilePdf());
  assert.equal(details.pageCount, 2);
  const names = [
    "legal_name",
    "dba",
    "mc_number",
    "usdot_number",
    "contact_name",
    "phone",
    "email",
    "remit_to_address",
    "equipment_type",
    "truck_count",
    "insurer",
    "policy_number",
    "auto_liability_limit",
    "cargo_limit",
    "coi_expiration",
    "signature_name",
    "signature_date",
  ];
  for (const name of names) {
    assert.deepEqual(
      details.fields.find((field) => field.name === name),
      {
        name,
        value: "",
        type: "text",
      },
    );
  }
  assert.deepEqual(
    details.fields.find((field) => field.name === "quick_pay_requested"),
    { name: "quick_pay_requested", value: "false", type: "checkbox" },
  );
});

test("carrier packet asks only for cargo limit and remit-to, then stops for review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openroads-freight-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config = {
    mode: "sample" as const,
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample" as const,
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    openroadsPersona: persona,
  };
  const server = await createApp(db, config);
  const owner = "freight-user";
  try {
    await server.workspace.ensureSample(owner, server.actions);
    const workspace = await server.workspace.snapshot(owner);
    assert.equal(workspace.profile.email, "dana.brooks@example.com");
    assert.equal(workspace.mail.length, 6);
    assert.deepEqual(workspace.mail.map((mail) => mail.subject).sort(), [
      "Carrier invoice for load #JA-48190",
      "Insurance certificate expiring in 21 days",
      "New carrier setup packet",
      "POD for load #JA-48213",
      "Quick-pay request for load #JA-48177",
      "Shipper quote request: Chicago to Atlanta",
    ]);
    for (const mail of workspace.mail) {
      const domain = mail.from.split("@")[1] ?? "";
      assert.ok(
        domain.endsWith(".test") || domain === "example.com" || domain.endsWith(".example.com"),
        mail.from,
      );
    }
    const packet = workspace.mail.find((mail) => mail.subject === "New carrier setup packet");
    assert.ok(packet);
    assert.equal(packet.attachments.length, 1);
    assert.equal(
      workspace.mail.filter((mail) => mail.attachments.length).length,
      1,
      "only the setup packet carries the PDF",
    );
    assert.match(
      workspace.mail.find((mail) => mail.id === "mail-pod")?.body ?? "",
      /2 pallets short/,
    );
    assert.match(
      workspace.mail.find((mail) => mail.id === "mail-quote")?.body ?? "",
      /Chicago, IL/,
    );
    assert.match(
      workspace.mail.find((mail) => mail.id === "mail-quote")?.body ?? "",
      /Atlanta, GA/,
    );
    assert.match(workspace.mail.find((mail) => mail.id === "mail-quote")?.body ?? "", /42,000 lb/);
    assert.match(
      workspace.mail.find((mail) => mail.id === "mail-quote")?.body ?? "",
      /dry van FTL/i,
    );
    assert.match(workspace.mail.find((mail) => mail.id === "mail-invoice")?.body ?? "", /3 hours/);
    assert.match(
      workspace.mail.find((mail) => mail.id === "mail-invoice")?.body ?? "",
      /Check-in:/,
    );
    assert.match(
      workspace.mail.find((mail) => mail.id === "mail-invoice")?.body ?? "",
      /Check-out:/,
    );
    assert.deepEqual(workspace.events.map((event) => event.title).sort(), [
      "Carrier onboarding call",
      "Monday billing standup",
      "Shipper quarterly review",
    ]);
    const form = await inspectPdf(await server.files.bytes(owner, packet.attachments[0]));
    const extracted = extractFormValues(packet.body, form.fields);
    assert.equal(extracted.legal_name, "Northline Haul LLC");
    assert.equal(extracted.cargo_limit, undefined);
    assert.equal(extracted.remit_to_address, undefined);
    assert.equal(extracted.quick_pay_requested, true);

    const events = await lastValueFrom(
      new ConversationAgent(config, server.agent, owner)
        .run({
          threadId: "freight-thread",
          runId: "freight-run",
          messages: [
            {
              id: "freight-message",
              role: "user",
              content: "Work the new carrier setup packet",
            },
          ],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.ok(result && typeof result.content === "string");
    const taskId = JSON.parse(result.content).id as string;
    await server.agent.worker.tick();
    const waiting = await server.agent.getTask(owner, taskId);
    assert.equal(waiting.title, "Carrier setup packet");
    assert.equal(waiting.status, "waiting_input");
    assert.match(waiting.question ?? "", /cargo limit/i);
    assert.match(waiting.question ?? "", /remit-to/i);
    const missing = Array.isArray(waiting.state.missingFields) ? waiting.state.missingFields : [];
    assert.deepEqual(
      missing
        .map((field) => (typeof field === "object" && field && "name" in field ? field.name : ""))
        .sort(),
      ["cargo_limit", "remit_to_address"],
    );
    const found = (await server.agent.detail(owner, taskId)).events.some(
      (event) => event.title === "Found the document",
    );
    assert.equal(found, true);
    await server.agent.answer(owner, taskId, "Cargo limit and remit-to supplied", {
      cargo_limit: "$100,000",
      remit_to_address: "400 Sample Street, Chicago, IL 60601",
    });
    await server.agent.worker.tick();
    const reviewed = await server.agent.detail(owner, taskId);
    assert.equal(reviewed.task.status, "waiting_approval");
    assert.equal(reviewed.files.length, 1);
    const saved = reviewed.events.some((event) => event.title === "Saved a filled copy");
    assert.equal(saved, true);
    const filled = await PDFDocument.load(await server.files.bytes(owner, reviewed.files[0].id));
    assert.equal(filled.getForm().getTextField("legal_name").getText(), "Northline Haul LLC");
    assert.equal(filled.getForm().getTextField("cargo_limit").getText(), "$100,000");
    assert.equal(
      filled.getForm().getTextField("remit_to_address").getText(),
      "400 Sample Street, Chicago, IL 60601",
    );
    assert.equal(filled.getForm().getCheckBox("quick_pay_requested").isChecked(), true);
    assert.equal((await server.files.get(owner, packet.attachments[0])).parentId, undefined);
    const action = await db.get<ActionProposal>(owner, "actions", reviewed.task.actionId ?? "");
    assert.ok(action);
    assert.equal(action.status, "awaiting_review");
    assert.equal(action.kind, "email.send");
    const data = action.data as {
      to: string[];
      subject: string;
      body: string;
      attachmentIds: string[];
    };
    assert.deepEqual(data.to, ["dispatch@northline.test"]);
    assert.equal(data.subject, "Re: New carrier setup packet");
    assert.equal(
      data.body,
      "Hi,\n\nAttached is the completed carrier profile and setup packet for your file.\n\nTell us if you still need the W-9, insurance certs, or a signed rate con.\n\nThanks,",
    );
    assert.deepEqual(data.attachmentIds, [reviewed.files[0].id]);
    assert.equal(
      (await server.workspace.snapshot(owner)).mail.some((mail) => mail.subject.startsWith("Re:")),
      false,
    );

    const ideas = await server.agent.refreshIdeas(owner);
    const idea = ideas.find((item) => item.input.messageId === packet.id);
    assert.ok(idea);
    assert.match(idea.reason, /carrier setup packet/i);
    assert.match(idea.reason, /reply for your review/i);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
