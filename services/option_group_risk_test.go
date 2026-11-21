package services

import (
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/shopspring/decimal"

	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// Phase C, Step 4: the risk view built from the durable group ledger, and the multi-leg broker order conversion.

func groupState(id string, openUnits, netDebit float64, status string, detached string) database.OptionGroupState {
	legs, _ := EncodeGroupLegs([]interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "sell", "sell_to_open")})
	return database.OptionGroupState{
		Group:     &models.DBOptionGroup{GroupID: id, Structure: StructureBullCallDebit, Status: status, LegsJSON: legs, DetachedLegsJSON: detached, NetDebit: netDebit},
		OpenUnits: openUnits,
	}
}

func TestOptionGroupRisksFromStates(t *testing.T) {
	risks, err := OptionGroupRisksFromStates([]database.OptionGroupState{groupState("g1", 2, 3.0, "open", ""), groupState("g2", 0, 3.0, "pending_entry", "")})
	if err != nil || len(risks) != 2 {
		t.Fatalf("risks=%v err=%v", risks, err)
	}
	if risks[0].MaxLoss != 600 || risks[0].OpenUnits != 2 || len(risks[0].LegSymbols) != 2 || risks[0].Broken {
		t.Fatalf("an open group's max loss must be net debit x units x 100: %+v", risks[0])
	}
	// A group with no filled units owns nothing yet and counts nothing.
	if risks[1].OpenUnits != 0 || risks[1].MaxLoss != 0 || openGroupOwningSymbol(risks[1:], callLow) != "" {
		t.Fatalf("an unfilled entry must own no legs: %+v", risks[1])
	}
	// A leg durably detached into single-leg management is no longer owned by the group.
	detached, _ := EncodeGroupLegs([]interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open")})
	risks, err = OptionGroupRisksFromStates([]database.OptionGroupState{groupState("g3", 2, 3.0, "broken", detached)})
	if err != nil || !risks[0].Broken || len(risks[0].LegSymbols) != 1 || risks[0].LegSymbols[0] != callHigh {
		t.Fatalf("a detached leg must leave the group: %+v err=%v", risks, err)
	}
	if openGroupOwningSymbol(risks, callLow) != "" || openGroupOwningSymbol(risks, callHigh) != "g3" {
		t.Fatalf("only the attached leg stays owned by the group")
	}
	// Unreadable legs fail closed.
	bad := groupState("g4", 1, 1, "open", "")
	bad.Group.LegsJSON = "{not json"
	if _, err := OptionGroupRisksFromStates([]database.OptionGroupState{bad}); err == nil || !strings.Contains(err.Error(), "unreadable legs") {
		t.Fatalf("unreadable legs must fail closed, got %v", err)
	}
}

func TestPendingMultiLegOrderIsCountedAtOneHundredPerUnit(t *testing.T) {
	// A pending multi-leg broker order has no parent symbol; its legs mark it as an option order, so its net debit counts x100.
	p := spreadPolicy("bull_call_debit")
	p.MaxDeployedPct = 1 // 1,000 of 100,000
	price := 4.0
	pending := &interfaces.Order{ClientOrderID: "p1", Qty: 2, LimitPrice: &price, Purpose: "entry", Status: "new", OptionLegs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "sell", "sell_to_open")}}
	snap := BrokerRiskSnapshot{Account: spreadSnapshot().Account, PendingOrders: []*interfaces.Order{pending}}
	order := bullCallOpen()
	order.Symbol = "AAPL261218C00220000"
	order.Legs = []interfaces.OptionLeg{leg("AAPL261218C00220000", "buy", "buy_to_open"), leg("AAPL261218C00230000", "sell", "sell_to_open")}
	// pending 2 x 4.00 x 100 = 800; new 2 x 3.00 x 100 = 600; 1,400 > 1,000.
	if _, err := p.ValidateOptionsOrder(order, snap); err == nil || !strings.Contains(err.Error(), "max deployed percentage") {
		t.Fatalf("a pending multi-leg order must count x100 against the deployed cap, got %v", err)
	}
}

func TestConvertAlpacaOrderCarriesMultiLegIdentity(t *testing.T) {
	ratio := decimal.NewFromInt(1)
	qty := decimal.NewFromInt(2)
	limit := decimal.NewFromInt(-4)
	mk := func(intentA, intentB alpaca.PositionIntent) *alpaca.Order {
		return &alpaca.Order{ID: "b1", ClientOrderID: "c1", OrderClass: alpaca.MLeg, Qty: &qty, LimitPrice: &limit, Type: alpaca.Limit, TimeInForce: alpaca.Day, Status: "new", SubmittedAt: time.Now(),
			Legs: []alpaca.Order{
				{Symbol: callLow, Side: alpaca.Sell, PositionIntent: intentA, RatioQty: &ratio},
				{Symbol: callHigh, Side: alpaca.Buy, PositionIntent: intentB, RatioQty: &ratio},
			}}
	}
	closeOrder := convertAlpacaOrderStatic(mk(alpaca.SellToClose, alpaca.BuyToClose))
	if closeOrder.AssetClass != "us_option" || closeOrder.Underlying != "AAPL" || closeOrder.Purpose != "close" || len(closeOrder.OptionLegs) != 2 || closeOrder.Symbol != "" {
		t.Fatalf("a multi-leg close must carry its legs and a close purpose with no parent symbol: %+v", closeOrder)
	}
	if closeOrder.OptionLegs[0].Symbol != callLow || closeOrder.OptionLegs[0].RatioQty != 1 || closeOrder.OptionLegs[1].Side != "buy" {
		t.Fatalf("legs must be carried exactly: %+v", closeOrder.OptionLegs)
	}
	if entry := convertAlpacaOrderStatic(mk(alpaca.BuyToOpen, alpaca.SellToOpen)); entry.Purpose != "entry" {
		t.Fatalf("all-opening legs must be an entry, got %q", entry.Purpose)
	}
	if mixed := convertAlpacaOrderStatic(mk(alpaca.BuyToOpen, alpaca.SellToClose)); mixed.Purpose != "" {
		t.Fatalf("mixed legs must have no purpose, got %q", mixed.Purpose)
	}
	// A single-leg broker order is unchanged: no legs, parent fields as returned.
	single := convertAlpacaOrderStatic(&alpaca.Order{ID: "b2", ClientOrderID: "c2", Symbol: callLow, Side: alpaca.Buy, Qty: &qty, Type: alpaca.Limit, TimeInForce: alpaca.Day, Status: "new", PositionIntent: alpaca.BuyToOpen})
	if len(single.OptionLegs) != 0 || single.Symbol != callLow || single.Purpose != "entry" {
		t.Fatalf("a single-leg order must be unchanged: %+v", single)
	}
}
