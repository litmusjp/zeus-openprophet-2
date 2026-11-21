package database

import (
	"path/filepath"
	"testing"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// Phase C, Step 4: the durable group ledger.

func newGroupStorage(t *testing.T, name string) (*LocalStorage, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	storage, err := NewLocalStorage(path)
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	t.Cleanup(func() { storage.Close() })
	return storage, path
}

func testGroup(id string) *models.DBOptionGroup {
	return &models.DBOptionGroup{
		GroupID: id, Underlying: "AAPL", Structure: "bull_call_debit", Status: "open",
		LegsJSON:           `[{"symbol":"AAPL261218C00200000","side":"buy","ratio_qty":1},{"symbol":"AAPL261218C00210000","side":"sell","ratio_qty":1}]`,
		EntryClientOrderID: id, EntryUnits: 3, NetDebit: 3.0,
	}
}

func saveOrderFilled(t *testing.T, storage *LocalStorage, clientID, status string, qty, filled float64) {
	t.Helper()
	order, err := storage.GetOrderByClientOrderID(clientID)
	if err != nil || order == nil {
		order = &interfaces.Order{ClientOrderID: clientID, Symbol: "AAPL261218C00200000", Underlying: "AAPL", AssetClass: "us_option", Qty: qty, Side: "buy", Type: "limit", TimeInForce: "day"}
	}
	order.Status, order.FilledQty = status, filled
	if err := storage.SaveOrder(order); err != nil {
		t.Fatalf("SaveOrder(%s) error = %v", clientID, err)
	}
}

func TestOptionGroupRoundTripAndImmutableLegs(t *testing.T) {
	storage, _ := newGroupStorage(t, "groups.db")
	if err := storage.SaveOptionGroup(testGroup("grp-1")); err != nil {
		t.Fatal(err)
	}
	got, err := storage.GetOptionGroup("grp-1")
	if err != nil || got.Structure != "bull_call_debit" || got.NetDebit != 3.0 || got.Revision != 1 {
		t.Fatalf("round trip = %+v err=%v", got, err)
	}
	// The same group can be updated (status), and the revision moves.
	update := testGroup("grp-1")
	update.Status = "broken"
	update.BrokenReason = "short leg assigned"
	if err := storage.SaveOptionGroup(update); err != nil {
		t.Fatal(err)
	}
	got, _ = storage.GetOptionGroup("grp-1")
	if got.Status != "broken" || got.Revision != 2 || got.BrokenReason == "" {
		t.Fatalf("update = %+v", got)
	}
	// Legs, structure and entry order can never be rewritten.
	for name, mutate := range map[string]func(g *models.DBOptionGroup){
		"legs":      func(g *models.DBOptionGroup) { g.LegsJSON = `[]` },
		"structure": func(g *models.DBOptionGroup) { g.Structure = "bear_put_debit" },
		"entry":     func(g *models.DBOptionGroup) { g.EntryClientOrderID = "other" },
	} {
		bad := testGroup("grp-1")
		mutate(bad)
		if err := storage.SaveOptionGroup(bad); err == nil {
			t.Errorf("rewriting the %s of a recorded group must be refused", name)
		}
	}
	if err := storage.SaveOptionGroup(&models.DBOptionGroup{}); err == nil {
		t.Error("a group without an id must be refused")
	}
}

func TestOptionGroupIsScopedToTheDurableIdentity(t *testing.T) {
	storage, path := newGroupStorage(t, "scope.db")
	if err := storage.SaveOptionGroup(testGroup("grp-1")); err != nil {
		t.Fatal(err)
	}
	storage.Close()
	t.Setenv("OPENPROPHET_SANDBOX_ID", "another-sandbox")
	other, err := NewLocalStorage(path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := other.GetOptionGroup("grp-1"); err == nil {
		t.Fatal("a group of another sandbox must not be readable")
	}
	groups, err := other.ListOptionGroups()
	if err != nil || len(groups) != 0 {
		t.Fatalf("another sandbox must list no groups, got %d err=%v", len(groups), err)
	}
}

func TestOptionGroupOpenUnitsAreDerivedFromTheOrderLedger(t *testing.T) {
	storage, _ := newGroupStorage(t, "units.db")
	if err := storage.SaveOptionGroup(testGroup("grp-1")); err != nil {
		t.Fatal(err)
	}
	// Entry order not yet persisted or not filled: zero open units.
	states, err := storage.OptionGroupStates()
	if err != nil || len(states) != 1 || states[0].OpenUnits != 0 {
		t.Fatalf("an unfilled entry must give 0 open units, got %+v err=%v", states, err)
	}
	saveOrderFilled(t, storage, "grp-1", "partially_filled", 3, 2)
	states, _ = storage.OptionGroupStates()
	if states[0].OpenUnits != 2 || states[0].EntryFilled != 2 {
		t.Fatalf("a partial entry must give 2 open units, got %+v", states[0])
	}
	saveOrderFilled(t, storage, "grp-1", "filled", 3, 3)
	// A close order recorded before submission (no order row yet) counts as working, and subtracts nothing.
	if err := storage.AddOptionGroupCloseOrder("grp-1", "grp-1-close-1"); err != nil {
		t.Fatal(err)
	}
	if err := storage.AddOptionGroupCloseOrder("grp-1", "grp-1-close-1"); err != nil {
		t.Fatal(err)
	}
	states, _ = storage.OptionGroupStates()
	if len(states[0].CloseOrders) != 1 || !states[0].PendingClose || states[0].OpenUnits != 3 {
		t.Fatalf("a recorded unsubmitted close must be pending with 3 open units, got %+v", states[0])
	}
	// A partly filled close reduces the open units and stays pending; a fully filled one reduces them and is terminal.
	saveOrderFilled(t, storage, "grp-1-close-1", "partially_filled", 3, 1)
	states, _ = storage.OptionGroupStates()
	if states[0].OpenUnits != 2 || !states[0].PendingClose {
		t.Fatalf("a partial close must leave 2 open units and pending, got %+v", states[0])
	}
	saveOrderFilled(t, storage, "grp-1-close-1", "filled", 3, 3)
	states, _ = storage.OptionGroupStates()
	if states[0].OpenUnits != 0 || states[0].PendingClose {
		t.Fatalf("a full close must leave 0 open units and nothing pending, got %+v", states[0])
	}
}

func TestOptionGroupStatesListOnlyNonTerminalGroups(t *testing.T) {
	storage, _ := newGroupStorage(t, "terminal.db")
	for id, status := range map[string]string{"g-open": "open", "g-pending": "pending_entry", "g-broken": "broken", "g-closed": "closed", "g-void": "void"} {
		g := testGroup(id)
		g.Status = status
		if err := storage.SaveOptionGroup(g); err != nil {
			t.Fatal(err)
		}
	}
	states, err := storage.OptionGroupStates()
	if err != nil || len(states) != 3 {
		t.Fatalf("only pending_entry, open and broken groups are live, got %d err=%v", len(states), err)
	}
	if err := storage.AddOptionGroupCloseOrder("missing", "x"); err == nil {
		t.Error("recording a close order on an unknown group must be refused")
	}
}

func TestOptionGroupSurvivesARestart(t *testing.T) {
	storage, path := newGroupStorage(t, "restart.db")
	if err := storage.SaveOptionGroup(testGroup("grp-r1")); err != nil {
		t.Fatal(err)
	}
	saveOrderFilled(t, storage, "grp-r1", "filled", 3, 3)
	if err := storage.AddOptionGroupCloseOrder("grp-r1", "grp-r1-close-1"); err != nil {
		t.Fatal(err)
	}
	saveOrderFilled(t, storage, "grp-r1-close-1", "partially_filled", 3, 1)
	group, _ := storage.GetOptionGroup("grp-r1")
	group.Status, group.BrokenReason, group.ResolverClientID = "broken", "short leg missing", "resolver-grp-r1-1"
	if err := storage.SaveOptionGroup(group); err != nil {
		t.Fatal(err)
	}
	storage.Close()

	reopened, err := NewLocalStorage(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	states, err := reopened.OptionGroupStates()
	if err != nil || len(states) != 1 {
		t.Fatalf("a reopened ledger must return the live group: %d err=%v", len(states), err)
	}
	s := states[0]
	if s.Group.Status != "broken" || s.Group.ResolverClientID != "resolver-grp-r1-1" || s.Group.BrokenReason == "" {
		t.Fatalf("the broken status and the resolver operation must survive a restart: %+v", s.Group)
	}
	if s.EntryFilled != 3 || s.CloseFilled != 1 || s.OpenUnits != 2 || !s.PendingClose {
		t.Fatalf("units must be derived identically after a restart: %+v", s)
	}
}
