import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnippetField, SnippetModel } from "../src/snippet.ts";
import { humanizeKey, parseSnippet, promoteBareJsonBlocks } from "../src/snippet.ts";

const architecture = `{
  "architecture": {
    "epochs": 200,
    "layers": [
      "Input layer (60 timesteps)",
      "LSTM layer (100 units, return_sequences=True)",
      "Dropout (0.2)",
      "LSTM layer (50 units)",
      "Dropout (0.2)",
      "Dense layer (25 units, ReLU)",
      "Dense layer (1 unit, linear)"
    ],
    "optimizer": "Adam",
    "batch_size": 32,
    "loss_function": "MSE"
  }
}`;

const training = `{
  "data_requirements": {
    "test_period": "Hold-out last 3 months",
    "minimum_history": "2 years of daily price data",
    "update_frequency": "Daily model retraining",
    "validation_method": "Time series cross-validation"
  },
  "performance_metrics": [
    "MAPE (Mean Absolute Percentage Error)",
    "RMSE (Root Mean Square Error)",
    "Directional accuracy",
    "Prediction interval coverage",
    "Sharpe ratio of trading signals"
  ]
}`;

function groupFields(field: SnippetField | undefined): SnippetField[] {
  assert.equal(field?.value.type, "group");
  if (field?.value.type !== "group") return [];
  return field.value.fields;
}

test("humanizes snake_case, kebab-case, camelCase, and short acronyms", () => {
  assert.equal(humanizeKey("batch_size"), "Batch Size");
  assert.equal(humanizeKey("loss-function"), "Loss Function");
  assert.equal(humanizeKey("hiddenUnits"), "Hidden Units");
  assert.equal(humanizeKey("user_id"), "User ID");
  assert.equal(humanizeKey("json"), "JSON");
  assert.equal(humanizeKey("MAPE"), "MAPE");
});

test("a model_training fence becomes labeled fields with raw JSON kept pretty", () => {
  const model = parseSnippet(training, "model_training");
  assert.ok(model);
  assert.equal(model.title, "Model Training");
  assert.equal(
    model.fields.map((field) => field.label).join(", "),
    "Data Requirements, Performance Metrics",
  );
  const requirements = groupFields(model.fields[0]);
  assert.deepEqual(
    requirements.map((field) => [field.label, field.value.type === "text" ? field.value.text : ""]),
    [
      ["Test Period", "Hold-out last 3 months"],
      ["Minimum History", "2 years of daily price data"],
      ["Update Frequency", "Daily model retraining"],
      ["Validation Method", "Time series cross-validation"],
    ],
  );
  const metrics = model.fields[1];
  assert.equal(metrics?.value.type, "list");
  if (metrics?.value.type === "list") {
    assert.equal(metrics.value.items.length, 5);
    assert.equal(metrics.value.items[0]?.type, "text");
  }
  assert.match(model.json, /\n {2}"data_requirements": \{/);
  assert.doesNotMatch(model.json, /,\s*[}\]]/);
});

test("architecture layers stay a short list and one unlabeled object uses its key", () => {
  const labeled = parseSnippet(architecture, "json");
  assert.equal(labeled?.title, "JSON");
  assert.equal(labeled?.fields[0]?.label, "Architecture");
  const layers = groupFields(labeled?.fields[0]).find((field) => field.key === "layers");
  assert.equal(layers?.value.type, "list");
  if (layers?.value.type === "list" && layers.value.items[1]?.type === "text") {
    assert.equal(layers.value.items[1].text, "LSTM layer (100 units, return_sequences=True)");
  }
  const lifted = parseSnippet(architecture);
  assert.equal(lifted?.title, "Architecture");
  assert.deepEqual(
    lifted?.fields.map((field) => field.label),
    ["Epochs", "Layers", "Optimizer", "Batch Size", "Loss Function"],
  );
  assert.equal(lifted?.fields[0]?.value.type === "text" ? lifted.fields[0].value.text : "", "200");
});

test("short string arrays are chips, deep objects summarize, and code fences stay code", () => {
  const chips = parseSnippet('{"tags":["diesel","lane","rate"]}');
  assert.equal(chips?.title, "Tags");
  assert.equal(chips?.body?.type, "chips");
  if (chips?.body?.type === "chips") assert.deepEqual(chips.body.items, ["diesel", "lane", "rate"]);

  const deep = parseSnippet(
    JSON.stringify({
      strategy_design: { model: { epochs: 200, cell: { units: 50, dropout: 0.2 } } },
    }),
    "strategy_design",
  );
  assert.equal(deep?.title, "Strategy Design");
  const modelField = deep?.fields.find((field) => field.key === "model");
  assert.equal(modelField?.value.type, "group");
  if (modelField?.value.type === "group") {
    assert.equal(modelField.value.fields[0]?.label, "Epochs");
    assert.equal(modelField.value.fields[1]?.value.type, "summary");
    if (modelField.value.fields[1]?.value.type === "summary") {
      assert.equal(modelField.value.fields[1].value.count, 2);
    }
  }

  assert.equal(parseSnippet('{"a":1}', "ts"), null);
  assert.equal(parseSnippet('echo "hello"', "bash"), null);
  assert.equal(parseSnippet("not json"), null);
  assert.equal(parseSnippet("42"), null);

  const loose = parseSnippet('{\n  "active": true,\n  "note": null,\n}');
  assert.equal(loose?.fields[0]?.value.type === "text" ? loose.fields[0].value.text : "", "Yes");
  assert.equal(loose?.fields[1]?.value.type === "text" ? loose.fields[1].value.text : "", "—");

  const peeled = parseSnippet('model_training\n{"update_frequency":"Daily"}');
  assert.equal(peeled?.title, "Model Training");
  assert.equal(
    peeled?.fields[0]?.value.type === "text" ? peeled.fields[0].value.text : "",
    "Daily",
  );
});

test("bare JSON blocks become fences without touching code samples", () => {
  const input = [
    "Here is the setup.",
    "",
    "{",
    '  "epochs": 200',
    "}",
    "",
    "```bash",
    "echo {hi}",
    "```",
    "",
    '{"tiny":1}',
    "",
    '{"minimum_history":"2 years of daily price data"}',
  ].join("\n");
  const out = promoteBareJsonBlocks(input);
  assert.match(out, /Here is the setup\./);
  assert.match(out, /```\n\{\n {2}"epochs": 200\n\}\n```/);
  assert.match(out, /```bash\necho \{hi\}\n```/);
  assert.match(out, /\{"tiny":1\}/);
  assert.match(out, /```\n\{"minimum_history":"2 years of daily price data"\}\n```/);
  assert.equal(promoteBareJsonBlocks(out), out);
  const streaming = '```json\n{\n  "a": 1\n}';
  assert.equal(promoteBareJsonBlocks(streaming), streaming);
  assert.equal(
    promoteBareJsonBlocks("Use {epochs: 200} in the note."),
    "Use {epochs: 200} in the note.",
  );
});

test("snippet JSON preserves commas that live inside strings", () => {
  const model = parseSnippet('{"note":"hello, }","ok":true,}') as SnippetModel;
  assert.equal(
    model.fields[0]?.value.type === "text" ? model.fields[0].value.text : "",
    "hello, }",
  );
  assert.match(model.json, /"hello, \}"/);
});
