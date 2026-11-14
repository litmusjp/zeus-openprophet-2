package services

import (
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
	optionSpreadCapEnv       = "OPENPROPHET_MAX_OPTION_SPREAD_PCT"
	MinOptionSpreadCapPct    = 2.0
	MaxOptionSpreadCapPct    = 25.0
	scoreProfileV1           = "catalyst_momentum_v1"
	scoreProfileV2           = "catalyst_momentum_v2"
	optionSpreadAboveCapCode = "OPTION_SPREAD_ABOVE_CAP"
	optionSpreadEvidenceCode = "OPTION_SPREAD_EVIDENCE_INVALID"
	optionSpreadCapConfigErr = "OPTION_SPREAD_CAP_INVALID"
)

type optionSpreadCapState struct {
	mu         sync.RWMutex
	pct        decimal.Decimal
	configured bool
	invalid    bool
}

func (c *optionSpreadCapState) get() (decimal.Decimal, bool, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.pct, c.configured, c.invalid
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
	s.optionSpreadCap.pct = decimal.NewFromFloat(pct)
	s.optionSpreadCap.configured = true
	s.optionSpreadCap.invalid = false
	return nil
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
	capPct, configured, invalid := s.optionSpreadCap.get()
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
