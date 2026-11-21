package controllers

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"prophet-trader/database"
	"prophet-trader/interfaces"
)

// Phase C, Step 4: the controller side of the group ledger and the multi-leg order matching.

const (
	gCallLow  = "AAPL261218C00200000"
	gCallHigh = "AAPL261218C00210000"
)

func gLeg(symbol, side, intent string) interfaces.OptionLeg {
	return interfaces.OptionLeg{Symbol: symbol, Side: side, PositionIntent: intent, RatioQty: 1, Price: 1}
}

func gEntry(clientID string) *interfaces.OptionsOrder {
	price := 3.0
	return &interfaces.OptionsOrder{ClientOrderID: clientID, Symbol: gCallLow, Underlying: "AAPL", Qty: 2, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price, PriceKind: "debit",
		Legs: []interfaces.OptionLeg{gLeg(gCallLow, "buy", "buy_to_open"), gLeg(gCallHigh, "sell", "sell_to_open")}}
}

func gClose(clientID string) *interfaces.OptionsOrder {
	price := 4.0
	return &interfaces.OptionsOrder{ClientOrderID: clientID, Symbol: gCallLow, Underlying: "AAPL", Qty: 2, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: &price, PriceKind: "credit",
		Legs: []interfaces.OptionLeg{gLeg(gCallLow, "sell", "sell_to_close"), gLeg(gCallHigh, "buy", "buy_to_close")}}
}

func groupController(t *testing.T) (*OrderController, *database.LocalStorage) {
	t.Helper()
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "groups.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { storage.Close() })
	return NewOrderController(&reconciliationTradingService{}, nil, storage), storage
}

func fillEntry(t *testing.T, storage *database.LocalStorage, clientID string, filled float64) {
	t.Helper()
	order, err := storage.GetOrderByClientOrderID(clientID)
	if err != nil || order == nil {
		order = &interfaces.Order{ClientOrderID: clientID, Symbol: gCallLow, Underlying: "AAPL", AssetClass: "us_option", Qty: 2, Side: "buy", Type: "limit", TimeInForce: "day"}
	}
	order.Status, order.FilledQty = "filled", filled
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
}

func TestSingleLegOrdersNeverTouchTheGroupLedger(t *testing.T) {
	oc, storage := groupController(t)
	price := 1.0
	single := &interfaces.OptionsOrder{ClientOrderID: "single-1", Symbol: gCallLow, Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
	id, err := oc.registerSpreadBeforeSubmission(single)
	if id != "" || err != nil {
		t.Fatalf("a single-leg order must be ignored, got (%q, %v)", id, err)
	}
	if groups, _ := storage.ListOptionGroups(); len(groups) != 0 {
		t.Fatalf("no group may be written for a single leg, got %d", len(groups))
	}
}

func TestSpreadEntryIsRecordedBeforeSubmissionAndIsIdempotent(t *testing.T) {
	oc, storage := groupController(t)
	id, err := oc.registerSpreadBeforeSubmission(gEntry("grp-e1"))
	if err != nil || id != "grp-e1" {
		t.Fatalf("entry registration = (%q, %v)", id, err)
	}
	group, err := storage.GetOptionGroup("grp-e1")
	if err != nil || group.Status != "pending_entry" || group.Structure != "bull_call_debit" || group.NetDebit != 3 || group.EntryUnits != 2 || group.EntryClientOrderID != "grp-e1" {
		t.Fatalf("recorded group = %+v err=%v", group, err)
	}
	if !strings.Contains(group.LegsJSON, gCallLow) || !strings.Contains(group.LegsJSON, gCallHigh) {
		t.Fatalf("the exact legs must be recorded, got %s", group.LegsJSON)
	}
	// A retry with the same identity is idempotent; the same id with different legs is refused.
	if _, err := oc.registerSpreadBeforeSubmission(gEntry("grp-e1")); err != nil {
		t.Fatalf("an identical retry must be accepted: %v", err)
	}
	other := gEntry("grp-e1")
	other.Legs = []interfaces.OptionLeg{gLeg(gCallLow, "buy", "buy_to_open"), gLeg("AAPL261218C00220000", "sell", "sell_to_open")}
	if _, err := oc.registerSpreadBeforeSubmission(other); err == nil {
		t.Fatal("the same client id with different legs must be refused")
	}
	// An unsupported shape and a missing price are refused before anything is recorded.
	credit := gEntry("grp-e2")
	credit.Legs = []interfaces.OptionLeg{gLeg(gCallHigh, "buy", "buy_to_open"), gLeg(gCallLow, "sell", "sell_to_open")}
	if _, err := oc.registerSpreadBeforeSubmission(credit); err == nil {
		t.Fatal("a credit-shaped call spread must be refused")
	}
	noPrice := gEntry("grp-e3")
	noPrice.LimitPrice = nil
	if _, err := oc.registerSpreadBeforeSubmission(noPrice); err == nil {
		t.Fatal("an entry without a net debit must be refused")
	}
	if groups, _ := storage.ListOptionGroups(); len(groups) != 1 {
		t.Fatalf("only the one valid group may exist, got %d", len(groups))
	}
}

func TestSpreadCloseNeedsAnOpenGroupAndIsRecordedBeforeSubmission(t *testing.T) {
	oc, storage := groupController(t)
	if _, err := oc.registerSpreadBeforeSubmission(gClose("grp-c0")); err == nil || !strings.Contains(err.Error(), "not backed by an open spread group") {
		t.Fatalf("a close with no group must be refused, got %v", err)
	}
	if _, err := oc.registerSpreadBeforeSubmission(gEntry("grp-1")); err != nil {
		t.Fatal(err)
	}
	// Entry recorded but nothing filled yet: still no open units, so no close.
	if _, err := oc.registerSpreadBeforeSubmission(gClose("grp-c1")); err == nil {
		t.Fatal("a close before any fill must be refused")
	}
	fillEntry(t, storage, "grp-1", 2)
	id, err := oc.registerSpreadBeforeSubmission(gClose("grp-c1"))
	if err != nil || id != "grp-1" {
		t.Fatalf("a close of a filled group must register on it, got (%q, %v)", id, err)
	}
	states, _ := storage.OptionGroupStates()
	if len(states) != 1 || len(states[0].CloseOrders) != 1 || states[0].CloseOrders[0] != "grp-c1" || !states[0].PendingClose {
		t.Fatalf("the close order must be recorded and pending, got %+v", states)
	}
	// A broken group is not closed as a group.
	group, _ := storage.GetOptionGroup("grp-1")
	group.Status = "broken"
	if err := storage.SaveOptionGroup(group); err != nil {
		t.Fatal(err)
	}
	if _, err := oc.registerSpreadBeforeSubmission(gClose("grp-c2")); err == nil {
		t.Fatal("a broken group must not be closed as a group")
	}
}

func TestFinishSpreadEntryRecordsOpenAndVoid(t *testing.T) {
	oc, storage := groupController(t)
	entry := gEntry("grp-f1")
	if _, err := oc.registerSpreadBeforeSubmission(entry); err != nil {
		t.Fatal(err)
	}
	oc.finishSpreadEntry("grp-f1", entry, "open")
	if g, _ := storage.GetOptionGroup("grp-f1"); g.Status != "open" {
		t.Fatalf("status = %q, want open", g.Status)
	}
	voided := gEntry("grp-f2")
	if _, err := oc.registerSpreadBeforeSubmission(voided); err != nil {
		t.Fatal(err)
	}
	oc.finishSpreadEntry("grp-f2", voided, "void")
	if g, _ := storage.GetOptionGroup("grp-f2"); g.Status != "void" {
		t.Fatalf("status = %q, want void", g.Status)
	}
	// A void group no longer counts as live.
	states, _ := storage.OptionGroupStates()
	for _, s := range states {
		if s.Group.GroupID == "grp-f2" {
			t.Fatal("a void group must not be listed as live")
		}
	}
	// Closing orders and unknown ids are ignored.
	oc.finishSpreadEntry("", entry, "void")
	oc.finishSpreadEntry("grp-f1", gClose("x"), "void")
}

func TestBrokerOrderMatchingUsesTheLegsForAMultiLegOrder(t *testing.T) {
	legs := []interfaces.OptionLeg{gLeg(gCallLow, "buy", "buy_to_open"), gLeg(gCallHigh, "sell", "sell_to_open")}
	brokerLegs := []interfaces.OptionLeg{{Symbol: gCallHigh, Side: "sell", PositionIntent: "sell_to_open", RatioQty: 1}, {Symbol: gCallLow, Side: "buy", PositionIntent: "buy_to_open", RatioQty: 1}}
	local := &interfaces.Order{ClientOrderID: "c1", Symbol: gCallLow, Side: "buy", Qty: 2, Type: "limit", TimeInForce: "day", AssetClass: "us_option", PositionIntent: "buy_to_open", OptionLegs: legs}
	broker := &interfaces.Order{ID: "b1", ClientOrderID: "c1", Qty: 2, Type: "limit", TimeInForce: "day", OptionLegs: brokerLegs}
	if !brokerOrderMatchesLocal(local, broker) {
		t.Fatal("a multi-leg broker order with an empty parent must match its local order by legs, in any leg order")
	}
	for name, mutate := range map[string]func(b *interfaces.Order){
		"different qty":       func(b *interfaces.Order) { b.Qty = 3 },
		"different client id": func(b *interfaces.Order) { b.ClientOrderID = "other" },
		"different leg": func(b *interfaces.Order) {
			b.OptionLegs = []interfaces.OptionLeg{brokerLegs[0], {Symbol: "AAPL261218C00220000", Side: "buy", PositionIntent: "buy_to_open", RatioQty: 1}}
		},
		"different side": func(b *interfaces.Order) {
			b.OptionLegs = []interfaces.OptionLeg{brokerLegs[0], {Symbol: gCallLow, Side: "sell", PositionIntent: "buy_to_open", RatioQty: 1}}
		},
		"missing legs":   func(b *interfaces.Order) { b.OptionLegs = nil },
		"different type": func(b *interfaces.Order) { b.Type = "market" },
	} {
		bad := *broker
		mutate(&bad)
		if brokerOrderMatchesLocal(local, &bad) {
			t.Errorf("%s must not match", name)
		}
	}
	// A single-leg order still matches on symbol, side and intent exactly as before.
	single := &interfaces.Order{ClientOrderID: "s1", Symbol: gCallLow, Side: "buy", Qty: 1, Type: "limit", TimeInForce: "day", AssetClass: "us_option", PositionIntent: "buy_to_open"}
	brokerSingle := &interfaces.Order{ID: "bs1", ClientOrderID: "s1", Symbol: gCallLow, Side: "buy", Qty: 1, Type: "limit", TimeInForce: "day", AssetClass: "us_option", PositionIntent: "buy_to_open"}
	if !brokerOrderMatchesLocal(single, brokerSingle) {
		t.Fatal("a single-leg order must match as before")
	}
	brokerSingle.Symbol = "AAPL261218C00210000"
	if brokerOrderMatchesLocal(single, brokerSingle) {
		t.Fatal("a single-leg order with another symbol must not match")
	}
}

func TestGetOptionGroupsIsReadOnlyStatus(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc, storage := groupController(t)
	if _, err := oc.registerSpreadBeforeSubmission(gEntry("grp-s1")); err != nil {
		t.Fatal(err)
	}
	fillEntry(t, storage, "grp-s1", 2)
	call := func() (int, map[string]any) {
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest("GET", "/options/groups", nil)
		oc.GetOptionGroups(c)
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body
	}
	code, body := call()
	groups, _ := body["groups"].([]any)
	if code != 200 || len(groups) != 1 || body["broken_groups"].(float64) != 0 {
		t.Fatalf("status = %d body = %v", code, body)
	}
	g := groups[0].(map[string]any)
	if g["group_id"] != "grp-s1" || g["structure"] != "bull_call_debit" || g["open_units"].(float64) != 2 || g["net_debit_per_unit"].(float64) != 3 {
		t.Fatalf("group = %v", g)
	}
	// A broken group is reported with its reason and the note says new entries are refused; nothing is written by reading.
	group, _ := storage.GetOptionGroup("grp-s1")
	group.Status, group.BrokenReason, group.ResolverClientID = "broken", "short leg missing", "resolver-grp-s1-1"
	if err := storage.SaveOptionGroup(group); err != nil {
		t.Fatal(err)
	}
	_, body = call()
	g = body["groups"].([]any)[0].(map[string]any)
	if body["broken_groups"].(float64) != 1 || g["broken_reason"] != "short leg missing" || g["resolver_client_order_id"] != "resolver-grp-s1-1" || !strings.Contains(body["note"].(string), "refused") {
		t.Fatalf("broken status = %v", body)
	}
	before, _ := storage.GetOptionGroup("grp-s1")
	call()
	after, _ := storage.GetOptionGroup("grp-s1")
	if before.Revision != after.Revision {
		t.Fatal("reading the status must not write anything")
	}
}
