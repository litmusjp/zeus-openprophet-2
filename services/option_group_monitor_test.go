package services

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// Phase C, Step 4 (B07): detecting broken groups, recording them, and deciding what is left for the resolver.

func optPos(symbol string, qty float64) *interfaces.Position {
	side := "long"
	if qty < 0 {
		side = "short"
	}
	return &interfaces.Position{Symbol: symbol, Qty: qty, Side: side}
}

func stockPos(qty float64) *interfaces.Position {
	side := "long"
	if qty < 0 {
		side = "short"
	}
	return &interfaces.Position{Symbol: "AAPL", Qty: qty, Side: side, AssetClass: "us_equity"}
}

func callSpreadState(units float64) database.OptionGroupState {
	legs, _ := EncodeGroupLegs([]interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "sell", "sell_to_open")})
	return database.OptionGroupState{Group: &models.DBOptionGroup{GroupID: "gc", Underlying: "AAPL", Structure: StructureBullCallDebit, Status: "open", LegsJSON: legs, NetDebit: 3, StockBaselineSet: true}, OpenUnits: units}
}

// unbaselinedCall is a group for which no stock position was ever recorded while it was intact (no provenance).
func unbaselinedCall(units float64) database.OptionGroupState {
	state := callSpreadState(units)
	state.Group.StockBaselineSet = false
	return state
}

func putSpreadState(units float64) database.OptionGroupState {
	legs, _ := EncodeGroupLegs([]interfaces.OptionLeg{leg(putHigh, "buy", "buy_to_open"), leg(putLow, "sell", "sell_to_open")})
	return database.OptionGroupState{Group: &models.DBOptionGroup{GroupID: "gp", Underlying: "AAPL", Structure: StructureBearPutDebit, Status: "open", LegsJSON: legs, NetDebit: 3, StockBaselineSet: true}, OpenUnits: units}
}

func TestEvaluateOptionGroup(t *testing.T) {
	cases := []struct {
		name         string
		state        database.OptionGroupState
		positions    []*interfaces.Position
		intact       bool
		linked       bool
		mismatch     bool
		gone, stays  int
		impliedStock float64
	}{
		{"intact call spread", callSpreadState(2), []*interfaces.Position{optPos(callLow, 2), optPos(callHigh, -2)}, true, false, false, 0, 2, 0},
		{"short call assigned, short stock left", callSpreadState(2), []*interfaces.Position{optPos(callLow, 2), stockPos(-200)}, false, true, false, 1, 1, -200},
		{"short put assigned, long stock left", putSpreadState(2), []*interfaces.Position{optPos(putHigh, 2), stockPos(200)}, false, true, false, 1, 1, 200},
		{"half of the short call assigned", callSpreadState(2), []*interfaces.Position{optPos(callLow, 2), optPos(callHigh, -1), stockPos(-100)}, false, true, false, 1, 1, -100},
		{"stock does not match the missing leg", callSpreadState(2), []*interfaces.Position{optPos(callLow, 2), stockPos(-100)}, false, false, true, 1, 1, -200},
		{"stock of the wrong sign", callSpreadState(2), []*interfaces.Position{optPos(callLow, 2), stockPos(200)}, false, false, true, 1, 1, -200},
		{"short leg gone, no stock", callSpreadState(2), []*interfaces.Position{optPos(callLow, 2)}, false, false, false, 1, 1, -200},
		{"both legs gone (expired), no stock", callSpreadState(2), nil, false, false, false, 2, 0, 0},
		{"long leg exercised, stock left", callSpreadState(1), []*interfaces.Position{optPos(callHigh, -1), stockPos(100)}, false, true, false, 1, 1, 100},
		{"stock present while the group is intact is not a finding", callSpreadState(2), []*interfaces.Position{optPos(callLow, 2), optPos(callHigh, -2), stockPos(300)}, true, false, false, 0, 2, 0},
		{"a group with no open units owns nothing", callSpreadState(0), []*interfaces.Position{stockPos(-200)}, true, false, false, 0, 0, 0},
	}
	for _, tc := range cases {
		got, err := EvaluateOptionGroup(tc.state, tc.positions, 0)
		if err != nil {
			t.Errorf("%s: %v", tc.name, err)
			continue
		}
		if got.Intact != tc.intact || got.Linked != tc.linked || (got.Mismatch != "") != tc.mismatch || len(got.GoneLegs) != tc.gone || len(got.SurvivingLegs) != tc.stays {
			t.Errorf("%s: got %+v", tc.name, got)
		}
		if !tc.intact && got.ImpliedStock != tc.impliedStock && tc.impliedStock != 0 {
			t.Errorf("%s: implied stock %.0f, want %.0f", tc.name, got.ImpliedStock, tc.impliedStock)
		}
	}
	bad := callSpreadState(1)
	bad.Group.LegsJSON = "{nope"
	if _, err := EvaluateOptionGroup(bad, nil, 0); err == nil || !strings.Contains(err.Error(), "unreadable legs") {
		t.Errorf("unreadable legs must be an error, got %v", err)
	}
}

type memGroupStore struct {
	states  []database.OptionGroupState
	saved   map[string]*models.DBOptionGroup
	listErr error
	saveErr error
}

func (m *memGroupStore) OptionGroupStates() ([]database.OptionGroupState, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	return m.states, nil
}

func (m *memGroupStore) ClaimResolverOperation(groupID, clientID string) (bool, string, error) {
	return true, "", nil
}

func (m *memGroupStore) SaveOptionGroup(group *models.DBOptionGroup) error {
	if m.saveErr != nil {
		return m.saveErr
	}
	if m.saved == nil {
		m.saved = map[string]*models.DBOptionGroup{}
	}
	copied := *group
	m.saved[group.GroupID] = &copied
	return nil
}

func TestReconcileRecordsBrokenGroupsAndDetachesSurvivors(t *testing.T) {
	store := &memGroupStore{states: []database.OptionGroupState{callSpreadState(2)}}
	report, err := ReconcileOptionGroups(store, []*interfaces.Position{optPos(callLow, 2), stockPos(-200)})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.NewlyBroken) != 1 || len(report.NeedsResolver) != 1 || len(report.Unresolved) != 0 || len(report.ClosedWithoutStock) != 0 {
		t.Fatalf("report = %+v", report)
	}
	saved := store.saved["gc"]
	if saved == nil || saved.Status != "broken" || saved.BrokenReason == "" {
		t.Fatalf("the group must be recorded broken with a reason, got %+v", saved)
	}
	// The surviving long call is detached into ordinary single-leg management; the gone short call is not.
	if !strings.Contains(saved.DetachedLegsJSON, callLow) || strings.Contains(saved.DetachedLegsJSON, callHigh) {
		t.Fatalf("only the surviving leg may be detached, got %s", saved.DetachedLegsJSON)
	}
	// A second pass over the recorded state does not detach again or record it as newly broken.
	second := callSpreadState(2)
	second.Group = store.saved["gc"]
	store2 := &memGroupStore{states: []database.OptionGroupState{second}}
	report, err = ReconcileOptionGroups(store2, []*interfaces.Position{optPos(callLow, 2), stockPos(-200)})
	if err != nil || len(report.NewlyBroken) != 0 || len(report.NeedsResolver) != 1 {
		t.Fatalf("second pass: report=%+v err=%v", report, err)
	}
	if len(store2.saved) != 0 {
		t.Fatalf("an already recorded broken group must not be written again, got %v", store2.saved)
	}
}

func TestReconcileClosesAGroupWithNothingLeftToResolve(t *testing.T) {
	store := &memGroupStore{states: []database.OptionGroupState{callSpreadState(2)}}
	report, err := ReconcileOptionGroups(store, nil) // both legs expired, no stock
	if err != nil || len(report.ClosedWithoutStock) != 1 || len(report.NeedsResolver) != 0 || len(report.Unresolved) != 0 {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	if store.saved["gc"].Status != "closed" {
		t.Fatalf("a group with nothing left to resolve must be closed, got %q", store.saved["gc"].Status)
	}
}

func TestReconcileLeavesMismatchedStockAloneAndReportsIt(t *testing.T) {
	store := &memGroupStore{states: []database.OptionGroupState{callSpreadState(2)}}
	report, err := ReconcileOptionGroups(store, []*interfaces.Position{optPos(callLow, 2), stockPos(-100)})
	if err != nil || len(report.Unresolved) != 1 || len(report.NeedsResolver) != 0 {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	if store.saved["gc"].Status != "broken" {
		t.Fatalf("an unresolved group must stay broken, got %q", store.saved["gc"].Status)
	}
	if !strings.Contains(report.Unresolved[0].Mismatch, "does not match") {
		t.Fatalf("the mismatch must be stated, got %q", report.Unresolved[0].Mismatch)
	}
}

func TestReconcileErrorsAreNeverSwallowed(t *testing.T) {
	if _, err := ReconcileOptionGroups(&memGroupStore{listErr: fmt.Errorf("db down")}, nil); err == nil {
		t.Fatal("a ledger read failure must be returned")
	}
	store := &memGroupStore{states: []database.OptionGroupState{callSpreadState(2)}, saveErr: fmt.Errorf("disk full")}
	if _, err := ReconcileOptionGroups(store, []*interfaces.Position{optPos(callLow, 2), stockPos(-200)}); err == nil {
		t.Fatal("a failure to record a broken group must be returned")
	}
}

func TestBrokenGroupBlocksNewSpreadEntriesButNotSingleLegTrading(t *testing.T) {
	p := spreadPolicy("bull_call_debit,long_call,long_put")
	broken := OptionGroupRisk{ID: "gc", LegSymbols: []string{callHigh}, OpenUnits: 2, Broken: true, MaxLoss: 600}
	if _, err := p.ValidateOptionsOrder(bullCallOpen(), spreadSnapshot(broken)); err == nil || !strings.Contains(err.Error(), "broken and unresolved") {
		t.Fatalf("a new spread entry must be refused while a group is broken, got %v", err)
	}
	// A single-leg opening is unaffected, and a broken group holds no deployed spread risk.
	price := 2.0
	single := &interfaces.OptionsOrder{Symbol: "NVDA261218C00150000", Underlying: "NVDA", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price}
	p.MaxDeployedPct = 1 // 1,000; the broken group's 600 must not count
	snap := spreadSnapshot(broken)
	snap.Positions = nil
	if _, err := p.ValidateOptionsOrder(single, snap); err != nil {
		t.Fatalf("single-leg trading must continue while a group is broken: %v", err)
	}
	// Once the group is resolved (no longer returned), spread entries resume automatically.
	if _, err := spreadPolicy("bull_call_debit,long_call,long_put").ValidateOptionsOrder(bullCallOpen(), spreadSnapshot()); err != nil {
		t.Fatalf("spread entries must resume once nothing is broken: %v", err)
	}
}

// One leg disappears with no stock change and no resolver order: a single pass records the surviving leg as detached and
// closes the group although that leg is still held, and the real ledger then stops listing the group.
func TestReconcileOneLegGoneWithNoStockClosesTheGroupInOnePass(t *testing.T) {
	for _, tc := range []struct {
		name           string
		held           *interfaces.Position
		survivor, gone string
	}{
		{"short leg gone, long leg still held", optPos(callLow, 2), callLow, callHigh},
		{"long leg gone, short leg still held", optPos(callHigh, -2), callHigh, callLow},
	} {
		t.Run(tc.name, func(t *testing.T) {
			intact := []*interfaces.Position{optPos(callLow, 2), optPos(callHigh, -2)}
			store := &memGroupStore{states: []database.OptionGroupState{callSpreadState(2)}}
			report, err := ReconcileOptionGroups(store, intact)
			if err != nil || len(report.Findings) != 0 || len(store.saved) != 0 {
				t.Fatalf("the group must start intact: report=%+v saved=%v err=%v", report, store.saved, err)
			}
			report, err = ReconcileOptionGroups(store, []*interfaces.Position{tc.held})
			if err != nil {
				t.Fatal(err)
			}
			saved := store.saved["gc"]
			if saved == nil || saved.Status != "closed" || saved.ResolverClientID != "" {
				t.Fatalf("saved group = %+v", saved)
			}
			if !strings.Contains(saved.DetachedLegsJSON, tc.survivor) || strings.Contains(saved.DetachedLegsJSON, tc.gone) {
				t.Fatalf("only the surviving leg may be detached, got %s", saved.DetachedLegsJSON)
			}
			if len(report.ClosedWithoutStock) != 1 || report.ClosedWithoutStock[0] != "gc" || len(report.NewlyBroken) != 1 ||
				len(report.NeedsResolver) != 0 || len(report.Unresolved) != 0 || len(report.Waiting) != 0 {
				t.Fatalf("report = %+v", report)
			}

			// The same event against the real ledger.
			storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "one-leg.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer storage.Close()
			group := callSpreadState(2).Group
			group.EntryClientOrderID, group.EntryUnits = "gc-entry", 2
			if err := storage.SaveOptionGroup(group); err != nil {
				t.Fatal(err)
			}
			if err := storage.SaveOrder(&interfaces.Order{ClientOrderID: "gc-entry", Symbol: callLow, Underlying: "AAPL", AssetClass: "us_option", Qty: 2, FilledQty: 2, Side: "buy", Type: "limit", TimeInForce: "day", Status: "filled"}); err != nil {
				t.Fatal(err)
			}
			if states, err := storage.OptionGroupStates(); err != nil || len(states) != 1 || states[0].OpenUnits != 2 {
				t.Fatalf("before: states=%+v err=%v", states, err)
			}
			report, err = ReconcileOptionGroups(storage, []*interfaces.Position{tc.held})
			if err != nil || len(report.ClosedWithoutStock) != 1 {
				t.Fatalf("real ledger: report=%+v err=%v", report, err)
			}
			closed, err := storage.GetOptionGroup("gc")
			if err != nil || closed.Status != "closed" || !strings.Contains(closed.DetachedLegsJSON, tc.survivor) || strings.Contains(closed.DetachedLegsJSON, tc.gone) {
				t.Fatalf("real ledger: group=%+v err=%v", closed, err)
			}
			if states, err := storage.OptionGroupStates(); err != nil || len(states) != 0 {
				t.Fatalf("a closed group must no longer be returned: states=%+v err=%v", states, err)
			}
		})
	}
}
