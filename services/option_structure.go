package services

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"prophet-trader/interfaces"
)

// Phase C, Step 4: structure classification for the options order boundary.
//
// OP2 places two single-leg structures today (long_call, long_put). Phase C adds the two same-expiry 1:1 debit
// verticals that AlphaDesk already assesses (bull_call_debit, bear_put_debit). A structure is only ever classified from the
// exact legs of the order; the agent's own label is never trusted. The sandbox permission AllowedStructures gates NEW
// exposure only: reads, reconciliation and valid grouped reducing closes are always allowed.
const (
	StructureLongCall      = "long_call"
	StructureLongPut       = "long_put"
	StructureBullCallDebit = "bull_call_debit"
	StructureBearPutDebit  = "bear_put_debit"

	// PriceKindDebit and PriceKindCredit say which way money moves for the whole order. The internal price is always a
	// positive magnitude; only the broker adapter signs it (a credit exit is sent negative).
	PriceKindDebit  = "debit"
	PriceKindCredit = "credit"
)

// DefaultAllowedStructures is today's behaviour: single long legs only.
var DefaultAllowedStructures = []string{StructureLongCall, StructureLongPut}

var knownStructures = map[string]bool{
	StructureLongCall: true, StructureLongPut: true, StructureBullCallDebit: true, StructureBearPutDebit: true,
}

// ParseAllowedStructures reads a comma separated allow-list. An empty value means the default. Any unknown or
// duplicate name makes the whole value invalid (fail closed), so a typo can never widen what is allowed.
func ParseAllowedStructures(value string) (map[string]bool, bool) {
	value = strings.TrimSpace(value)
	allowed := map[string]bool{}
	if value == "" {
		for _, name := range DefaultAllowedStructures {
			allowed[name] = true
		}
		return allowed, true
	}
	for _, raw := range strings.Split(value, ",") {
		name := strings.ToLower(strings.TrimSpace(raw))
		if !knownStructures[name] || allowed[name] {
			return nil, false
		}
		allowed[name] = true
	}
	return allowed, true
}

// legOpening reports whether every leg opens (true), every leg closes (false), or the legs are mixed (ok=false).
func legsDirection(legs []interfaces.OptionLeg) (opening bool, ok bool) {
	if len(legs) == 0 {
		return false, false
	}
	opens, closes := 0, 0
	for _, leg := range legs {
		switch {
		case strings.HasSuffix(leg.PositionIntent, "_to_open"):
			opens++
		case strings.HasSuffix(leg.PositionIntent, "_to_close"):
			closes++
		}
	}
	if opens == len(legs) {
		return true, true
	}
	if closes == len(legs) {
		return false, true
	}
	return false, false
}

// ClassifyOptionsStructure returns the structure of an order from its exact legs. A single-leg order is a long call
// or long put only when it buys to open. A two-leg order must be a same-expiry 1:1 vertical in which one leg buys and
// the other sells, whether it opens or closes the group. Anything else is unsupported and is refused by the caller.
func ClassifyOptionsStructure(order *interfaces.OptionsOrder) (string, error) {
	if order == nil {
		return "", fmt.Errorf("options order is required")
	}
	if len(order.Legs) == 0 {
		_, _, optionType, _, ok := parseOCCOptionSymbol(order.Symbol)
		if !ok {
			return "", fmt.Errorf("options symbol is not a valid OCC symbol")
		}
		if order.PositionIntent != "buy_to_open" {
			return "", fmt.Errorf("a single-leg structure is classified only for a buy to open")
		}
		if optionType == "C" {
			return StructureLongCall, nil
		}
		if optionType == "P" {
			return StructureLongPut, nil
		}
		return "", fmt.Errorf("unsupported single-leg option type %q", optionType)
	}
	if len(order.Legs) != 2 {
		return "", fmt.Errorf("only two-leg debit verticals are supported; got %d legs", len(order.Legs))
	}
	opening, dirOK := legsDirection(order.Legs)
	if !dirOK {
		return "", fmt.Errorf("a spread must open every leg or close every leg")
	}
	a, b := order.Legs[0], order.Legs[1]
	if a.RatioQty != 1 || b.RatioQty != 1 {
		return "", fmt.Errorf("only 1:1 spreads are supported")
	}
	if a.Side == b.Side {
		return "", fmt.Errorf("a vertical must buy one leg and sell the other")
	}
	rootA, expiryA, typeA, strikeA, okA := parseOCCOptionSymbol(a.Symbol)
	rootB, expiryB, typeB, strikeB, okB := parseOCCOptionSymbol(b.Symbol)
	if !okA || !okB {
		return "", fmt.Errorf("spread legs must be valid OCC symbols")
	}
	if !strings.EqualFold(rootA, rootB) || !expiryA.Equal(expiryB) || typeA != typeB {
		return "", fmt.Errorf("spread legs must share the underlying, expiry and option type")
	}
	if strikeA == strikeB {
		return "", fmt.Errorf("spread legs must have different strikes")
	}
	// The long leg is the one the spread is long: it buys when opening and sells when closing (and the other way round for the
	// short leg), so a close classifies as the same structure as its opening.
	longSide := "buy"
	if !opening {
		longSide = "sell"
	}
	longStrike, shortStrike := strikeA, strikeB
	if a.Side != longSide {
		longStrike, shortStrike = strikeB, strikeA
	}
	switch typeA {
	case "C":
		if longStrike < shortStrike {
			return StructureBullCallDebit, nil
		}
		return "", fmt.Errorf("a call spread that buys the higher strike is a credit spread, which is not supported")
	case "P":
		if longStrike > shortStrike {
			return StructureBearPutDebit, nil
		}
		return "", fmt.Errorf("a put spread that buys the lower strike is a credit spread, which is not supported")
	}
	return "", fmt.Errorf("unsupported spread option type %q", typeA)
}

// SpreadWidth is the strike distance of a classified vertical (always positive).
func SpreadWidth(legs []interfaces.OptionLeg) (float64, error) {
	if len(legs) != 2 {
		return 0, fmt.Errorf("a vertical has two legs")
	}
	_, _, _, strikeA, okA := parseOCCOptionSymbol(legs[0].Symbol)
	_, _, _, strikeB, okB := parseOCCOptionSymbol(legs[1].Symbol)
	if !okA || !okB {
		return 0, fmt.Errorf("spread legs must be valid OCC symbols")
	}
	return math.Abs(strikeA - strikeB), nil
}

// canonicalAllowedStructures validates an allow-list and returns it sorted and comma separated, so the policy value is a
// plain comparable string. An invalid value returns the default and ok=false (the policy is then marked invalid).
func canonicalAllowedStructures(value string) (string, bool) {
	allowed, ok := ParseAllowedStructures(value)
	if !ok {
		allowed, _ = ParseAllowedStructures("")
	}
	names := make([]string, 0, len(allowed))
	for name := range allowed {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ","), ok
}

// allowsStructure reports whether new exposure in this structure is permitted. An empty value is the default.
func (p TradingPolicy) allowsStructure(structure string) bool {
	allowed, ok := ParseAllowedStructures(p.AllowedStructures)
	return ok && allowed[structure]
}

// EffectivePriceKind is the one canonical price kind of a multi-leg order: the explicit value when given, otherwise debit for an
// opening and credit for a closing. Policy, the broker adapter and the controller all read it, so an omitted kind can never
// be admitted as a credit close and then dispatched as a debit.
func EffectivePriceKind(order *interfaces.OptionsOrder) string {
	if order == nil || len(order.Legs) == 0 {
		return ""
	}
	if kind := strings.TrimSpace(order.PriceKind); kind != "" {
		return kind
	}
	if opening, ok := legsDirection(order.Legs); ok {
		if opening {
			return PriceKindDebit
		}
		return PriceKindCredit
	}
	return ""
}
