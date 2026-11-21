package services

import (
	"context"
	"strings"
	"testing"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"

	"prophet-trader/interfaces"
)

// Phase C, Step 4 (D10, amendment A1): the assignment-resolution grant and the policy that honours it.

func grantService(t *testing.T, calls *int) *AlpacaTradingService {
	t.Helper()
	return &AlpacaTradingService{
		logger: logrus.New(), expectedAccountID: "acct", expectedPaper: true, expectedTenantID: "tenant", expectedSandboxID: "sandbox",
		clockReader:      fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}},
		submissionMarker: func(string) error { return nil },
		placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			*calls++
			return &alpaca.Order{ID: "broker-1", ClientOrderID: req.ClientOrderID, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce, Qty: req.Qty, LimitPrice: req.LimitPrice, Status: "accepted"}, nil
		},
	}
}

func resolverOrderFor(grant *interfaces.AssignmentResolutionGrant, qty float64) *interfaces.Order {
	price := 199.0
	return &interfaces.Order{ClientOrderID: "resolver-gx-1", Symbol: grant.Symbol, Underlying: grant.Symbol, AssetClass: "us_equity", Qty: qty, Side: grant.Side, Type: "limit", TimeInForce: "day", LimitPrice: &price, Purpose: "close", ResolverGrant: grant}
}

func TestGrantNeedsAVerifiedPaperIdentityAndValidArguments(t *testing.T) {
	calls := 0
	s := grantService(t, &calls)
	if _, err := s.IssueAssignmentResolutionGrant("gx", "AAPL", "sell", 200); err != nil {
		t.Fatalf("a valid grant must be issued: %v", err)
	}
	for name, mutate := range map[string]func(s *AlpacaTradingService){
		"not paper":  func(s *AlpacaTradingService) { s.expectedPaper = false },
		"no account": func(s *AlpacaTradingService) { s.expectedAccountID = "" },
		"no tenant":  func(s *AlpacaTradingService) { s.expectedTenantID = "" },
		"no sandbox": func(s *AlpacaTradingService) { s.expectedSandboxID = "" },
	} {
		other := grantService(t, &calls)
		mutate(other)
		if _, err := other.IssueAssignmentResolutionGrant("gx", "AAPL", "sell", 200); err == nil {
			t.Errorf("%s: a grant must not be issued", name)
		}
	}
	for name, args := range map[string][4]any{
		"no group": {"", "AAPL", "sell", 200.0}, "option symbol": {"gx", "AAPL261218C00200000", "sell", 200.0},
		"bad side": {"gx", "AAPL", "short", 200.0}, "zero qty": {"gx", "AAPL", "sell", 0.0}, "negative qty": {"gx", "AAPL", "buy", -5.0},
	} {
		if _, err := s.IssueAssignmentResolutionGrant(args[0].(string), args[1].(string), args[2].(string), args[3].(float64)); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
}

func TestGrantIsHonouredOnceAndOnlyForTheOrderItWasIssuedFor(t *testing.T) {
	calls := 0
	s := grantService(t, &calls)
	grant, err := s.IssueAssignmentResolutionGrant("gx", "AAPL", "sell", 200)
	if err != nil {
		t.Fatal(err)
	}
	// A forged, altered or foreign grant is refused before any broker call.
	forged := *grant
	forged.Token = "not-issued"
	altered := *grant
	altered.Qty = 500
	foreign := *grant
	foreign.SandboxID = "other"
	for name, g := range map[string]*interfaces.AssignmentResolutionGrant{"unissued token": &forged, "altered quantity": &altered, "different sandbox": &foreign} {
		if _, err := s.PlaceOrder(context.Background(), resolverOrderFor(g, 200)); err == nil || calls != 0 {
			t.Errorf("%s must be refused with no broker call: err=%v calls=%d", name, err, calls)
		}
	}
	// The order must match its grant.
	if _, err := s.PlaceOrder(context.Background(), resolverOrderFor(grant, 300)); err == nil || calls != 0 {
		t.Errorf("an order above the granted quantity must be refused: err=%v calls=%d", err, calls)
	}
	wrongSide := resolverOrderFor(grant, 200)
	wrongSide.Side = "buy"
	if _, err := s.PlaceOrder(context.Background(), wrongSide); err == nil || calls != 0 {
		t.Errorf("an order on the wrong side must be refused: err=%v calls=%d", err, calls)
	}
	entry := resolverOrderFor(grant, 200)
	entry.Purpose = "entry"
	if _, err := s.PlaceOrder(context.Background(), entry); err == nil || calls != 0 {
		t.Errorf("a grant never authorises an opening order: err=%v calls=%d", err, calls)
	}
	// The exact grant works once and is then spent.
	if _, err := s.PlaceOrder(context.Background(), resolverOrderFor(grant, 200)); err != nil || calls != 1 {
		t.Fatalf("the exact grant must be honoured once: err=%v calls=%d", err, calls)
	}
	if _, err := s.PlaceOrder(context.Background(), resolverOrderFor(grant, 200)); err == nil || calls != 1 {
		t.Fatalf("a spent grant must not authorise a second order: err=%v calls=%d", err, calls)
	}
	// An order without a grant is untouched by all of this.
	price := 100.0
	plain := &interfaces.Order{ClientOrderID: "plain-1", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "limit", TimeInForce: "day", LimitPrice: &price, Purpose: "entry"}
	if _, err := s.PlaceOrder(context.Background(), plain); err != nil || calls != 2 {
		t.Fatalf("an order with no grant must behave as before: err=%v calls=%d", err, calls)
	}
}

func TestGrantOrderRefusedWhenItsPolicyRefuses(t *testing.T) {
	longStock := []*interfaces.Position{{Symbol: "AAPL", Qty: 200, Side: "long"}}
	shortStock := []*interfaces.Position{{Symbol: "AAPL", Qty: -200, Side: "short"}}
	base := TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true, AllowStocks: false, MaxPositionPct: 15, MaxDeployedPct: 80, MaxOpenPositions: 10, MaxDailyLoss: 5}
	grantFor := func(side string, qty float64) *interfaces.AssignmentResolutionGrant {
		return &interfaces.AssignmentResolutionGrant{Token: "t", GroupID: "gx", Symbol: "AAPL", Side: side, Qty: qty}
	}
	// Authority: the agent's stock permission stays off, yet the grant reduces linked stock in both directions.
	if _, err := base.ValidateOrder(resolverOrderFor(grantFor("sell", 200), 200), BrokerRiskSnapshot{Positions: longStock}); err != nil {
		t.Fatalf("a granted sale of assigned long stock must pass with AllowStocks off: %v", err)
	}
	if _, err := base.ValidateOrder(resolverOrderFor(grantFor("buy", 200), 200), BrokerRiskSnapshot{Positions: shortStock}); err != nil {
		t.Fatalf("a granted cover of assigned short stock must pass with AllowStocks off: %v", err)
	}
	// The same orders without the grant are refused exactly as before: ordinary stock requests stay denied.
	plain := resolverOrderFor(grantFor("sell", 200), 200)
	plain.ResolverGrant = nil
	if _, err := base.ValidateOrder(plain, BrokerRiskSnapshot{Positions: longStock}); err == nil || !strings.Contains(err.Error(), "stock trading is disabled") {
		t.Fatalf("an ordinary stock sale must stay denied, got %v", err)
	}
	refused := map[string]struct {
		policy func(p *TradingPolicy)
		order  func(o *interfaces.Order)
		snap   BrokerRiskSnapshot
		want   string
	}{
		"operator confirmation is respected": {policy: func(p *TradingPolicy) { p.RequireConfirmation = true }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "operator confirmation"},
		"live account":                       {policy: func(p *TradingPolicy) { p.IsPaper = false }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "live trading"},
		"paper trading disabled":             {policy: func(p *TradingPolicy) { p.AllowPaperTrading = false }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "allowPaperTrading"},
		"invalid configuration":              {policy: func(p *TradingPolicy) { p.InvalidConfiguration = true }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "invalid"},
		"options not allowed":                {policy: func(p *TradingPolicy) { p.AllowOptions = false }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "may trade options"},
		"no stock at the broker":             {snap: BrokerRiskSnapshot{}, want: "not backed by matching broker stock exposure"},
		"wrong direction for the stock":      {order: func(o *interfaces.Order) { o.Side = "buy"; o.ResolverGrant = grantFor("buy", 200) }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "not backed by matching broker stock exposure"},
		"market order":                       {order: func(o *interfaces.Order) { o.Type = "market"; o.LimitPrice = nil }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "limit order"},
		"above the granted quantity":         {order: func(o *interfaces.Order) { o.Qty = 300 }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "exceeds the granted quantity"},
		"different symbol than granted":      {order: func(o *interfaces.Order) { o.Symbol = "MSFT" }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "does not match its grant"},
		"an opening purpose":                 {order: func(o *interfaces.Order) { o.Purpose = "entry" }, snap: BrokerRiskSnapshot{Positions: longStock}, want: "entry, protection, or close"},
	}
	for name, tc := range refused {
		p := base
		if tc.policy != nil {
			tc.policy(&p)
		}
		order := resolverOrderFor(grantFor("sell", 200), 200)
		if tc.order != nil {
			tc.order(order)
		}
		if _, err := p.ValidateOrder(order, tc.snap); err == nil {
			t.Errorf("%s: the order must be refused", name)
		} else if tc.want != "entry, protection, or close" && !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %q should mention %q", name, err, tc.want)
		}
	}
}
