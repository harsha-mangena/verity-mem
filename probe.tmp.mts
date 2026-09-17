import { OnnxEntailmentBackend, renderStatement } from "./packages/gate/src/index.ts";
const backend = await OnnxEntailmentBackend.load({
  modelPath: ".veritymem/models/nli-deberta-v3-base/model_qint8_arm64.onnx",
  tokenizerPath: ".veritymem/models/nli-deberta-v3-base/tokenizer.json",
  entailmentThreshold: 0.5, contradictionThreshold: 0.5,
});
const pairs: [string, string, string, unknown][] = [
  ["Seat preference recorded for user alice: aisle.", "user:alice", "seat.preference", "aisle"],
  ["Seat preference recorded for user alice: window.", "user:alice", "seat.preference", "window"],
  ["Seat preference recorded for user carol: middle.", "user:carol", "seat.preference", "middle"],
  ["Deploy window recorded for service payments: 03:00 UTC.", "service:payments", "deploy.window", "03:00 UTC"],
  ["Build target recorded for service payments: java-23.", "service:payments", "build.target", "java-23"],
  ["Escalation contact recorded for user erin: 14 Rosewood Lane, Bristol.", "user:erin", "escalation.contact", "14 Rosewood Lane, Bristol"],
  ["Performance review date recorded for user gina: 2026-10-01.", "user:gina", "review.date", "2026-10-01"],
  ["Release decision recorded for release:2026-Q4: drops legacy billing table = yes.", "release:2026-Q4", "drops_legacy_billing_table", "yes"],
  ["Release decision recorded for release:2026-Q4: drops legacy billing table = no.", "release:2026-Q4", "drops_legacy_billing_table", "no"],
  ["Release preference recorded for user alice: skip the smoke test step when CI is green.", "user:alice", "release.skip_smoke_test", "skip the smoke test step when CI is green"],
  ["Release config: the deploy window for payments moved to 03:00 UTC.", "service:payments", "deploy.window", "03:00 UTC"],
];
for (const [premise, subject, predicate, object] of pairs) {
  const v = await backend.entails({ premise, hypothesis: renderStatement(subject, predicate, object), proposition: renderStatement("", predicate, object) });
  console.log(`${v.result.padEnd(13)} ${v.score.toFixed(3)}  ${JSON.stringify(renderStatement("", predicate, object))}  <- ${JSON.stringify(premise.slice(0, 55))}`);
}
