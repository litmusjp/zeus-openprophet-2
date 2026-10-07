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
		if !verifyPolicy {
			return doc, nil
		}
		version, err := c.standalonePolicyVersion(ctx)
		if err != nil {
			return nil, err
		}
		if version == doc["policy_version"] {
			if err := c.standaloneFresh(ctx, doc); err != nil {
				return nil, err
			}
			return doc, nil
		}
	}
	doc, err := c.AssessOptionsTrade(ctx, p)
	if err != nil {
		return nil, err
	}
	if doc["decision"] == "PASS" && verifyPolicy {
		version, err := c.standalonePolicyVersion(ctx)
		if err != nil {
			return nil, err
		}
		if version != doc["policy_version"] {
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
	return standaloneClone(data), nil
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
		return &AlphaDeskUnavailableError{Reason: "Standalone receipt expired or evidence is stale"}
	}
	return nil
}
func (c *AlphaDeskClient) standalonePolicyVersion(ctx context.Context) (string, error) {
	unavailable := func() (string, error) {
		return "", &AlphaDeskUnavailableError{Reason: "Current standalone policy is unavailable"}
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
	if !ok || version == "" || doc["scope"] != "TRADE_ASSESSMENT" || doc["execution_allowed"] != false || !validStandalonePolicy(doc["policy_snapshot"], version, func() float64 { n, _ := standaloneNumber(doc["minimum_passing_score"]); return n }()) {
		return unavailable()
	}
	return version, nil
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
		return &AlphaDeskUnavailableError{Reason: "Standalone assessment is not PASS"}
	}
	if doc["advisory_policy_profile"] == "paper_advisory_greeks_v1" {
		return &AlphaDeskUnavailableError{Reason: "Paper advisory assessment cannot authorize an order"}
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
	observed, _ := time.Parse(time.RFC3339Nano, doc["observed_at"].(string))
	market, _ := time.Parse(time.RFC3339Nano, doc["evidence_observed_at"].(string))
	version, _ := doc["policy_version"].(string)
	id, _ := doc["assessment_id"].(string)
	a := &interfaces.AlphaDeskAssessment{Scope: "TRADE_ASSESSMENT", AssessmentID: id, Decision: "PASS", Pass: true, SignalScore: &score, Threshold: &threshold,
		Evidence: doc, Policy: doc["policy_snapshot"], PolicyVersion: version, ExpiresAt: expiry, ObservedAt: observed, MarketEvidenceAt: market,
		Fingerprint: OptionsOrderFingerprint(s.standaloneIdentity(), order), HumanApprovalRequired: true, ExecutionAllowed: false, ScoreSource: "alphadesk_direct_market_data", ScoreObservedAt: market}
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
	currentVersion, err := s.alphaDesk.standalonePolicyVersion(ctx)
	if err != nil || currentVersion != version {
		return &AlphaDeskUnavailableError{Reason: "Standalone policy changed during final audit", Err: err}
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
