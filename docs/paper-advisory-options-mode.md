# Paper advisory options mode

`PAPER_ADVISORY_OP2` is an explicit opt-in for using AlphaDesk's scanner-independent `paper_advisory_greeks_v1` assessment as a trade-quality gate on opening options orders in a verified PAPER account.

Configure `ALPHADESK_EXECUTION_MODE=PAPER_ADVISORY_OP2`, `ALPHADESK_ENABLED=true`, and `ALPHADESK_SIGNAL_QUALITY_ENABLED=true`. Keep the OpenProphet account's paper setting and operator authorization enabled separately. AlphaDesk's `execution_allowed=false`, `paper_only=true`, and `human_approval_required=true` metadata stays unchanged; a PASS is not broker authorization.

The agent assesses the exact proposal with `prophet_assess_options_trade`; FAIL or UNAVAILABLE skips the opening. On PASS it may attempt `prophet_place_options_order`. The broker boundary obtains and validates a fresh exact-proposal assessment, durably audits it, then rechecks policy, account identity, expiry, context, and regular-session clock before submission. Existing account permission, paper identity, risk, exposure, reservation, reconciliation, and managed-execution checks remain independently required. Unsupported proposals and any missing, invalid, stale, mismatched, or non-PASS receipt fail closed. Closing or reducing exposure continues through existing guarded close paths.

This mode does not change `ACCOUNT_VERIFIED`, `SIGNAL_QUALITY_OP2`, or execution-grade `STANDALONE_OP2`. It does not enable execution for live accounts, change Greek provenance, or activate agents automatically. Preview acceptance and runtime activation are separate operational steps; local mock tests are not real-market acceptance.
