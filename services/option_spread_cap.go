package services

import (
	"prophet-trader/interfaces"

	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/shopspring/decimal"
)

// OP2 owns the entry spread cap. The number is the sandbox's saved maxOptionSpreadPct; it reaches this
// backend through OPENPROPHET_MAX_OPTION_SPREAD_PCT at start and through the authenticated risk endpoint
// when the setting is saved while the backend is running. The spread itself is AlphaDesk's own observation
// of the exact contract (the receipt's leg_N_quote value), so one sample and one number decide.

const (
	optionSpreadCapEnv         = "OPENPROPHET_MAX_OPTION_SPREAD_PCT"
	MinOptionSpreadCapPct      = 2.0
	MaxOptionSpreadCapPct      = 25.0
	scoreProfileV1             = "catalyst_momentum_v1"
	scoreProfileV2             = "catalyst_momentum_v2"
	optionSpreadAboveCapCode   = "OPTION_SPREAD_ABOVE_CAP"
	optionSpreadEvidenceCode   = "OPTION_SPREAD_EVIDENCE_INVALID"
	optionSpreadCapConfigErr   = "OPTION_SPREAD_CAP_INVALID"
	optionSpreadCapChanged     = "OPTION_SPREAD_CAP_CHANGED"
	optionSpreadCapRevision    = "OPTION_SPREAD_CAP_REVISION_REQUIRED"
	optionSpreadCapUnsupported = "OPTION_SPREAD_CAP_UNSUPPORTED_MODE"
)

// optionSpreadCapState is the cap this backend enforces. `revision` counts every change of the enforced value (a new
// value, or the first one after the cap was unset or invalid); an unchanged value keeps its revision. An opening carries
// the revision that was confirmed for it, and the backend refuses it if the enforced cap has changed since.
type optionSpreadCapState struct {
	mu         sync.RWMutex
	pct        decimal.Decimal
	configured bool
	invalid    bool
	revision   int64
}

func (c *optionSpreadCapState) get() (decimal.Decimal, bool, bool) {
	pct, configured, invalid, _ := c.snapshot()
	return pct, configured, invalid
}

// snapshot reads the value and its revision together.
func (c *optionSpreadCapState) snapshot() (decimal.Decimal, bool, bool, int64) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.pct, c.configured, c.invalid, c.revision
}

// OptionSpreadCapError is a deterministic local rejection of an opening order; it never involves AlphaDesk's decision.
type OptionSpreadCapError struct {
	Code    string
	Message string
}

func (e *OptionSpreadCapError) Error() string { return e.Code + ": " + e.Message }

func validOptionSpreadCapPct(pct float64) bool {
	return !math.IsNaN(pct) && !math.IsInf(pct, 0) && pct >= MinOptionSpreadCapPct && pct <= MaxOptionSpreadCapPct
}

// SetOptionSpreadCapPct changes the cap at run time (the sandbox's saved setting was just changed).
func (s *AlpacaTradingService) SetOptionSpreadCapPct(pct float64) error {
	if !validOptionSpreadCapPct(pct) {
		return fmt.Errorf("option spread cap must be from %v to %v percent", MinOptionSpreadCapPct, MaxOptionSpreadCapPct)
	}
	s.optionSpreadCap.mu.Lock()
	defer s.optionSpreadCap.mu.Unlock()
	next := decimal.NewFromFloat(pct)
	if !s.optionSpreadCap.configured || s.optionSpreadCap.invalid || !s.optionSpreadCap.pct.Equal(next) {
		s.optionSpreadCap.revision++
	}
	s.optionSpreadCap.pct = next
	s.optionSpreadCap.configured = true
	s.optionSpreadCap.invalid = false
	return nil
}

// OptionSpreadCapState reports the enforced cap and its revision from one consistent read.
func (s *AlpacaTradingService) OptionSpreadCapState() (pct float64, configured bool, invalid bool, revision int64) {
	value, configured, invalid, revision := s.optionSpreadCap.snapshot()
	f, _ := value.Float64()
	return f, configured, invalid, revision
}

// OptionSpreadCapRevision reports the revision of the enforced cap.
func (s *AlpacaTradingService) OptionSpreadCapRevision() int64 {
	_, _, _, revision := s.optionSpreadCap.snapshot()
	return revision
}

// OptionSpreadCapPct reports the effective cap (configured is false when none was supplied).
func (s *AlpacaTradingService) OptionSpreadCapPct() (pct float64, configured bool, invalid bool) {
	value, configured, invalid := s.optionSpreadCap.get()
	f, _ := value.Float64()
	return f, configured, invalid
}

// LoadOptionSpreadCapFromEnv applies the start-up value. A missing variable means no cap was supplied (the
// agent server always supplies one); a malformed value refuses every opening instead of silently dropping the cap.
func (s *AlpacaTradingService) LoadOptionSpreadCapFromEnv() {
	raw, present := os.LookupEnv(optionSpreadCapEnv)
	if !present || strings.TrimSpace(raw) == "" {
		return
	}
	pct, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || !validOptionSpreadCapPct(pct) {
		s.optionSpreadCap.mu.Lock()
		s.optionSpreadCap.invalid = true
		s.optionSpreadCap.revision++
		s.optionSpreadCap.mu.Unlock()
		return
	}
	_ = s.SetOptionSpreadCapPct(pct)
}

var optionSpreadLegCheck = regexp.MustCompile(`^leg_([0-9]+)_quote$`)

func spreadDecimal(v any) (decimal.Decimal, error) {
	switch n := v.(type) {
	case json.Number:
		return decimal.NewFromString(string(n))
	case string:
		return decimal.NewFromString(strings.TrimSpace(n))
	}
	return decimal.Zero, errors.New("not a number")
}

// optionSpreadRatios returns AlphaDesk's observed (ask - bid) / mid for every leg of the proposal, read from the
// receipt's leg_N_quote checks. Each leg must have exactly one passed check with a finite, non-negative value.
func optionSpreadRatios(p StandaloneTradeProposal, doc map[string]any) ([]decimal.Decimal, error) {
	checks, ok := doc["checks"].([]any)
	if !ok {
		return nil, errors.New("the receipt has no checks")
	}
	count := len(p.Legs)
	ratios := make([]decimal.Decimal, count)
	seen := make([]bool, count)
	for _, entry := range checks {
		check, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		code, _ := check["code"].(string)
		match := optionSpreadLegCheck.FindStringSubmatch(code)
		if match == nil {
			continue
		}
		index, err := strconv.Atoi(match[1])
		if err != nil || index < 0 || index >= count {
			return nil, fmt.Errorf("the receipt has an unexpected quote check %q", code)
		}
		if seen[index] {
			return nil, fmt.Errorf("the receipt repeats the quote check for leg %d", index)
		}
		if check["passed"] != true {
			return nil, fmt.Errorf("the quote check for leg %d did not pass", index)
		}
		ratio, err := spreadDecimal(check["actual"])
		if err != nil || ratio.IsNegative() {
			return nil, fmt.Errorf("the quote check for leg %d has no usable spread value", index)
		}
		ratios[index], seen[index] = ratio, true
	}
	for index, ok := range seen {
		if !ok {
			return nil, fmt.Errorf("the receipt has no quote check for leg %d", index)
		}
	}
	return ratios, nil
}

var spreadAgreement = decimal.New(1, -9)

// verifyOptionQuoteBlock cross-checks a v2 receipt's explicit per-leg quote block against the check values, leg by leg:
// quote N is the quote behind the leg_N_quote check, so its recomputed spread must equal that check's value (never a
// comparison of sorted values). Its symbol and side must be one of the proposal's legs, each used exactly once.
func verifyOptionQuoteBlock(p StandaloneTradeProposal, doc map[string]any, ratios []decimal.Decimal) error {
	quotes, ok := doc["option_quotes"].([]any)
	if !ok || len(quotes) != len(p.Legs) || len(ratios) != len(quotes) {
		return errors.New("the receipt has no per-leg quote block")
	}
	want := map[string]string{}
	for _, leg := range p.Legs {
		want[leg.Symbol] = leg.Side
	}
	got := map[string]bool{}
	two := decimal.NewFromInt(2)
	for index, entry := range quotes {
		quote, ok := entry.(map[string]any)
		if !ok {
			return errors.New("the per-leg quote block is malformed")
		}
		symbol, _ := quote["symbol"].(string)
		side, _ := quote["side"].(string)
		wantSide, known := want[symbol]
		if !known || got[symbol] || side != wantSide {
			return errors.New("the per-leg quote block does not match the proposed contracts and sides")
		}
		got[symbol] = true
		bid, bidErr := spreadDecimal(quote["bid"])
		ask, askErr := spreadDecimal(quote["ask"])
		if bidErr != nil || askErr != nil || !bid.IsPositive() || ask.LessThan(bid) {
			return errors.New("the per-leg quote block has a crossed or non-positive quote")
		}
		recomputed := ask.Sub(bid).Div(ask.Add(bid).Div(two))
		if recomputed.Sub(ratios[index]).Abs().GreaterThan(spreadAgreement) {
			return fmt.Errorf("quote %d disagrees with the receipt's leg_%d_quote check", index, index)
		}
	}
	return nil
}

// enforceOptionSpreadCap refuses an opening whose worst-leg spread, on AlphaDesk's own quote, is above the cap.
// Equal passes. Closing and reducing orders never reach this check.
func (s *AlpacaTradingService) enforceOptionSpreadCap(p StandaloneTradeProposal, doc map[string]any) error {
	capPct, configured, invalid, _ := s.optionSpreadCap.snapshot()
	return enforceOptionSpreadCapAt(capPct, configured, invalid, p, doc)
}

func isOptionsOpening(order *interfaces.OptionsOrder) bool {
	return order != nil && strings.HasSuffix(order.PositionIntent, "_to_open")
}

// optionSpreadCapRejection is a pre-submission rejection that never involves AlphaDesk's decision.
func optionSpreadCapRejection(code, message string) error {
	return &PreSubmissionRejectionError{Err: &OptionSpreadCapError{Code: code, Message: message}}
}

// optionSpreadCapModeSupported: the cap is judged on AlphaDesk's quote in the standalone receipt, so only the execution modes
// that take that receipt can apply it.
func (s *AlpacaTradingService) optionSpreadCapModeSupported() bool {
	return s.alphaDesk != nil && s.alphaDesk.Enabled && s.alphaDesk.SignalQualityEnabled &&
		(s.alphaDesk.ExecutionMode == "STANDALONE_OP2" || s.alphaDesk.ExecutionMode == "PAPER_ADVISORY_OP2")
}

// checkOptionSpreadCapBoundary is the common options-opening boundary, run before any mode-specific work. While a cap is in
// force (or its configuration is invalid) an opening is refused unless the execution mode can apply the cap and the opening
// carries the revision confirmed for it. The revision's value is validated again, under the cap lease, right before dispatch.
// Exits and reducing orders never reach a refusal here.
func (s *AlpacaTradingService) checkOptionSpreadCapBoundary(order *interfaces.OptionsOrder) error {
	if !isOptionsOpening(order) {
		return nil
	}
	_, configured, invalid, _ := s.optionSpreadCap.snapshot()
	if invalid {
		return optionSpreadCapRejection(optionSpreadCapConfigErr, "OP2's option spread cap setting is invalid, so new options entries are refused until it is corrected.")
	}
	if !configured {
		return nil
	}
	if !s.optionSpreadCapModeSupported() {
		return optionSpreadCapRejection(optionSpreadCapUnsupported, "an entry spread cap is in force but this execution mode cannot apply it (it needs the standalone or paper advisory AlphaDesk assessment), so new options entries are refused. Nothing was submitted.")
	}
	if order.CapRevision == nil {
		return optionSpreadCapRejection(optionSpreadCapRevision, "this opening carries no confirmation of OP2's entry spread cap, so it is refused; confirm the cap and retry. Nothing was submitted.")
	}
	return nil
}

// leaseOptionSpreadCap validates the confirmed revision under a read lock on the cap state and returns a release function that
// keeps the lock until the broker call has returned. SetOptionSpreadCapPct takes the write lock, so a cap change that arrives
// after this final check waits for the dispatch to finish; one that arrived before it fails the revision comparison. Nothing
// between the lease and the release may read the cap state (a waiting writer would block that read behind the lease).
func (s *AlpacaTradingService) leaseOptionSpreadCap(order *interfaces.OptionsOrder) (func(), error) {
	noop := func() {}
	if !isOptionsOpening(order) {
		return noop, nil
	}
	if s.capLeaseHook != nil {
		s.capLeaseHook()
	}
	c := &s.optionSpreadCap
	c.mu.RLock()
	if c.invalid {
		c.mu.RUnlock()
		return noop, optionSpreadCapRejection(optionSpreadCapConfigErr, "OP2's option spread cap setting is invalid, so new options entries are refused until it is corrected.")
	}
	if !c.configured {
		c.mu.RUnlock()
		return noop, nil
	}
	if !s.optionSpreadCapModeSupported() {
		c.mu.RUnlock()
		return noop, optionSpreadCapRejection(optionSpreadCapUnsupported, "an entry spread cap is in force but this execution mode cannot apply it, so new options entries are refused. Nothing was submitted.")
	}
	if order.CapRevision == nil {
		c.mu.RUnlock()
		return noop, optionSpreadCapRejection(optionSpreadCapRevision, "this opening carries no confirmation of OP2's entry spread cap, so it is refused; confirm the cap and retry. Nothing was submitted.")
	}
	if *order.CapRevision != c.revision {
		c.mu.RUnlock()
		return noop, optionSpreadCapRejection(optionSpreadCapChanged, "OP2's entry spread cap changed after it was confirmed for this opening, so it is refused; confirm the cap again and retry. Nothing was submitted.")
	}
	var once sync.Once
	return func() { once.Do(c.mu.RUnlock) }, nil
}

// enforceOptionSpreadCapForOrder is what the order guards call. It takes one snapshot of the enforced cap and its
// revision, refuses an opening whose confirmed revision is missing or no longer current (a cap change after the
// confirmation, for example a save or a failed rollback running at the same time), and judges the spread against that same
// snapshot. No cap change can slip between the revision check and the spread check.
func (s *AlpacaTradingService) enforceOptionSpreadCapForOrder(order *interfaces.OptionsOrder, p StandaloneTradeProposal, doc map[string]any) error {
	capPct, configured, invalid, revision := s.optionSpreadCap.snapshot()
	if configured && !invalid {
		reject := func(code, message string) error {
			return &PreSubmissionRejectionError{Err: &OptionSpreadCapError{Code: code, Message: message}}
		}
		if order == nil || order.CapRevision == nil {
			return reject(optionSpreadCapRevision, "this opening carries no confirmation of OP2's entry spread cap, so it is refused; confirm the cap and retry. Nothing was submitted.")
		}
		if *order.CapRevision != revision {
			return reject(optionSpreadCapChanged, "OP2's entry spread cap changed after it was confirmed for this opening, so it is refused; confirm the cap again and retry. Nothing was submitted.")
		}
	}
	return enforceOptionSpreadCapAt(capPct, configured, invalid, p, doc)
}

func enforceOptionSpreadCapAt(capPct decimal.Decimal, configured, invalid bool, p StandaloneTradeProposal, doc map[string]any) error {
	reject := func(code, message string) error {
		return &PreSubmissionRejectionError{Err: &OptionSpreadCapError{Code: code, Message: message}}
	}
	if invalid {
		return reject(optionSpreadCapConfigErr, "OP2's option spread cap setting is invalid, so new options entries are refused until it is corrected.")
	}
	if !configured {
		return nil
	}
	ratios, err := optionSpreadRatios(p, doc)
	if err == nil && doc["score_profile"] == scoreProfileV2 {
		err = verifyOptionQuoteBlock(p, doc, ratios)
	}
	if err != nil {
		return reject(optionSpreadEvidenceCode, "AlphaDesk's quote evidence for this exact contract could not be verified ("+err.Error()+"); the spread cannot be checked against OP2's entry cap, so this opening is refused.")
	}
	worst := ratios[0]
	for _, ratio := range ratios[1:] {
		if ratio.GreaterThan(worst) {
			worst = ratio
		}
	}
	observed := worst.Mul(decimal.NewFromInt(100))
	if observed.GreaterThan(capPct) {
		return reject(optionSpreadAboveCapCode, fmt.Sprintf("the exact contract's spread on AlphaDesk's quote is %s%%, above OP2's entry cap of %s%%. Choose a tighter contract; closing and reducing orders are not affected.", observed.StringFixed(2), capPct.String()))
	}
	return nil
}
