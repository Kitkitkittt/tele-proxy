# Langfuse v4 OTLP mapping

Application dependency pins: `@opentelemetry/api@1.9.0`, `@opentelemetry/sdk-trace-base@2.2.0`, `@opentelemetry/resources@2.2.0`, `@opentelemetry/exporter-trace-otlp-http@0.208.0`. Mapping revision1 is implemented explicitly, without duplicate automatic instrumentation or a direct Langfuse SDK/exporter. The SDK JSON exporter uses its explicit full URL unchanged: gateway → Alloy `/v1/traces`; Alloy → Langfuse `/api/public/otel/v1/traces`. Only Alloy has Langfuse Basic authentication and `x-langfuse-ingestion-version: 4`. Do not double-append `/v1/traces`.

| Gateway evidence | OTel / Langfuse mapping |
|---|---|
| One logical request | `gateway.request`, `langfuse.observation.type=span`; **no** model, usage or cost attributes |
| Each actual dispatch | `gateway.generation`, `langfuse.observation.type=generation`, parent is request root with same trace ID |
| Actual provider/model | `gen_ai.provider.name`, `gen_ai.request.model`, optional `gen_ai.response.model`; top-level `langfuse.observation.metadata.actual_model` |
| Policy snapshot | `langfuse.trace.metadata.policy_id`, `.policy_version`, `.policy_hash` copied onto root and every attempt; never policy text |
| Queryable request/combo | `langfuse.trace.metadata.request_id`, `.combo`; no arbitrary project/session headers |
| Known token usage | JSON `langfuse.observation.usage_details`; input/output inclusive; explicit `total=input+output` prevents cache/reasoning subsets from being counted again |
| Upstream first content | `langfuse.observation.completion_start_time`; separate upstream/client Prometheus histograms |
| Error | OTel status ERROR plus finite `gateway.error_class`; no status message/raw exception |

## Cost safety

Langfuse's default model catalog can infer reference prices when explicit cost is missing. Unknown must **not** be represented as an explicit zero to suppress that inference. Therefore the Langfuse display model is deliberately namespaced `tele-proxy-unpriced::<provider>::<actual-model>`. The original model remains in native GenAI attributes and queryable actual-model metadata. Do not create Langfuse pricing patterns matching `tele-proxy-unpriced::`; the separate gateway ledger is the authoritative multi-basis accounting source.

Known USD provider-reported charge has priority over a known configured metered estimate. Integer micro-currency values are divided by1e6 only for telemetry display. `langfuse.observation.cost_details` is JSON `{total: <amount>}` **only** for a supported known USD amount, including explicit zero. Non-USD or unknown/incomplete costs omit cost_details entirely, with `langfuse.observation.metadata.cost_status=unknown` and `.cost_basis=unknown`. Known basis is `provider_reported_charge` or `metered_estimate`. Fixed subscription fees, reference API-equivalent value and local allocations never populate the built-in cost field. A missing cost field does not mean free.

The request parent has no usage/cost fields and is explicitly a span, not a generation. Two actual dispatches create exactly two generations and no duplicate parent cost. End methods ignore duplicate finalization; exporter retries never write accounting. A gateway tool-call event does not claim execution.

## Validation boundary

`tests/unit/gateway-telemetry.test.js` covers allowlisting, inclusive totals, unknown versus explicit zero, non-USD omission, deduplicated finalization, metrics auth and bounded exporter outage queues. The isolated canary's OTLP JSON sink can assert parent links and generation counts without a running Langfuse backend. Unit/mock verification is **not** evidence that Langfuse v4 ingestion, UI cost inference or retention was exercised. Run that compatibility acceptance against the exact Compose pin before promotion; no backend deployment is claimed here.

Official source contract: [OTLP endpoint and attribute mapping](https://langfuse.com/integrations/native/opentelemetry), [usage/cost inference and ingested precedence](https://langfuse.com/docs/observability/features/token-and-cost-tracking). Documentation is mutable; revalidate attribute precedence and namespaced-model price isolation on upgrades.
