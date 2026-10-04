# Diagnostic remediation in this checkout

This source patch has not been committed, deployed or exercised against a broker. Hermes owns review and release. Paper accounts remain separate; live execution remains disabled by the existing policy and account binding.

## AlphaDesk activation

`ALPHADESK_EXECUTION_MODE` defaults to `ACCOUNT_VERIFIED`. The existing `ALPHADESK_SIGNAL_QUALITY_ENABLED=true` alone does not switch the final broker boundary. `SIGNAL_QUALITY_OP2` is a deployment-only opt-in that also requires the existing signal-quality flag and a sandbox-enabled AlphaDesk plugin. Unknown mode values fail closed for opening options orders. Keep the new mode **inactive** in the deployed environment until separate user approval. There is no UI/config activation path.

When explicitly enabled, the final options broker boundary obtains fresh broker evidence, requires validated AlphaDesk `SIGNAL_QUALITY` PASS, persists the unmodified provider assessment, and still applies OP2 paper identity, permission, broker clock, risk, reconciliation and durable submission checks. FAIL, UNAVAILABLE, missing or stale score/evidence, identity mismatch and audit failure block submission. AlphaDesk's `execution_allowed` and `human_approval_required` fields remain provider-owned. The default account-verified flow remains in place.

The agent options tool remains single-leg. Broker atomic multi-leg support is not exposed to agents, and independent single-leg submissions must not stand in for a spread. Stock orders do not gain AlphaDesk assessment. A new intent needs its own stable client order ID; only an eligible reconciled planned intent can reuse its immutable ID. Never blindly retry an uncertain submission.

The saved-settings AlphaDesk test sends a deliberately invalid request to the existing assessment path with the saved key. It sends no market evidence or order, follows no redirects and saves nothing. A schema rejection cannot prove authentication or live market-data readiness, so it reports capability unverified. A validated authenticated read capability in the provider contract is required before displaying a positive readiness result.

## Local verification and remaining acceptance

Focused RED commands and expected failures before the corresponding changes:

| Command | Initial failure |
| --- | --- |
| `go test ./controllers -run TestGetOrdersActiveAndOpenIncludeWorkingBrokerOrdersOnly -count=1` | `active/open` hid broker `new` and other working orders. |
| `go test ./services -run TestDoProviderRequestRejectsOversizeWithoutRetry -count=1` | Oversized 2xx body returned a truncated success. |
| `go test ./services -run TestAlphaDeskExecutionModeRequiresSeparateDeploymentOptIn -count=1` | The separate execution mode did not exist. |
| `node --test test/dashboard-sandbox-race.test.mjs` | Delayed L1 dashboard response repainted L2. |
| `node --test test/options-agent-contract.test.mjs` | Single-leg and new-ID rules were absent from the exposed schema. |
| `go test ./services -run 'TestSignalQualityOP2FinalBrokerBoundary/unknown_mode_with_plugin_disabled' -count=1` | Invalid mode could reach the broker with the plugin disabled. |
| `go test ./services -run 'TestSignalQualityOP2FinalBrokerBoundary/signal_mode_with_plugin_disabled' -count=1` | Explicit signal mode could reach the broker without an assessment. |

The equivalent focused GREEN tests passed. Final offline gates: Node 22 `--test --test-concurrency=1 test/*.test.mjs` passed **149/149, 0 skipped** after the final UI follow-up (late failed responses, null heartbeat scheduling, and uncached sandbox selection); `go test ./...` and `go vet ./...` passed; `gofmt -l .` produced no files and `git diff --check` passed. The Go CI formatter initially listed 52 tracked files; only those candidates were formatted.

Market-open options evidence, a fresh AlphaDesk assessment, paper-order acknowledgement and broker-confirmed fill are not established by offline tests. Any paper execution and deployment need separate authorization and review. SSE recovery was limited to clearing stale countdowns and refreshing state when the stream reconnects; the transport cause was not diagnosed here.

## Changed-file inventory

Behavior, contract, tests and documentation: agent/alphadesk-connection.js, agent/harness.js, agent/orchestrator.js, agent/public/index.html, agent/server.js, controllers/order_controller.go, controllers/order_controller_test.go, docs/diagnostic-remediation-2026-10.md, mcp-server.js, services/alpaca_trading.go, services/alphadesk.go, services/alphadesk_test.go, services/alphadesk_execution_mode_test.go, services/provider_retry.go, services/provider_retry_test.go, test/alphadesk-connection.test.mjs, test/alphadesk-ui.test.mjs, test/dashboard-sandbox-race.test.mjs, test/options-agent-contract.test.mjs, test/options-reliability.test.mjs, test/tool-discoverability.test.mjs.

CI formatting only (47 tracked Go files): cmd/bot/main.go, cmd/bot/main_test.go, cmd/openprophet/main.go, cmd/openprophet/main_test.go, config/config.go, config/config_test.go, controllers/activity_controller.go, controllers/cancel_order_safety_test.go, controllers/economic_feeds_controller.go, controllers/intelligence_controller.go, controllers/managed_position_boundary_test.go, controllers/news_controller.go, controllers/options_assessment_validation_test.go, controllers/options_order_test.go, controllers/position_controller.go, controllers/test_identity_test.go, database/storage.go, database/storage_test.go, database/test_identity_test.go, interfaces/options.go, interfaces/trading.go, models/models.go, services/account_reservation_lock_unix.go, services/account_reservation_lock_windows.go, services/activity_logger.go, services/alpaca_data.go, services/alpaca_options_chain_regression_test.go, services/alpaca_options_data.go, services/audit_fixes_test.go, services/cancellation_readback_test.go, services/close_regression_test.go, services/economic_feeds.go, services/gemini_service.go, services/news_service.go, services/options_order_safety_test.go, services/position_close_boundary_test.go, services/position_manager.go, services/position_manager_test.go, services/protection_readiness_test.go, services/result_identity_regression_test.go, services/risk_lifecycle_test.go, services/stock_analysis_service.go, services/submission_boundary_test.go, services/technical_analysis.go, services/test_identity_test.go, services/trading_policy.go, services/trading_policy_test.go.
