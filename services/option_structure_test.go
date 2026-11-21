package services

import (
	"strings"
	"testing"

	"prophet-trader/interfaces"
)

// Phase C, Step 4: structure classification, the AllowedStructures permission, and the group-aware spread policy.

const (
	callLow   = "AAPL261218C00200000" // buy
	callHigh  = "AAPL261218C00210000" // sell
	putHigh   = "AAPL261218P00200000" // buy
	putLow    = "AAPL261218P00190000" // sell
	otherExp  = "AAPL270115C00210000"
	otherRoot = "MSFT261218C00210000"
)

func leg(symbol, side, intent string) interfaces.OptionLeg {
	return interfaces.OptionLeg{Symbol: symbol, Side: side, PositionIntent: intent, RatioQty: 1, Price: 1}
}

func bullCallOpen() *interfaces.OptionsOrder {
	price := 3.0
	return &interfaces.OptionsOrder{
		Symbol: callLow, Underlying: "AAPL", Qty: 2, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price,
		PriceKind: PriceKindDebit,
		Legs:      []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "sell", "sell_to_open")},
	}
}

func bullCallClose() *interfaces.OptionsOrder {
	price := 4.0
	return &interfaces.OptionsOrder{
		Symbol: callLow, Underlying: "AAPL", Qty: 2, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: &price,
		PriceKind: PriceKindCredit,
		Legs:      []interfaces.OptionLeg{leg(callLow, "sell", "sell_to_close"), leg(callHigh, "buy", "buy_to_close")},
	}
}

func bearPutOpen() *interfaces.OptionsOrder {
	price := 3.0
	return &interfaces.OptionsOrder{
		Symbol: putHigh, Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price,
		PriceKind: PriceKindDebit,
		Legs:      []interfaces.OptionLeg{leg(putHigh, "buy", "buy_to_open"), leg(putLow, "sell", "sell_to_open")},
	}
}

func spreadPolicy(allowed string) TradingPolicy {
	return TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true, MaxPositionPct: 15, MaxDeployedPct: 80, MaxOpenPositions: 10, MaxDailyLoss: 5, AllowedStructures: allowed}
}

func spreadSnapshot(groups ...OptionGroupRisk) BrokerRiskSnapshot {
	return BrokerRiskSnapshot{
		Account: &interfaces.Account{PortfolioValue: 100000, Equity: 100000, LastEquity: 100000, DailyPnLValid: true},
		Groups:  groups,
		Positions: []*interfaces.Position{
			{Symbol: callLow, Qty: 2, Side: "long", MarketValue: 800},
			{Symbol: callHigh, Qty: -2, Side: "short", MarketValue: -400},
		},
	}
}

func TestClassifyOptionsStructure(t *testing.T) {
	cases := []struct {
		name   string
		order  *interfaces.OptionsOrder
		want   string
		errHas string
	}{
		{"long call", &interfaces.OptionsOrder{Symbol: callLow, PositionIntent: "buy_to_open"}, StructureLongCall, ""},
		{"long put", &interfaces.OptionsOrder{Symbol: putHigh, PositionIntent: "buy_to_open"}, StructureLongPut, ""},
		{"single leg sell to open is not classified", &interfaces.OptionsOrder{Symbol: callLow, PositionIntent: "sell_to_open"}, "", "only for a buy to open"},
		{"bull call debit open", bullCallOpen(), StructureBullCallDebit, ""},
		{"bull call debit close", bullCallClose(), StructureBullCallDebit, ""},
		{"bear put debit open", bearPutOpen(), StructureBearPutDebit, ""},
		{"call spread buying the higher strike is a credit spread", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{leg(callHigh, "buy", "buy_to_open"), leg(callLow, "sell", "sell_to_open")}}, "", "credit spread"},
		{"put spread buying the lower strike is a credit spread", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{leg(putLow, "buy", "buy_to_open"), leg(putHigh, "sell", "sell_to_open")}}, "", "credit spread"},
		{"three legs", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "sell", "sell_to_open"), leg(callLow, "buy", "buy_to_open")}}, "", "two-leg"},
		{"mixed intents", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "sell", "sell_to_close")}}, "", "open every leg or close every leg"},
		{"ratio two", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{{Symbol: callLow, Side: "buy", RatioQty: 2, PositionIntent: "buy_to_open"}, leg(callHigh, "sell", "sell_to_open")}}, "", "1:1"},
		{"same side", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "buy", "buy_to_open")}}, "", "buy one leg and sell the other"},
		{"different expiry", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(otherExp, "sell", "sell_to_open")}}, "", "share the underlying, expiry"},
		{"different underlying", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(otherRoot, "sell", "sell_to_open")}}, "", "share the underlying, expiry"},
		{"call and put", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(putLow, "sell", "sell_to_open")}}, "", "share the underlying, expiry"},
		{"same strike", &interfaces.OptionsOrder{Legs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callLow, "sell", "sell_to_open")}}, "", "different strikes"},
	}
	for _, tc := range cases {
		got, err := ClassifyOptionsStructure(tc.order)
		if tc.errHas == "" {
			if err != nil || got != tc.want {
				t.Errorf("%s: got (%q, %v), want %q", tc.name, got, err, tc.want)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.errHas) {
			t.Errorf("%s: want an error containing %q, got (%q, %v)", tc.name, tc.errHas, got, err)
		}
	}
}

func TestParseAllowedStructuresFailsClosed(t *testing.T) {
	if m, ok := ParseAllowedStructures(""); !ok || !m[StructureLongCall] || !m[StructureLongPut] || len(m) != 2 {
		t.Fatalf("default must be exactly the two single long legs, got %v ok=%v", m, ok)
	}
	if m, ok := ParseAllowedStructures(" Long_Call , bull_call_debit "); !ok || !m[StructureLongCall] || !m[StructureBullCallDebit] || len(m) != 2 {
		t.Fatalf("a valid list must parse, got %v ok=%v", m, ok)
	}
	for _, bad := range []string{"long_call,iron_condor", "long_call,long_call", "bull_put_credit", ",", "long_call,,long_put"} {
		if _, ok := ParseAllowedStructures(bad); ok {
			t.Errorf("%q must be invalid", bad)
		}
	}
	if v, ok := canonicalAllowedStructures("bull_call_debit,long_call"); !ok || v != "bull_call_debit,long_call" {
		t.Errorf("canonical form must be sorted, got %q ok=%v", v, ok)
	}
	if v, ok := canonicalAllowedStructures("nonsense"); ok || v != "long_call,long_put" {
		t.Errorf("an invalid list must return the default and not ok, got %q ok=%v", v, ok)
	}
}

func TestPolicyFromEnvInvalidStructuresBlocksExecution(t *testing.T) {
	t.Setenv("OPENPROPHET_ALLOWED_STRUCTURES", "long_call,butterfly")
	p := TradingPolicyFromEnv(true)
	if !p.InvalidConfiguration {
		t.Fatalf("an unknown structure must mark the policy invalid")
	}
	t.Setenv("OPENPROPHET_ALLOWED_STRUCTURES", "")
	if TradingPolicyFromEnv(true).AllowedStructures != "long_call,long_put" {
		t.Fatalf("an unset value must be the default")
	}
}

func TestSpreadOpeningFollowsThePermissionAndCountsMaxLoss(t *testing.T) {
	// Default permission: a new spread is refused, and the single-leg path is untouched.
	if _, err := spreadPolicy("").ValidateOptionsOrder(bullCallOpen(), spreadSnapshot()); err == nil || !strings.Contains(err.Error(), "not allowed for this sandbox") {
		t.Fatalf("a spread opening must be refused by default, got %v", err)
	}
	// Allowed: the amount counted is the maximum loss (net debit x units x 100).
	notional, err := spreadPolicy("bull_call_debit,long_call,long_put").ValidateOptionsOrder(bullCallOpen(), spreadSnapshot())
	if err != nil || notional != 600 {
		t.Fatalf("an allowed spread opening must count its max loss of 600, got %v err=%v", notional, err)
	}
	// Allowing one vertical does not allow the other.
	if _, err := spreadPolicy("bull_call_debit").ValidateOptionsOrder(bearPutOpen(), spreadSnapshot()); err == nil {
		t.Fatalf("bear_put_debit must stay refused when only bull_call_debit is allowed")
	}
}

func TestSpreadOpeningRefusals(t *testing.T) {
	p := spreadPolicy("bull_call_debit")
	over := bullCallOpen()
	price := 10.01 // wider than the 10.00 strike width
	over.LimitPrice = &price
	if _, err := p.ValidateOptionsOrder(over, spreadSnapshot()); err == nil || !strings.Contains(err.Error(), "exceeds the spread width") {
		t.Errorf("a net debit above the width must be refused, got %v", err)
	}
	market := bullCallOpen()
	market.Type = "market"
	if _, err := p.ValidateOptionsOrder(market, spreadSnapshot()); err == nil {
		t.Errorf("a market spread must be refused")
	}
	wrongKind := bullCallOpen()
	wrongKind.PriceKind = PriceKindCredit
	if _, err := p.ValidateOptionsOrder(wrongKind, spreadSnapshot()); err == nil || !strings.Contains(err.Error(), "net debit") {
		t.Errorf("an opening priced as a credit must be refused, got %v", err)
	}
	// The maximum-loss amount is held to the position cap (15% of 100,000 = 15,000): 2 units x 8.00 x 100 = 1,600 passes; 20 units fails.
	big := bullCallOpen()
	big.Qty = 20
	price = 9.0
	big.LimitPrice = &price
	if _, err := p.ValidateOptionsOrder(big, spreadSnapshot()); err == nil || !strings.Contains(err.Error(), "max position percentage") {
		t.Errorf("a spread whose max loss exceeds the position cap must be refused, got %v", err)
	}
}

func TestSpreadCloseIsAlwaysAllowedButMustBeBackedByTheGroup(t *testing.T) {
	group := OptionGroupRisk{ID: "grp-1", LegSymbols: []string{callLow, callHigh}, OpenUnits: 2, MaxLoss: 600, StructureID: StructureBullCallDebit}
	// Permission off (the default) still lets a valid grouped close through.
	if _, err := spreadPolicy("").ValidateOptionsOrder(bullCallClose(), spreadSnapshot(group)); err != nil {
		t.Fatalf("a valid grouped reducing close must be allowed with the permission off: %v", err)
	}
	// No group on record: refused.
	if _, err := spreadPolicy("").ValidateOptionsOrder(bullCallClose(), spreadSnapshot()); err == nil || !strings.Contains(err.Error(), "not backed by an open spread group") {
		t.Errorf("a close with no group must be refused, got %v", err)
	}
	// More units than the group holds: refused.
	small := group
	small.OpenUnits = 1
	if _, err := spreadPolicy("").ValidateOptionsOrder(bullCallClose(), spreadSnapshot(small)); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Errorf("closing more units than the group holds must be refused, got %v", err)
	}
	// A broken group is not closed as a group.
	broken := group
	broken.Broken = true
	if _, err := spreadPolicy("").ValidateOptionsOrder(bullCallClose(), spreadSnapshot(broken)); err == nil || !strings.Contains(err.Error(), "broken") {
		t.Errorf("a broken group must not be closed as a group, got %v", err)
	}
	// A leg with no broker exposure: refused.
	snap := spreadSnapshot(group)
	snap.Positions = snap.Positions[:1]
	if _, err := spreadPolicy("").ValidateOptionsOrder(bullCallClose(), snap); err == nil || !strings.Contains(err.Error(), "not backed by matching broker exposure") {
		t.Errorf("a close with a missing leg must be refused, got %v", err)
	}
	// A debit close is refused: a debit vertical closes for a net credit.
	wrong := bullCallClose()
	wrong.PriceKind = PriceKindDebit
	if _, err := spreadPolicy("").ValidateOptionsOrder(wrong, spreadSnapshot(group)); err == nil || !strings.Contains(err.Error(), "net credit") {
		t.Errorf("a close priced as a debit must be refused, got %v", err)
	}
}

func TestSingleLegCloseOfAGroupedLegIsRefused(t *testing.T) {
	group := OptionGroupRisk{ID: "grp-1", LegSymbols: []string{callLow, callHigh}, OpenUnits: 2, MaxLoss: 600}
	price := 4.0
	single := &interfaces.OptionsOrder{Symbol: callLow, Underlying: "AAPL", Qty: 2, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: &price}
	if _, err := spreadPolicy("").ValidateOptionsOrder(single, spreadSnapshot(group)); err == nil || !strings.Contains(err.Error(), "cannot be closed by a single-leg order") {
		t.Fatalf("closing one leg of an open group on its own must be refused, got %v", err)
	}
	// With no group on record (every existing single-leg position), the same close behaves exactly as before.
	if _, err := spreadPolicy("").ValidateOptionsOrder(single, spreadSnapshot()); err != nil {
		t.Fatalf("a single-leg close with no group must be unchanged: %v", err)
	}
	// A fully closed group (no open units) no longer owns its legs.
	closed := group
	closed.OpenUnits = 0
	if _, err := spreadPolicy("").ValidateOptionsOrder(single, spreadSnapshot(closed)); err != nil {
		t.Fatalf("a closed group must not block a single-leg close: %v", err)
	}
}

func TestGroupedLegsAreCountedOnceThroughTheGroup(t *testing.T) {
	// MaxOpenPositions 2: one open spread (two legs) plus one single leg is two positions, so a third distinct opening fails,
	// and the legs of the spread are never double counted as two positions.
	p := spreadPolicy("bull_call_debit,long_call,long_put")
	p.MaxOpenPositions = 2
	group := OptionGroupRisk{ID: "grp-1", LegSymbols: []string{callLow, callHigh}, OpenUnits: 2, MaxLoss: 600}
	snap := spreadSnapshot(group)
	snap.Positions = append(snap.Positions, &interfaces.Position{Symbol: "MSFT261218C00300000", Qty: 1, Side: "long", MarketValue: 500})
	price := 2.0
	third := &interfaces.OptionsOrder{Symbol: "NVDA261218C00150000", Underlying: "NVDA", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
	if _, err := p.ValidateOptionsOrder(third, snap); err == nil || !strings.Contains(err.Error(), "max open positions") {
		t.Fatalf("a spread (one position) plus a single leg (one position) must fill a cap of 2, got %v", err)
	}
	// Without the group the two legs would count as two positions and the third opening would fail even with a cap of 3.
	p.MaxOpenPositions = 3
	if _, err := p.ValidateOptionsOrder(third, snap); err != nil {
		t.Fatalf("with a cap of 3 the spread counts once and the third opening must pass: %v", err)
	}
}

func TestSpreadMaxLossCountsAgainstTheDeployedCap(t *testing.T) {
	p := spreadPolicy("bull_call_debit")
	p.MaxDeployedPct = 1 // 1% of 100,000 = 1,000
	group := OptionGroupRisk{ID: "grp-1", LegSymbols: []string{callLow, callHigh}, OpenUnits: 2, MaxLoss: 900}
	snap := spreadSnapshot(group)
	// A new spread of 600 max loss on top of the group's 900 is 1,500 > 1,000: refused. The legs' market values (800 and -400) are not what is counted.
	other := bullCallOpen()
	other.Symbol = "AAPL261218C00220000"
	other.Legs = []interfaces.OptionLeg{leg("AAPL261218C00220000", "buy", "buy_to_open"), leg("AAPL261218C00230000", "sell", "sell_to_open")}
	if _, err := p.ValidateOptionsOrder(other, snap); err == nil || !strings.Contains(err.Error(), "max deployed percentage") {
		t.Fatalf("a group's max loss must count against the deployed cap, got %v", err)
	}
}
