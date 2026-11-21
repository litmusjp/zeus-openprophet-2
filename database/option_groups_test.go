package database

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
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
	update := got
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

func TestReservedCloseUnitsFollowTheWorkingClosesAndExcludeTheCandidate(t *testing.T) {
	storage, _ := newGroupStorage(t, "reserve.db")
	if err := storage.SaveOptionGroup(testGroup("grp-q1")); err != nil {
		t.Fatal(err)
	}
	saveOrderFilled(t, storage, "grp-q1", "filled", 3, 3)
	reserved := func(exclude string) (float64, float64) {
		states, err := storage.OptionGroupStatesExcluding(exclude)
		if err != nil || len(states) != 1 {
			t.Fatalf("states=%d err=%v", len(states), err)
		}
		return states[0].ReservedCloseUnits, states[0].OpenUnits
	}
	if r, o := reserved(""); r != 0 || o != 3 {
		t.Fatalf("no close yet: reserved=%v open=%v", r, o)
	}
	// A close recorded before it is persisted reserves every open unit (its quantity is unknown), except for itself.
	if err := storage.AddOptionGroupCloseOrder("grp-q1", "grp-q1-close-a"); err != nil {
		t.Fatal(err)
	}
	if r, _ := reserved(""); r != 3 {
		t.Fatalf("an unpersisted close must reserve all open units, got %v", r)
	}
	if r, _ := reserved("grp-q1-close-a"); r != 0 {
		t.Fatalf("the candidate must never reserve against itself, got %v", r)
	}
	// Accepted for 3 with 1 filled: 2 unfilled units stay reserved; open units drop by the fill.
	saveOrderFilled(t, storage, "grp-q1-close-a", "partially_filled", 3, 1)
	if r, o := reserved(""); r != 2 || o != 2 {
		t.Fatalf("a partial close must reserve its unfilled 2 of the 2 open units, got reserved=%v open=%v", r, o)
	}
	// A second close registered alongside is itself reserved (clamped to what is open).
	if err := storage.AddOptionGroupCloseOrder("grp-q1", "grp-q1-close-b"); err != nil {
		t.Fatal(err)
	}
	if r, _ := reserved("grp-q1-close-b"); r != 2 {
		t.Fatalf("with the second close excluded only the first reserves: %v", r)
	}
	// A terminal cancel releases the remainder: the 1 filled unit stays closed, nothing is reserved.
	saveOrderFilled(t, storage, "grp-q1-close-a", "canceled", 3, 1)
	saveOrderFilled(t, storage, "grp-q1-close-b", "canceled", 2, 0)
	if r, o := reserved(""); r != 0 || o != 2 {
		t.Fatalf("after terminal cancels nothing is reserved and 2 units remain open: reserved=%v open=%v", r, o)
	}
}

func TestAddOptionGroupCloseOrderNeverLosesIdsUnderOverlap(t *testing.T) {
	storage, _ := newGroupStorage(t, "overlap.db")
	if err := storage.SaveOptionGroup(testGroup("grp-o1")); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := storage.AddOptionGroupCloseOrder("grp-o1", fmt.Sprintf("grp-o1-close-%d", i)); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	states, _ := storage.OptionGroupStates()
	if len(states[0].CloseOrders) != 12 {
		t.Fatalf("no close id may be lost under overlapping registrations, got %d of 12", len(states[0].CloseOrders))
	}
}

func TestResolverClaimIsAtomicPerUnderlyingAndSurvivesARestart(t *testing.T) {
	storage, path := newGroupStorage(t, "claim.db")
	for _, id := range []string{"grp-c1", "grp-c2"} {
		if err := storage.SaveOptionGroup(testGroup(id)); err != nil {
			t.Fatal(err)
		}
	}
	// Barrier-synchronised overlapping claims by two groups of the same underlying: exactly one wins.
	var wg sync.WaitGroup
	start := make(chan struct{})
	wins := make([]bool, 2)
	owners := make([]string, 2)
	for i, id := range []string{"grp-c1", "grp-c2"} {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			<-start
			ok, owner, err := storage.ClaimResolverOperation(id, "resolver-"+id+"-1")
			if err != nil {
				t.Error(err)
			}
			wins[i], owners[i] = ok, owner
		}(i, id)
	}
	close(start)
	wg.Wait()
	if wins[0] == wins[1] {
		t.Fatalf("exactly one overlapping claim may win: %v", wins)
	}
	winner, loser := "grp-c1", "grp-c2"
	if wins[1] {
		winner, loser = loser, winner
	}
	// The claim is durable across a restart and the loser is still refused while the owner's order is missing or working.
	storage.Close()
	reopened, err := NewLocalStorage(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if g, _ := reopened.GetOptionGroup(winner); g.ResolverClientID != "resolver-"+winner+"-1" {
		t.Fatalf("the winning claim must survive a restart, got %q", g.ResolverClientID)
	}
	if ok, owner, _ := reopened.ClaimResolverOperation(loser, "resolver-"+loser+"-1"); ok || owner != "resolver-"+winner+"-1" {
		t.Fatalf("the loser must be refused while the owner's order is not terminal: ok=%v owner=%q", ok, owner)
	}
	saveOrderFilled(t, reopened, "resolver-"+winner+"-1", "accepted", 200, 0)
	if ok, _, _ := reopened.ClaimResolverOperation(loser, "resolver-"+loser+"-1"); ok {
		t.Fatal("a working owner order must still block the other group")
	}
	saveOrderFilled(t, reopened, "resolver-"+winner+"-1", "canceled", 200, 0)
	if ok, _, err := reopened.ClaimResolverOperation(loser, "resolver-"+loser+"-1"); !ok || err != nil {
		t.Fatalf("once the owner's order is terminal the other group may claim: ok=%v err=%v", ok, err)
	}
	// Re-claiming the same id is idempotent.
	if ok, _, _ := reopened.ClaimResolverOperation(loser, "resolver-"+loser+"-1"); !ok {
		t.Fatal("a repeated claim of the same operation must succeed")
	}
}

// R2-01: a save built on an older read must never erase the close registrations or the resolver claim recorded since.
func TestStaleGroupSaveCannotEraseCloseRegistrationOrResolverClaim(t *testing.T) {
	storage, _ := newGroupStorage(t, "stale.db")
	if err := storage.SaveOptionGroup(testGroup("grp-s1")); err != nil {
		t.Fatal(err)
	}
	stale, err := storage.GetOptionGroup("grp-s1") // a slower writer (for example an advisory waiting on a quote) reads here
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.AddOptionGroupCloseOrder("grp-s1", "close-1"); err != nil {
		t.Fatal(err)
	}
	if ok, _, err := storage.ClaimResolverOperation("grp-s1", "resolver-grp-s1-1"); err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	stale.Advisory = "short leg near expiry"
	err = storage.SaveOptionGroup(stale)
	if !errors.Is(err, ErrStaleOptionGroup) {
		t.Fatalf("a stale save must be refused with ErrStaleOptionGroup, got %v", err)
	}
	fresh, _ := storage.GetOptionGroup("grp-s1")
	if fresh.CloseClientOrderIDs == "" || fresh.ResolverClientID != "resolver-grp-s1-1" || fresh.Advisory != "" {
		t.Fatalf("the stored close registration and claim must be untouched: %+v", fresh)
	}
	// Reloading and saving again works, and keeps everything.
	fresh.Advisory = "short leg near expiry"
	if err := storage.SaveOptionGroup(fresh); err != nil {
		t.Fatal(err)
	}
	after, _ := storage.GetOptionGroup("grp-s1")
	if after.Advisory == "" || after.CloseClientOrderIDs == "" || after.ResolverClientID == "" {
		t.Fatalf("a current save must keep every durable field: %+v", after)
	}
	// A fresh object for an existing group is stale by definition.
	if err := storage.SaveOptionGroup(testGroup("grp-s1")); !errors.Is(err, ErrStaleOptionGroup) {
		t.Fatalf("an object not built from the stored row must be refused, got %v", err)
	}
}

// R2-02: a group whose entry has not reached a terminal, reconciled state is pending, so its legs stay owned.
func TestEntryPendingFollowsTheEntryOrderState(t *testing.T) {
	storage, _ := newGroupStorage(t, "pending.db")
	if err := storage.SaveOptionGroup(testGroup("grp-p1")); err != nil {
		t.Fatal(err)
	}
	pending := func() bool {
		states, err := storage.OptionGroupStates()
		if err != nil || len(states) != 1 {
			t.Fatalf("states=%d err=%v", len(states), err)
		}
		return states[0].EntryPending
	}
	if !pending() {
		t.Fatal("an open group whose entry order is not recorded must be pending")
	}
	saveOrderFilled(t, storage, "grp-p1", "accepted", 3, 0)
	if !pending() {
		t.Fatal("an accepted entry with no recorded fill must be pending")
	}
	saveOrderFilled(t, storage, "grp-p1", "canceled", 3, 0)
	if pending() {
		t.Fatal("a terminal cancel with no fills must release the legs")
	}

	// Terminal orders cannot move back, so the other lifecycle cases use their own groups.
	for id, c := range map[string]struct {
		status string
		filled float64
		want   bool
	}{"grp-p2": {"filled", 0, true}, "grp-p3": {"filled", 3, false}, "grp-p4": {"rejected", 0, false}} {
		g := testGroup(id)
		if err := storage.SaveOptionGroup(g); err != nil {
			t.Fatal(err)
		}
		saveOrderFilled(t, storage, id, c.status, 3, c.filled)
		states, err := storage.OptionGroupStates()
		if err != nil {
			t.Fatal(err)
		}
		for _, st := range states {
			if st.Group.GroupID == id && st.EntryPending != c.want {
				t.Fatalf("%s (%s, filled %v): EntryPending = %v, want %v", id, c.status, c.filled, st.EntryPending, c.want)
			}
		}
	}
}
