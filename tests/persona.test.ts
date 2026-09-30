import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { sampleProfile } from "../apps/server/src/persona.ts";

test("persona name and mailbox come from OPENROADS_PERSONA", () => {
  assert.deepEqual(sampleProfile(undefined), { name: "Alex", email: "alex@example.com" });
  assert.deepEqual(sampleProfile("  "), { name: "Alex", email: "alex@example.com" });
  assert.deepEqual(sampleProfile("Paul Webster · J&A Freight"), {
    name: "Paul Webster · J&A Freight",
    email: "paul.webster@example.com",
  });
  assert.deepEqual(sampleProfile("Luis Ortega · Carrier Relations"), {
    name: "Luis Ortega · Carrier Relations",
    email: "luis.ortega@example.com",
  });
});

test("sample snapshot uses the persona instead of a hard-coded name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openroads-persona-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    openroadsPersona: "Paul Webster · J&A Freight",
  });
  try {
    await server.workspace.ensureSample("local-user", server.actions);
    await server.agent.ensure("local-user");
    const workspace = await server.workspace.snapshot("local-user");
    const identity = await server.agent.snapshot("local-user");
    assert.equal(workspace.profile.name, "Paul Webster · J&A Freight");
    assert.equal(workspace.profile.email, "paul.webster@example.com");
    assert.equal(identity.identity.name, "Paul Webster · J&A Freight");
    assert.ok(workspace.mail.every((mail) => mail.to.includes("paul.webster@example.com")));
    assert.equal(
      workspace.connections.find((connection) => connection.id === "google")?.account,
      "paul.webster@example.com",
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
