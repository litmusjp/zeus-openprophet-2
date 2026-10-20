package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"strconv"
	"time"
)

type standaloneLock struct {
	gate       chan struct{}
	references int
}

type standaloneCacheEntry struct {
	document []byte
	expires  time.Time
}

func (c *AlphaDeskClient) standaloneNow() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}
func standaloneClone(data []byte) map[string]any {
	var doc map[string]any
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if d.Decode(&doc) != nil {
		return nil
	}
	return doc
}
func standaloneDiagnostics(doc map[string]any) map[string]any {
	if doc == nil || doc["decision"] != "PASS" {
		return doc
	}
	expiryText, _ := doc["expires_at"].(string)
	evidenceText, _ := doc["evidence_observed_at"].(string)
	expiry, e1 := time.Parse(time.RFC3339Nano, expiryText)
	evidenceAt, e2 := time.Parse(time.RFC3339Nano, evidenceText)
	if e1 != nil || e2 != nil {
		return doc
	}
	evidenceDeadline := evidenceAt.Add(brokerQuoteMaxAge)
	effective := expiry
	if evidenceDeadline.Before(effective) {
		effective = evidenceDeadline
	}
	doc["op2_evidence_deadline"] = evidenceDeadline.Format(time.RFC3339Nano)
	doc["op2_effective_expires_at"] = effective.Format(time.RFC3339Nano)
	return doc
}

func safeAssessmentDiagnosticText(value string, limit int, allowed string) string {
	if value == "" || len(value) > limit {
		return ""
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || containsRune(allowed, r)) {
			return ""
		}
	}
	return value
}

func containsRune(value string, target rune) bool {
	for _, r := range value {
		if r == target {
			return true
		}
	}
	return false
}

func safeAssessmentDiagnosticValue(value any) any {
	switch typed := value.(type) {
	case bool:
		return typed
	case json.Number:
		if number, err := typed.Float64(); err == nil && !math.IsNaN(number) && !math.IsInf(number, 0) {
			return typed
		}
	case float64:
		if !math.IsNaN(typed) && !math.IsInf(typed, 0) {
			return typed
		}
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return typed
	case string:
		return safeAssessmentDiagnosticText(typed, 128, " _.,:%/+()-")
	case map[string]any:
		allowed := map[string]bool{"open_interest": true, "quote_size": true, "bid_size": true, "ask_size": true, "delta": true, "gamma": true, "theta": true, "vega": true, "spread_ratio": true, "price": true, "volume": true, "tradable": true, "fresh": true, "status": true, "minimum": true, "maximum": true}
		clean := make(map[string]any)
		for key, item := range typed {
			if !allowed[key] {
				continue
			}
			if scalar := safeAssessmentDiagnosticValue(item); scalar != nil {
				clean[key] = scalar
			}
		}
		if len(clean) > 0 {
			return clean
		}
	}
	return nil
}

func addAssessmentReceiptDiagnostics(target *AlphaDeskUnavailableError, doc map[string]any) {
	if target == nil || doc == nil {
		return
	}
	if id, ok := doc["assessment_id"].(string); ok && standaloneAssessmentUUID.MatchString(id) {
		target.AssessmentID = id
	}
	if version, ok := doc["policy_version"].(string); ok {
		target.PolicyVersion = safeAssessmentDiagnosticText(version, 256, ":._-")
	}
	if retryable, ok := doc["retryable"].(bool); ok {
		target.Retryable = &retryable
	}
	if expires, ok := doc["expires_at"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, expires); err == nil {
			target.ExpiresAt = parsed.UTC()
		}
	}
	if evidence, ok := doc["evidence_observed_at"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, evidence); err == nil {
			target.EvidenceObservedAt = parsed.UTC()
		}
	}
	if reasons, ok := doc["blocking_reasons"].([]any); ok {
		for _, item := range reasons {
			if reason, ok := item.(string); ok {
				if safe := safeAssessmentDiagnosticText(reason, 128, "_.:-"); safe != "" {
					target.BlockingReasons = append(target.BlockingReasons, safe)
				}
			}
		}
	}
	if codes, ok := doc["failed_check_codes"].([]any); ok {
		for _, item := range codes {
			if code, ok := item.(string); ok {
				if safe := safeAssessmentDiagnosticText(code, 128, "_.:-"); safe != "" {
					target.FailedCheckCodes = append(target.FailedCheckCodes, safe)
				}
			}
		}
	}
	if checks, ok := doc["checks"].([]any); ok {
		for _, item := range checks {
			check, ok := item.(map[string]any)
			if !ok {
				continue
			}
			code, ok := check["code"].(string)
			if !ok {
				continue
			}
			code = safeAssessmentDiagnosticText(code, 128, "_.:-")
			if code == "" {
				continue
			}
			diagnostic := interfaces.AssessmentCheckDiagnostic{Code: code}
			if passed, ok := check["passed"].(bool); ok {
				diagnostic.Passed = &passed
			}
			diagnostic.Actual = safeAssessmentDiagnosticValue(check["actual"])
			diagnostic.Threshold = safeAssessmentDiagnosticValue(check["threshold"])
			target.AssessmentChecks = append(target.AssessmentChecks, diagnostic)
		}
	}
}
func standaloneKey(identity models.DurableIdentity, p StandaloneTradeProposal) string {
	data, _ := json.Marshal(struct {
		Identity models.DurableIdentity
		Proposal StandaloneTradeProposal
	}{identity, p})
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// Receipts are private to a verified backend account/sandbox. Restart drops the
// cache (safe reassessment); only the existing durable audit sink records submissions.
func (c *AlphaDeskClient) cachedStandalone(ctx context.Context, identity models.DurableIdentity, p StandaloneTradeProposal, verifyPolicy bool) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if identity.BrokerAccountID == "" || identity.SandboxID == "" || identity.TenantID == "" || identity.PaperLive != "paper" {
		return nil, &AlphaDeskUnavailableError{Reason: "Verified separate paper-account binding is required"}
	}
	key := standaloneKey(identity, p)
	c.standaloneMu.Lock()
	if c.standaloneCache == nil {
		c.standaloneCache = make(map[string]standaloneCacheEntry)
		c.standaloneLocks = make(map[string]*standaloneLock)
	}
	lock := c.standaloneLocks[key]
	if lock == nil {
		lock = &standaloneLock{gate: make(chan struct{}, 1)}
		c.standaloneLocks[key] = lock
	}
	lock.references++
	c.standaloneMu.Unlock()
	defer func() {
		c.standaloneMu.Lock()
		lock.references--
		if lock.references == 0 {
			delete(c.standaloneLocks, key)
		}
		c.standaloneMu.Unlock()
	}()
	select {
	case lock.gate <- struct{}{}:
		defer func() { <-lock.gate }()
	case <-ctx.Done():
		return nil, &AlphaDeskUnavailableError{Reason: "Standalone assessment deadline exceeded"}
	}
	c.standaloneMu.Lock()
	entry, found := c.standaloneCache[key]
	c.standaloneMu.Unlock()
	if found && c.standaloneNow().Before(entry.expires) {
		doc := standaloneClone(entry.document)
		receiptGate, receiptManaged, receiptErr := parseManagedApprovalGate(doc)
		if receiptErr != nil || (c.RequireManagedApprovalGate && !receiptManaged) {
			return nil, &AlphaDeskUnavailableError{Reason: "Managed AlphaDesk approval policy is invalid", Category: "response_validation", Stage: "approval_gate"}
		}
		if !verifyPolicy {
			if receiptManaged || c.RequireManagedApprovalGate {
				version, currentGate, err := c.standalonePolicyState(ctx)
				if err != nil {
					return nil, err
				}
				if currentGate == nil {
					return nil, &AlphaDeskUnavailableError{Reason: "Managed AlphaDesk approval policy is missing", Category: "configuration", Stage: "approval_gate"}
				}
				if currentGate.Required {
					if receiptManaged && sameManagedApprovalGate(receiptGate, *currentGate) && doc["decision"] == "UNAVAILABLE" {
						return standaloneDiagnostics(doc), nil
					}
					return nil, managedGateUnavailable("AlphaDesk human-review lock is ON", true)
				}
				if !receiptManaged || !sameManagedApprovalGate(receiptGate, *currentGate) || version != doc["policy_version"] {
					found = false
				} else {
					if err := c.standaloneFresh(ctx, doc); err != nil {
						return nil, err
					}
					return standaloneDiagnostics(doc), nil
				}
			} else {
				if err := c.standaloneFresh(ctx, doc); err != nil {
					return nil, err
				}
				return standaloneDiagnostics(doc), nil
			}
		} else {
			version, currentGate, err := c.standalonePolicyState(ctx)
			if err != nil {
				return nil, err
			}
			if currentGate != nil && currentGate.Required {
				return nil, managedGateUnavailable("AlphaDesk human-review lock is ON", true)
			}
			if version == doc["policy_version"] && ((!receiptManaged && currentGate == nil) || (receiptManaged && currentGate != nil && sameManagedApprovalGate(receiptGate, *currentGate))) {
				if err := c.standaloneFresh(ctx, doc); err != nil {
					return nil, err
				}
				return standaloneDiagnostics(doc), nil
			}
		}
	}
	doc, err := c.AssessOptionsTrade(ctx, p)
	if err != nil {
		return nil, err
	}
	if doc["decision"] == "PASS" && verifyPolicy {
		version, currentGate, err := c.standalonePolicyState(ctx)
		if err != nil {
			return nil, err
		}
		receiptGate, receiptManaged, receiptErr := parseManagedApprovalGate(doc)
		if receiptErr != nil || (c.RequireManagedApprovalGate && !receiptManaged) {
			return nil, &AlphaDeskUnavailableError{Reason: "Managed AlphaDesk approval policy is invalid", Category: "response_validation", Stage: "approval_gate"}
		}
		if currentGate != nil && currentGate.Required {
			return nil, managedGateUnavailable("AlphaDesk human-review lock is ON", true)
		}
		if version != doc["policy_version"] || (receiptManaged && (currentGate == nil || !sameManagedApprovalGate(receiptGate, *currentGate))) || (!receiptManaged && currentGate != nil) {
			return nil, &AlphaDeskUnavailableError{Reason: "Standalone policy changed during assessment"}
		}
	}
	if err := c.standaloneFresh(ctx, doc); err != nil {
		return nil, err
	}
	expiry := c.standaloneNow().Add(time.Second)
	if doc["decision"] == "PASS" {
		text, _ := doc["expires_at"].(string)
		expiry, _ = time.Parse(time.RFC3339Nano, text)
		evidenceText, _ := doc["evidence_observed_at"].(string)
		evidenceAt, parseErr := time.Parse(time.RFC3339Nano, evidenceText)
		if parseErr != nil || evidenceAt.After(c.standaloneNow()) || c.standaloneNow().Sub(evidenceAt) > brokerQuoteMaxAge {
			return nil, &AlphaDeskUnavailableError{Reason: "Standalone market evidence is stale or invalid"}
		}
		if ageExpiry := evidenceAt.Add(brokerQuoteMaxAge); ageExpiry.Before(expiry) {
			expiry = ageExpiry
		}
	}
	data, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	c.standaloneMu.Lock()
	// Bound the response cache. Locks stay stable while callers may own them.
	if len(c.standaloneCache) >= 128 {
		for old := range c.standaloneCache {
			delete(c.standaloneCache, old)
			break
		}
	}
	c.standaloneCache[key] = standaloneCacheEntry{data, expiry}
	c.standaloneMu.Unlock()
	return standaloneDiagnostics(standaloneClone(data)), nil
}
func (c *AlphaDeskClient) standaloneFresh(ctx context.Context, doc map[string]any) error {
	if ctx.Err() != nil {
		return &AlphaDeskUnavailableError{Reason: "Standalone assessment deadline exceeded"}
	}
	if doc["decision"] != "PASS" {
		return nil
	}
	expiryText, _ := doc["expires_at"].(string)
	evidenceText, _ := doc["evidence_observed_at"].(string)
	expiry, e1 := time.Parse(time.RFC3339Nano, expiryText)
	evidence, e2 := time.Parse(time.RFC3339Nano, evidenceText)
	now := c.standaloneNow()
	if e1 != nil || e2 != nil || !now.Before(expiry) || evidence.After(now) || now.Sub(evidence) > brokerQuoteMaxAge {
		if e1 == nil && e2 == nil && !now.Before(evidence.Add(brokerQuoteMaxAge)) {
			return &AlphaDeskUnavailableError{Reason: "OP2 market evidence deadline expired", Category: "response_validation", Stage: "evidence_observed_at"}
		}
		return &AlphaDeskUnavailableError{Reason: "Standalone receipt expired or evidence is stale"}
	}
	return nil
}
func (c *AlphaDeskClient) standalonePolicyState(ctx context.Context) (string, *managedApprovalGate, error) {
	unavailable := func() (string, *managedApprovalGate, error) {
		return "", nil, &AlphaDeskUnavailableError{Reason: "Current standalone policy is unavailable", Category: "configuration", Stage: "policy_version"}
	}
	if ValidateAlphaDeskURL(c.URL) != nil {
		return unavailable()
	}
	r, err := http.NewRequestWithContext(ctx, "GET", c.URL+"/api/v2/option-trade-assessments/policy", nil)
	if err != nil {
		return unavailable()
	}
	r.Header.Set("X-AlphaDesk-API-Key", c.APIKey)
	client := http.Client{Timeout: 5 * time.Second}
	if c.HTTP != nil {
		client = *c.HTTP
		client.Timeout = 5 * time.Second
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(r)
	if err != nil {
		return unavailable()
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return unavailable()
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 262145))
	if err != nil || len(data) > 262144 {
		return unavailable()
	}
	doc := standaloneClone(data)
	version, ok := doc["policy_version"].(string)
	managedGate, managed, gateErr := parseManagedApprovalGate(doc)
	if gateErr != nil || (c.RequireManagedApprovalGate && !managed) {
		return unavailable()
	}
	if managed {
		if version == "" || doc["scope"] != "TRADE_ASSESSMENT" || !validStandalonePolicy(doc["policy_snapshot"], version, func() float64 { n, _ := standaloneNumber(doc["minimum_passing_score"]); return n }()) {
			return unavailable()
		}
		return version, &managedGate, nil
	}
	if !ok || version == "" || doc["scope"] != "TRADE_ASSESSMENT" || doc["execution_allowed"] != false || !validStandalonePolicy(doc["policy_snapshot"], version, func() float64 { n, _ := standaloneNumber(doc["minimum_passing_score"]); return n }()) {
		return unavailable()
	}
	return version, nil, nil
}

func (c *AlphaDeskClient) standalonePolicyVersion(ctx context.Context) (string, error) {
	version, _, err := c.standalonePolicyState(ctx)
	return version, err
}
func (s *AlpacaTradingService) standaloneIdentity() models.DurableIdentity {
	mode := "live"
	if s.expectedPaper {
		mode = "paper"
	}
	return models.DurableIdentity{BrokerAccountID: s.expectedAccountID, PaperLive: mode, TenantID: s.expectedTenantID, SandboxID: s.expectedSandboxID}
}
func (s *AlpacaTradingService) AssessOptionsTradeReadOnly(ctx context.Context, p StandaloneTradeProposal) (map[string]any, error) {
	if s.alphaDesk == nil {
		return nil, &AlphaDeskUnavailableError{Reason: "Standalone assessment unavailable"}
	}
	return s.alphaDesk.cachedStandalone(ctx, s.standaloneIdentity(), p, false)
}

// ReadStandaloneAssessmentPolicy is scoped to the verified paper identity and
// calls only AlphaDesk's authenticated policy endpoint.
func (s *AlpacaTradingService) ReadStandaloneAssessmentPolicy(ctx context.Context) (map[string]any, error) {
	if s == nil || s.alphaDesk == nil || !s.expectedPaper || s.expectedAccountID == "" || s.expectedTenantID == "" || s.expectedSandboxID == "" {
		return nil, &AlphaDeskUnavailableError{Reason: "Standalone assessment policy is unavailable", Category: "configuration"}
	}
	return s.alphaDesk.ReadAssessmentPolicy(ctx)
}
func standaloneProposalForOrder(order *interfaces.OptionsOrder) (StandaloneTradeProposal, error) {
	if order == nil || order.LimitPrice == nil || order.Qty < 1 || math.Trunc(order.Qty) != order.Qty || order.Side != "buy" || order.Type != "limit" || order.PositionIntent != "buy_to_open" {
		return StandaloneTradeProposal{}, errors.New("Standalone guard supports opening long options and directional debit verticals with a limit")
	}
	p := StandaloneTradeProposal{Quantity: int(order.Qty), LimitPrice: json.Number(strconv.FormatFloat(*order.LimitPrice, 'f', -1, 64))}
	if order.ClientOrderID != "" {
		p.ClientReference = &order.ClientOrderID
	}
	if len(order.Legs) == 0 {
		p.Legs = []StandaloneTradeLeg{{Symbol: order.Symbol, Side: order.Side}}
	} else {
		for _, leg := range order.Legs {
			ratio := leg.RatioQty
			if (leg.Side == "buy" && leg.PositionIntent != "buy_to_open") || (leg.Side == "sell" && leg.PositionIntent != "sell_to_open") {
				return p, errors.New("Standalone debit vertical requires exact opening leg intents")
			}
			p.Legs = append(p.Legs, StandaloneTradeLeg{Symbol: leg.Symbol, Side: leg.Side, RatioQuantity: &ratio})
		}
	}
	return p, p.Validate()
}

// This path remains inactive unless an operator separately selects STANDALONE_OP2.
// Existing local permission, account/buying-power/exposure/session/reservation
// checks run before this helper; mandatory durable auditing runs before submission.
func (s *AlpacaTradingService) requireStandaloneApproval(ctx context.Context, order *interfaces.OptionsOrder) error {
	return s.requireStandaloneApprovalMode(ctx, order, false)
}

// requirePaperAdvisoryQualification treats a read-only PASS as a quality gate
// for locally authorized PAPER orders; it grants no broker permission.
func (s *AlpacaTradingService) requirePaperAdvisoryQualification(ctx context.Context, order *interfaces.OptionsOrder) error {
	return s.requireStandaloneApprovalMode(ctx, order, true)
}

func (s *AlpacaTradingService) requireStandaloneApprovalMode(ctx context.Context, order *interfaces.OptionsOrder, allowPaperAdvisory bool) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if order != nil {
		order.AlphaDeskAssessment = nil
	}
	approved := false
	defer func() {
		if !approved && order != nil {
			order.AlphaDeskAssessment = nil
		}
	}()
	if order == nil || !s.expectedPaper || s.policy == nil || s.alphaDesk == nil || !s.alphaDesk.Enabled || !s.alphaDesk.SignalQualityEnabled || order.AssessmentAuditSink == nil {
		return &AlphaDeskUnavailableError{Reason: "Standalone execution requires verified paper identity, local trading policy, enabled assessment and durable audit"}
	}
	localPolicy := *s.policy
	p, err := standaloneProposalForOrder(order)
	if err != nil {
		return &AlphaDeskUnavailableError{Reason: "Unsupported standalone opening proposal", Err: err}
	}
	doc, err := s.alphaDesk.cachedStandalone(ctx, s.standaloneIdentity(), p, true)
	if err != nil {
		return err
	}
	if doc["decision"] != "PASS" {
		decision, _ := doc["decision"].(string)
		if decision != "FAIL" && decision != "UNAVAILABLE" {
			decision = "UNAVAILABLE"
		}
		category := "assessment_unavailable"
		reason := "Standalone assessment did not approve this proposal"
		if decision == "UNAVAILABLE" {
			if blockers, ok := doc["blocking_reasons"].([]any); ok && len(blockers) == 1 && blockers[0] == "human_approval_required" {
				reason = "AlphaDesk human-review lock is ON; new options entries are unavailable"
				return &AlphaDeskUnavailableError{Reason: reason, Decision: decision, Category: "managed_review_required", Stage: "approval_gate"}
			}
		}
		if decision == "FAIL" {
			category = "assessment_rejected"
		}
		assessmentError := &AlphaDeskUnavailableError{Reason: reason, Decision: decision, Category: category, Stage: "decision"}
		addAssessmentReceiptDiagnostics(assessmentError, doc)
		return assessmentError
	}
	if doc["advisory_policy_profile"] == "paper_advisory_greeks_v1" && !allowPaperAdvisory {
		return &AlphaDeskUnavailableError{Reason: "Paper advisory assessment cannot authorize an order"}
	}
	managedGate, managed, gateErr := parseManagedApprovalGate(doc)
	if gateErr != nil || (s.alphaDesk.RequireManagedApprovalGate && !managed) {
		return &AlphaDeskUnavailableError{Reason: "Managed AlphaDesk approval receipt is missing or invalid", Category: "response_validation", Stage: "approval_gate"}
	}
	if allowPaperAdvisory {
		if managed {
			if managedGate.Required {
				return managedGateUnavailable("AlphaDesk human-review lock is ON", true)
			}
		} else if doc["advisory_policy_profile"] != "paper_advisory_greeks_v1" || doc["execution_allowed"] != false || doc["paper_only"] != true || doc["human_approval_required"] != true {
			return &AlphaDeskUnavailableError{Reason: "Standalone receipt is not a paper-only advisory assessment"}
		}
	}
	score, err := standaloneNumber(doc["signal_score"])
	if err != nil {
		return err
	}
	threshold, err := standaloneNumber(doc["minimum_passing_score"])
	if err != nil {
		return err
	}
	expiry, _ := time.Parse(time.RFC3339Nano, doc["expires_at"].(string))
	op2Expiry, _ := time.Parse(time.RFC3339Nano, doc["op2_effective_expires_at"].(string))
	observed, _ := time.Parse(time.RFC3339Nano, doc["observed_at"].(string))
	market, _ := time.Parse(time.RFC3339Nano, doc["evidence_observed_at"].(string))
	version, _ := doc["policy_version"].(string)
	id, _ := doc["assessment_id"].(string)
	a := &interfaces.AlphaDeskAssessment{Scope: "TRADE_ASSESSMENT", AssessmentID: id, Decision: "PASS", Pass: true, SignalScore: &score, Threshold: &threshold,
		Evidence: doc, Policy: doc["policy_snapshot"], PolicyVersion: version, ExpiresAt: expiry, OP2EffectiveExpiresAt: op2Expiry, ObservedAt: observed, MarketEvidenceAt: market,
		Fingerprint: OptionsOrderFingerprint(s.standaloneIdentity(), order), HumanApprovalRequired: !managed, ExecutionAllowed: false, ScoreSource: "alphadesk_direct_market_data", ScoreObservedAt: market,
		ManagedContract: managed, ManagedGateRequired: managedGate.Required, ManagedGateRevision: managedGate.Revision, ManagedGateWorkspaceID: managedGate.WorkspaceID, ManagedGateAssessmentKeyID: managedGate.AssessmentKeyID}
	auditBytes, err := json.Marshal(doc)
	if err != nil {
		return &AlphaDeskUnavailableError{Reason: "Standalone assessment audit evidence could not be copied", Err: err}
	}
	auditRecord := *a
	auditEvidence := standaloneClone(auditBytes)
	if auditEvidence == nil {
		return &AlphaDeskUnavailableError{Reason: "Standalone assessment audit evidence could not be copied"}
	}
	auditRecord.Evidence = auditEvidence
	auditRecord.Policy = auditEvidence["policy_snapshot"]
	if err := order.AssessmentAuditSink(&auditRecord); err != nil {
		return &AlphaDeskUnavailableError{Reason: "Standalone assessment audit failed", Err: err}
	}
	currentVersion, currentGate, err := s.alphaDesk.standalonePolicyState(ctx)
	if err != nil || currentVersion != version {
		return &AlphaDeskUnavailableError{Reason: "Standalone policy changed during final audit", Err: err}
	}
	if managed && (currentGate == nil || currentGate.Required || !sameManagedApprovalGate(managedGate, *currentGate)) {
		return managedGateUnavailable("Managed AlphaDesk approval policy changed during final audit", currentGate != nil && currentGate.Required)
	}
	if s.policy == nil || *s.policy != localPolicy {
		return &AlphaDeskUnavailableError{Reason: "Local trading policy changed during final audit"}
	}
	finalProposal, err := standaloneProposalForOrder(order)
	if err != nil || !sameStandaloneTrade(p, finalProposal) || OptionsOrderFingerprint(s.standaloneIdentity(), order) != a.Fingerprint {
		return &AlphaDeskUnavailableError{Reason: "Standalone proposal or account changed during final audit", Err: err}
	}
	if err := s.alphaDesk.standaloneFresh(ctx, doc); err != nil {
		return err
	}
	order.AlphaDeskAssessment = a
	approved = true
	return nil
}

func (s *AlpacaTradingService) validatePaperAdvisoryReceipt(ctx context.Context, order *interfaces.OptionsOrder) error {
	a := order.AlphaDeskAssessment
	if a == nil || !a.Pass || a.Decision != "PASS" || a.ExecutionAllowed || (!a.ManagedContract && !a.HumanApprovalRequired) || a.Scope != "TRADE_ASSESSMENT" {
		return &AlphaDeskUnavailableError{Reason: "Paper advisory assessment is unavailable at submission boundary"}
	}
	doc, ok := a.Evidence.(map[string]any)
	if !ok || doc["decision"] != "PASS" || doc["advisory_policy_profile"] != "paper_advisory_greeks_v1" || doc["paper_only"] != true || doc["policy_version"] != a.PolicyVersion {
		return &AlphaDeskUnavailableError{Reason: "Trusted paper advisory receipt changed before submission"}
	}
	gate, managed, gateErr := parseManagedApprovalGate(doc)
	if gateErr != nil || managed != a.ManagedContract || (s.alphaDesk.RequireManagedApprovalGate && !managed) {
		return &AlphaDeskUnavailableError{Reason: "Trusted managed approval receipt changed before submission", Category: "response_validation", Stage: "approval_gate"}
	}
	if managed {
		if gate.Required || a.ManagedGateRequired || gate.Revision != a.ManagedGateRevision || gate.WorkspaceID != a.ManagedGateWorkspaceID || gate.AssessmentKeyID != a.ManagedGateAssessmentKeyID {
			return managedGateUnavailable("Managed AlphaDesk receipt is locked or its scope changed", gate.Required)
		}
	} else if doc["execution_allowed"] != false || doc["paper_only"] != true || doc["human_approval_required"] != true {
		return &AlphaDeskUnavailableError{Reason: "Trusted paper advisory receipt changed before submission"}
	}
	if err := s.alphaDesk.standaloneFresh(ctx, doc); err != nil {
		return err
	}
	p, err := standaloneProposalForOrder(order)
	if err != nil || OptionsOrderFingerprint(s.standaloneIdentity(), order) != a.Fingerprint || doc["trade_fingerprint"] != standaloneProposalFingerprint(p) {
		return &AlphaDeskUnavailableError{Reason: "Paper advisory proposal changed before submission", Err: err}
	}
	return nil
}

// Recheck policy after durable submission-marker work. The caller follows this
// potentially blocking read with the final session, context and receipt checks.
func (s *AlpacaTradingService) validatePaperAdvisoryAtSubmission(ctx context.Context, order *interfaces.OptionsOrder) error {
	if !s.expectedPaper || s.alphaDesk == nil || !s.alphaDesk.Enabled || !s.alphaDesk.SignalQualityEnabled {
		return &AlphaDeskUnavailableError{Reason: "Paper advisory authorization is unavailable at submission boundary"}
	}
	if err := s.validatePaperAdvisoryReceipt(ctx, order); err != nil {
		return err
	}
	version, currentGate, err := s.alphaDesk.standalonePolicyState(ctx)
	if err != nil || version != order.AlphaDeskAssessment.PolicyVersion {
		return &AlphaDeskUnavailableError{Reason: "Managed AlphaDesk policy changed or is unknown before paper order submission", Err: err, Decision: "UNAVAILABLE", Category: "upstream_service_error", Stage: "approval_gate"}
	}
	if order.AlphaDeskAssessment.ManagedContract {
		assessment := order.AlphaDeskAssessment
		if currentGate == nil || currentGate.Required || assessment.ManagedGateRequired || currentGate.Revision != assessment.ManagedGateRevision || currentGate.WorkspaceID != assessment.ManagedGateWorkspaceID || currentGate.AssessmentKeyID != assessment.ManagedGateAssessmentKeyID {
			reason := "Managed AlphaDesk policy changed or is unknown before broker submission; refresh policy and requalify the proposal"
			if currentGate != nil && currentGate.Required {
				reason = "AlphaDesk human-review lock is ON; new entries are paused until an operator changes the gate"
			}
			return managedGateUnavailable(reason, currentGate != nil && currentGate.Required)
		}
	} else if s.alphaDesk.RequireManagedApprovalGate || currentGate != nil {
		return &AlphaDeskUnavailableError{Reason: "Managed AlphaDesk policy is required but unavailable", Category: "configuration", Stage: "approval_gate"}
	}
	return nil
}
