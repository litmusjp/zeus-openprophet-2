package services

import (
	"strings"
	"testing"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/shopspring/decimal"

	"prophet-trader/interfaces"
)

// Phase C, Step 4 (B05): the pricing adapter. The internal price is a positive magnitude; only the broker adapter signs it.
// A multi-leg parent has no symbol, side or intent of its own. Negative limits and fills are valid only for a multi-leg
// credit exit. Mismatches still go to the uncertain path.

func dec(value string) *decimal.Decimal {
	d := decimal.RequireFromString(value)
	return &d
}

func TestMlegRequestIsSignedOnlyForACreditExitAndOmitsTheParentIdentity(t *testing.T) {
	open, err := buildAlpacaOptionsOrderRequest(bullCallOpen())
	if err != nil {
		t.Fatal(err)
	}
	if open.OrderClass != alpaca.MLeg || open.Symbol != "" || open.Side != "" || open.PositionIntent != "" {
		t.Fatalf("a multi-leg parent must carry no symbol, side or intent, got %#v", open)
	}
	if open.LimitPrice == nil || !open.LimitPrice.Equal(decimal.NewFromInt(3)) {
		t.Fatalf("a debit entry must be sent as a positive net limit, got %v", open.LimitPrice)
	}
	closeReq, err := buildAlpacaOptionsOrderRequest(bullCallClose())
	if err != nil {
		t.Fatal(err)
	}
	if closeReq.LimitPrice == nil || !closeReq.LimitPrice.Equal(decimal.NewFromInt(-4)) {
		t.Fatalf("a credit exit must be sent as a negative net limit, got %v", closeReq.LimitPrice)
	}
	if len(closeReq.Legs) != 2 || closeReq.Legs[0].Side != alpaca.Sell || closeReq.Legs[1].Side != alpaca.Buy {
		t.Fatalf("the close legs must be the exact submitted legs, got %#v", closeReq.Legs)
	}
	// The caller's order is never changed: the internal price stays a positive magnitude.
	order := bullCallClose()
	if _, err := buildAlpacaOptionsOrderRequest(order); err != nil || *order.LimitPrice != 4 {
		t.Fatalf("the internal price must stay a positive magnitude, got %v err=%v", *order.LimitPrice, err)
	}
}

func TestSingleLegRequestIsUnchangedByThePricingAdapter(t *testing.T) {
	price := 1.25
	order := &interfaces.OptionsOrder{ClientOrderID: "op-single", Symbol: callLow, Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
	req, err := buildAlpacaOptionsOrderRequest(order)
	if err != nil {
		t.Fatal(err)
	}
	if req.Symbol != callLow || req.Side != alpaca.Buy || req.PositionIntent != alpaca.BuyToOpen || req.OrderClass != "" || !req.LimitPrice.Equal(decimal.RequireFromString("1.25")) {
		t.Fatalf("a single-leg request must keep its parent fields and a positive limit, got %#v", req)
	}
	// A negative price is still refused for a single leg (and for any order without legs).
	neg := -1.0
	order.LimitPrice = &neg
	if _, err := buildAlpacaOptionsOrderRequest(order); err == nil {
		t.Fatal("a negative single-leg limit must be refused")
	}
}

func submittedMleg(t *testing.T, order *interfaces.OptionsOrder) alpaca.PlaceOrderRequest {
	t.Helper()
	req, err := buildAlpacaOptionsOrderRequest(order)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func brokerMlegOrder(req alpaca.PlaceOrderRequest) *alpaca.Order {
	legs := make([]alpaca.Order, len(req.Legs))
	for i := range req.Legs {
		ratio := req.Legs[i].RatioQty
		legs[i] = alpaca.Order{Symbol: req.Legs[i].Symbol, Side: req.Legs[i].Side, PositionIntent: req.Legs[i].PositionIntent, RatioQty: &ratio}
	}
	return &alpaca.Order{ID: "broker-1", ClientOrderID: req.ClientOrderID, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce,
		OrderClass: alpaca.MLeg, Qty: req.Qty, LimitPrice: req.LimitPrice, Status: "accepted", Legs: legs}
}

func TestMlegResponseParentIdentityFollowsTheProviderConvention(t *testing.T) {
	order := bullCallOpen()
	order.ClientOrderID = "op-open"
	req := submittedMleg(t, order)

	// The documented response leaves the parent symbol and side empty.
	if r := orderResultFromAlpacaOrder(&req, brokerMlegOrder(req)); r.Status != "accepted" {
		t.Fatalf("an empty parent identity must be accepted, got %q (%s)", r.Status, r.Message)
	}
	// A provider that fills the parent in with one submitted leg is also accepted.
	filledIn := brokerMlegOrder(req)
	filledIn.Symbol, filledIn.Side = callLow, alpaca.Buy
	if r := orderResultFromAlpacaOrder(&req, filledIn); r.Status != "accepted" {
		t.Fatalf("a parent that echoes a submitted leg must be accepted, got %q (%s)", r.Status, r.Message)
	}
	// Anything else is a mismatch and stays uncertain.
	for name, mutate := range map[string]func(o *alpaca.Order){
		"unrelated parent symbol": func(o *alpaca.Order) { o.Symbol = "TSLA261218C00200000" },
		"parent side of no leg":   func(o *alpaca.Order) { o.Symbol = ""; o.Side = ""; o.Legs[0].Side = alpaca.Sell },
		"a different leg symbol":  func(o *alpaca.Order) { o.Legs[1].Symbol = "AAPL261218C00220000" },
		"a different leg count":   func(o *alpaca.Order) { o.Legs = o.Legs[:1] },
		"not an mleg response":    func(o *alpaca.Order) { o.OrderClass = "" },
		"a different net limit":   func(o *alpaca.Order) { v := decimal.RequireFromString("3.5"); o.LimitPrice = &v },
		"a different client id":   func(o *alpaca.Order) { o.ClientOrderID = "someone-else" },
	} {
		bad := brokerMlegOrder(req)
		mutate(bad)
		if r := orderResultFromAlpacaOrder(&req, bad); r.Status != "submission_uncertain" {
			t.Errorf("%s must stay uncertain, got %q", name, r.Status)
		}
	}
}

func TestSignedCreditFillIsAcceptedOnlyForAMultiLegCreditExit(t *testing.T) {
	order := bullCallClose()
	order.ClientOrderID = "op-close"
	req := submittedMleg(t, order)
	filled := func(avg string) *alpaca.Order {
		o := brokerMlegOrder(req)
		o.Status = "filled"
		o.FilledQty = decimal.NewFromInt(2)
		o.FilledAvgPrice = dec(avg)
		return o
	}
	// A negative average fill on a credit exit is valid and is stored as the positive magnitude, with a positive limit.
	r := orderResultFromAlpacaOrder(&req, filled("-4.00"))
	if r.Status != "filled" || r.FilledAvgPrice == nil || *r.FilledAvgPrice != 4 || r.LimitPrice == nil || *r.LimitPrice != 4 || !r.FullyFilled {
		t.Fatalf("a signed credit fill must be normalised to magnitudes, got %+v avg=%v limit=%v", r, r.FilledAvgPrice, r.LimitPrice)
	}
	// An unsigned (positive) average fill on a credit exit is also accepted.
	if r := orderResultFromAlpacaOrder(&req, filled("4.00")); r.Status != "filled" || *r.FilledAvgPrice != 4 {
		t.Fatalf("a positive credit fill must be accepted, got %+v", r)
	}
	// A zero average fill with a filled quantity is invalid, signed or not.
	if r := orderResultFromAlpacaOrder(&req, filled("0")); r.Status != "submission_uncertain" {
		t.Fatalf("a zero average fill must stay uncertain, got %q", r.Status)
	}
	// A negative fill on a DEBIT entry is not valid: the negative allowance is for credit exits only.
	debit := bullCallOpen()
	debit.ClientOrderID = "op-open"
	debitReq := submittedMleg(t, debit)
	bad := brokerMlegOrder(debitReq)
	bad.Status = "filled"
	bad.FilledQty = decimal.NewFromInt(2)
	bad.FilledAvgPrice = dec("-3.00")
	if r := orderResultFromAlpacaOrder(&debitReq, bad); r.Status != "submission_uncertain" {
		t.Fatalf("a negative fill on a debit entry must stay uncertain, got %q", r.Status)
	}
	// A negative fill on a single-leg order is not valid either.
	price := 1.25
	single := &interfaces.OptionsOrder{ClientOrderID: "op-single", Symbol: callLow, Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
	singleReq, _ := buildAlpacaOptionsOrderRequest(single)
	one := decimal.NewFromInt(1)
	resp := &alpaca.Order{ID: "b1", ClientOrderID: "op-single", Symbol: singleReq.Symbol, Side: singleReq.Side, Type: singleReq.Type, TimeInForce: singleReq.TimeInForce, PositionIntent: singleReq.PositionIntent,
		Qty: &one, LimitPrice: singleReq.LimitPrice, Status: "filled", FilledQty: one, FilledAvgPrice: dec("-1.25")}
	if r := orderResultFromAlpacaOrder(&singleReq, resp); r.Status != "submission_uncertain" || !strings.Contains(r.Message, "invalid filled average price") {
		t.Fatalf("a negative single-leg fill must stay uncertain, got %q (%s)", r.Status, r.Message)
	}
}

func TestOptionsOrderResultIdentityForAMultiLegOrderAcceptsAnEmptyParent(t *testing.T) {
	order := bullCallClose()
	order.ClientOrderID = "op-close"
	req := submittedMleg(t, order)
	result := orderResultFromAlpacaOrder(&req, brokerMlegOrder(req))
	result.Purpose = "close"
	result.BrokerAccountID, result.PaperLive, result.TenantID, result.SandboxID = "acct", "paper", "tenant", "sandbox"
	// The same expectations the service builds for a multi-leg order (empty parent identity, no intent).
	if err := ValidateOrderResultIdentity(result, order.ClientOrderID, result.Symbol, result.Side, order.Qty, order.Type, order.TimeInForce, order.LimitPrice, nil, "", result.Purpose); err != nil {
		t.Fatalf("the normalised credit result must match the submitted positive magnitude: %v", err)
	}
	if result.LimitPrice == nil || *result.LimitPrice != *order.LimitPrice {
		t.Fatalf("the result limit must be the positive magnitude of the order limit, got %v", result.LimitPrice)
	}
}

func providerMlegRead(limit string, avg string, filled int64, status string, open bool) *alpaca.Order {
	ratio := decimal.NewFromInt(1)
	qty := decimal.NewFromInt(2)
	intentA, intentB := alpaca.SellToClose, alpaca.BuyToClose
	if open {
		intentA, intentB = alpaca.BuyToOpen, alpaca.SellToOpen
	}
	sideA, sideB := alpaca.Sell, alpaca.Buy
	if open {
		sideA, sideB = alpaca.Buy, alpaca.Sell
	}
	o := &alpaca.Order{ID: "b1", ClientOrderID: "c1", OrderClass: alpaca.MLeg, Qty: &qty, LimitPrice: dec(limit), Type: alpaca.Limit, TimeInForce: alpaca.Day, Status: status,
		FilledQty: decimal.NewFromInt(filled),
		Legs: []alpaca.Order{
			{Symbol: callLow, Side: sideA, PositionIntent: intentA, RatioQty: &ratio},
			{Symbol: callHigh, Side: sideB, PositionIntent: intentB, RatioQty: &ratio},
		}}
	if avg != "" {
		o.FilledAvgPrice = dec(avg)
	}
	return o
}

func TestCreditCloseReadbackIsNormalisedLikeTheSubmissionResponse(t *testing.T) {
	// Hermes C05: a provider-shaped filled credit close read back later (order reads, restart reconciliation).
	full := convertAlpacaOrderStatic(providerMlegRead("-4", "-4", 2, "filled", false))
	if full.Status != "filled" || full.LimitPrice == nil || *full.LimitPrice != 4 || full.FilledAvgPrice == nil || *full.FilledAvgPrice != 4 || full.FilledQty != 2 {
		t.Fatalf("a signed credit close must read back as positive magnitudes: %+v limit=%v avg=%v", full, full.LimitPrice, full.FilledAvgPrice)
	}
	partial := convertAlpacaOrderStatic(providerMlegRead("-4", "-4.5", 1, "partially_filled", false))
	if partial.Status != "partially_filled" || *partial.FilledAvgPrice != 4.5 || partial.FilledQty != 1 {
		t.Fatalf("a signed partial credit fill must read back normalised: %+v", partial)
	}
	positiveFill := convertAlpacaOrderStatic(providerMlegRead("-4", "4", 2, "filled", false))
	if positiveFill.Status != "filled" || *positiveFill.FilledAvgPrice != 4 {
		t.Fatalf("an unsigned fill on a credit close is also accepted: %+v", positiveFill)
	}
	// Anything else negative is not converted and stays refused.
	for name, o := range map[string]*alpaca.Order{
		"debit entry with a negative fill":  providerMlegRead("3", "-3", 2, "filled", true),
		"debit entry with a negative limit": providerMlegRead("-3", "3", 2, "filled", true),
	} {
		if got := convertAlpacaOrderStatic(o); got.Status != "submission_uncertain" {
			t.Errorf("%s must stay uncertain, got %q", name, got.Status)
		}
	}
	qty := decimal.NewFromInt(1)
	single := &alpaca.Order{ID: "b2", ClientOrderID: "c2", Symbol: callLow, Side: alpaca.Sell, Qty: &qty, Type: alpaca.Limit, TimeInForce: alpaca.Day, Status: "filled", PositionIntent: alpaca.SellToClose,
		LimitPrice: dec("-1"), FilledQty: qty, FilledAvgPrice: dec("-1")}
	if got := convertAlpacaOrderStatic(single); got.Status != "submission_uncertain" {
		t.Errorf("a negative single-leg order must stay uncertain, got %q", got.Status)
	}
}

func TestAnOmittedPriceKindIsCanonicalisedNeverDispatchedAsTheWrongKind(t *testing.T) {
	closing := bullCallClose()
	closing.PriceKind = ""
	if EffectivePriceKind(closing) != PriceKindCredit {
		t.Fatalf("an omitted kind on a close must be a credit, got %q", EffectivePriceKind(closing))
	}
	req, err := buildAlpacaOptionsOrderRequest(closing)
	if err != nil || req.LimitPrice == nil || !req.LimitPrice.Equal(decimal.NewFromInt(-4)) {
		t.Fatalf("a close with the kind omitted must be sent as a credit (negative), got %v err=%v", req.LimitPrice, err)
	}
	opening := bullCallOpen()
	opening.PriceKind = ""
	if EffectivePriceKind(opening) != PriceKindDebit {
		t.Fatalf("an omitted kind on an opening must be a debit, got %q", EffectivePriceKind(opening))
	}
	req, err = buildAlpacaOptionsOrderRequest(opening)
	if err != nil || !req.LimitPrice.Equal(decimal.NewFromInt(3)) {
		t.Fatalf("an opening with the kind omitted must be sent as a debit (positive), got %v err=%v", req.LimitPrice, err)
	}
	// Policy and adapter agree: the same canonical kind admits and dispatches the order.
	group := OptionGroupRisk{ID: "g", LegSymbols: []string{callLow, callHigh}, OpenUnits: 2, MaxLoss: 600}
	if _, err := spreadPolicy("").ValidateOptionsOrder(closing, spreadSnapshot(group)); err != nil {
		t.Fatalf("a close with the kind omitted must be admitted as a credit: %v", err)
	}
	// A single-leg order has no kind at all.
	price := 1.0
	single := &interfaces.OptionsOrder{ClientOrderID: "s", Symbol: callLow, Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
	if EffectivePriceKind(single) != "" {
		t.Fatalf("a single leg has no price kind")
	}
}
