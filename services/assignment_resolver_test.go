package services

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// Phase C, Step 4 (D10, A1, A2): the assignment resolver against fakes. Authority and policy are covered separately below.

type liveGroupStore struct {
	groups map[string]*models.DBOptionGroup
	units  map[string]float64
	order  []string
}

func newLiveGroupStore(states ...database.OptionGroupState) *liveGroupStore {
	s := &liveGroupStore{groups: map[string]*models.DBOptionGroup{}, units: map[string]float64{}}
	for _, st := range states {
		copied := *st.Group
		s.groups[copied.GroupID] = &copied
		s.units[copied.GroupID] = st.OpenUnits
		s.order = append(s.order, copied.GroupID)
	}
	return s
}

func (s *liveGroupStore) OptionGroupStates() ([]database.OptionGroupState, error) {
	var out []database.OptionGroupState
	for _, id := range s.order {
		g := s.groups[id]
		if g.Status == "closed" || g.Status == "void" {
			continue
		}
		copied := *g
		out = append(out, database.OptionGroupState{Group: &copied, OpenUnits: s.units[id]})
	}
	return out, nil
}

func (s *liveGroupStore) SaveOptionGroup(group *models.DBOptionGroup) error {
	copied := *group
	s.groups[group.GroupID] = &copied
	return nil
}

type memOrders struct {
	orders map[string]*interfaces.Order
	saves  int
}

func (m *memOrders) GetOrderByClientOrderID(id string) (*interfaces.Order, error) {
	if o, ok := m.orders[id]; ok {
		copied := *o
		return &copied, nil
	}
	return nil, nil
}

func (m *memOrders) SaveOrder(order *interfaces.Order) error {
	if m.orders == nil {
		m.orders = map[string]*interfaces.Order{}
	}
	copied := *order
	copied.ResolverGrant = nil
	m.orders[order.ClientOrderID] = &copied
	m.saves++
	return nil
}

type fakeResolverBroker struct {
	positions  []*interfaces.Position
	open       bool
	bid, ask   float64
	quoteAt    time.Time
	placeErr   error
	placed     []*interfaces.Order
	grants     []*interfaces.AssignmentResolutionGrant
	placeState string
}

func (f *fakeResolverBroker) GetPositions(context.Context) ([]*interfaces.Position, error) {
	return f.positions, nil
}
func (f *fakeResolverBroker) RegularSessionOpen(context.Context) (bool, error) { return f.open, nil }
func (f *fakeResolverBroker) LatestStockQuote(context.Context, string) (float64, float64, time.Time, error) {
	return f.bid, f.ask, f.quoteAt, nil
}
func (f *fakeResolverBroker) IssueAssignmentResolutionGrant(groupID, symbol, side string, qty float64) (*interfaces.AssignmentResolutionGrant, error) {
	g := &interfaces.AssignmentResolutionGrant{Token: fmt.Sprintf("tok-%d", len(f.grants)+1), GroupID: groupID, Symbol: symbol, Side: side, Qty: qty}
	f.grants = append(f.grants, g)
	return g, nil
}
func (f *fakeResolverBroker) PlaceOrder(_ context.Context, order *interfaces.Order) (*interfaces.OrderResult, error) {
	if f.placeErr != nil {
		return nil, f.placeErr
	}
	copied := *order
	f.placed = append(f.placed, &copied)
	state := f.placeState
	if state == "" {
		state = "accepted"
	}
	return &interfaces.OrderResult{OrderID: "broker-" + order.ClientOrderID, Status: state}, nil
}

var resolverNow = time.Date(2026, 11, 23, 15, 0, 0, 0, time.UTC)

func newResolver(store *liveGroupStore, orders *memOrders, broker *fakeResolverBroker) *AssignmentResolver {
	return &AssignmentResolver{Store: store, Orders: orders, Broker: broker, Now: func() time.Time { return resolverNow }}
}

func openBroker(positions ...*interfaces.Position) *fakeResolverBroker {
	return &fakeResolverBroker{positions: positions, open: true, bid: 200, ask: 200.2, quoteAt: resolverNow.Add(-5 * time.Second)}
}

func TestResolverSellsAssignedLongStockWithABoundedLimit(t *testing.T) {
	store := newLiveGroupStore(putSpreadState(2))
	orders, broker := &memOrders{}, openBroker(optPos(putHigh, 2), stockPos(200)) // short put assigned: +200 shares
	report, err := newResolver(store, orders, broker).ResolveOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(broker.placed) != 1 || report.Actions[0].Outcome != "submitted" {
		t.Fatalf("one order must be submitted, got %d actions=%+v", len(broker.placed), report.Actions)
	}
	o := broker.placed[0]
	if o.Side != "sell" || o.Qty != 200 || o.Symbol != "AAPL" || o.Purpose != "close" || o.Type != "limit" || o.TimeInForce != "day" || o.ResolverGrant == nil {
		t.Fatalf("order = %+v", o)
	}
	if o.LimitPrice == nil || *o.LimitPrice != 199 { // 200 x (1 - 0.5%) = 199.00
		t.Fatalf("a sell is a marketable limit 0.5%% under the bid, got %v", o.LimitPrice)
	}
	if o.ClientOrderID != "resolver-gp-1" || store.groups["gp"].ResolverClientID != "resolver-gp-1" {
		t.Fatalf("the stable client id must be saved on the group: %q / %q", o.ClientOrderID, store.groups["gp"].ResolverClientID)
	}
	if broker.grants[0].Side != "sell" || broker.grants[0].Qty != 200 || broker.grants[0].GroupID != "gp" {
		t.Fatalf("grant = %+v", broker.grants[0])
	}
	// The surviving long put was detached into single-leg management; the group is broken.
	if g := store.groups["gp"]; g.Status != "broken" || !strings.Contains(g.DetachedLegsJSON, putHigh) {
		t.Fatalf("group = %+v", g)
	}
}

func TestResolverCoversAssignedShortStockWithABuyLimit(t *testing.T) {
	store := newLiveGroupStore(callSpreadState(2))
	orders, broker := &memOrders{}, openBroker(optPos(callLow, 2), stockPos(-200)) // short call assigned: -200 shares
	if _, err := newResolver(store, orders, broker).ResolveOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	o := broker.placed[0]
	if o.Side != "buy" || o.Qty != 200 || o.LimitPrice == nil || *o.LimitPrice != 201.21 { // 200.20 x 1.005 = 201.201, rounded up to the cent
		t.Fatalf("a cover is a marketable limit 0.5%% over the ask, rounded up: %+v limit=%v", o, o.LimitPrice)
	}
}

func TestResolverLeavesMismatchedOrUnlinkedStockAlone(t *testing.T) {
	// A share count that does not match the missing leg: no order, reported.
	store := newLiveGroupStore(callSpreadState(2))
	broker := openBroker(optPos(callLow, 2), stockPos(-150))
	report, err := newResolver(store, &memOrders{}, broker).ResolveOnce(context.Background())
	if err != nil || len(broker.placed) != 0 || len(report.Actions) != 1 || report.Actions[0].Outcome != "unresolved" {
		t.Fatalf("mismatched stock must be left alone and reported: placed=%d report=%+v err=%v", len(broker.placed), report, err)
	}
	// Stock that no group explains (the group is intact): nothing to do and no broker order.
	store = newLiveGroupStore(callSpreadState(2))
	broker = openBroker(optPos(callLow, 2), optPos(callHigh, -2), stockPos(-200))
	report, err = newResolver(store, &memOrders{}, broker).ResolveOnce(context.Background())
	if err != nil || len(broker.placed) != 0 || len(report.Actions) != 0 {
		t.Fatalf("unlinked stock with an intact group must be ignored: placed=%d actions=%+v", len(broker.placed), report.Actions)
	}
	// No groups at all: no broker call.
	broker = openBroker(stockPos(-200))
	if _, err := newResolver(newLiveGroupStore(), &memOrders{}, broker).ResolveOnce(context.Background()); err != nil || len(broker.placed) != 0 {
		t.Fatalf("no groups means no action: %v", err)
	}
}

func TestResolverWaitsForRegularHoursAndAFreshQuote(t *testing.T) {
	store := newLiveGroupStore(callSpreadState(2))
	broker := openBroker(optPos(callLow, 2), stockPos(-200))
	broker.open = false
	orders := &memOrders{}
	report, _ := newResolver(store, orders, broker).ResolveOnce(context.Background())
	if len(broker.placed) != 0 || report.Actions[0].Outcome != "waiting" || orders.saves != 0 || store.groups["gc"].ResolverClientID != "" {
		t.Fatalf("a closed market must wait and create no operation: %+v saves=%d id=%q", report.Actions, orders.saves, store.groups["gc"].ResolverClientID)
	}
	broker.open = true
	broker.quoteAt = resolverNow.Add(-10 * time.Minute)
	report, _ = newResolver(store, orders, broker).ResolveOnce(context.Background())
	if len(broker.placed) != 0 || report.Actions[0].Outcome != "waiting" || !strings.Contains(report.Actions[0].Detail, "stale") {
		t.Fatalf("a stale quote must wait: %+v", report.Actions)
	}
	broker.quoteAt = time.Time{}
	if report, _ = newResolver(store, orders, broker).ResolveOnce(context.Background()); len(broker.placed) != 0 {
		t.Fatalf("an undated quote must wait: %+v", report.Actions)
	}
}

func TestResolverFollowsItsExistingOrderAndNeverRepeatsIt(t *testing.T) {
	store := newLiveGroupStore(callSpreadState(2))
	orders, broker := &memOrders{}, openBroker(optPos(callLow, 2), stockPos(-200))
	r := newResolver(store, orders, broker)
	if _, err := r.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 1 {
		t.Fatalf("first pass must submit once: %v placed=%d", err, len(broker.placed))
	}
	// A second beat and a concurrent pass see the working order: no second order.
	for i := 0; i < 3; i++ {
		report, err := r.ResolveOnce(context.Background())
		if err != nil || len(broker.placed) != 1 || report.Actions[0].Outcome != "waiting" {
			t.Fatalf("pass %d must follow the working order: placed=%d report=%+v err=%v", i, len(broker.placed), report, err)
		}
	}
	// A restart mid-resolution: a new resolver over the same durable state follows the same order.
	restarted := newResolver(store, orders, broker)
	if _, err := restarted.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 1 {
		t.Fatalf("a restarted resolver must not create another order: placed=%d err=%v", len(broker.placed), err)
	}
	// A partly filled order is still the same operation (the remainder is recalculated only after it is terminal).
	orders.orders["resolver-gc-1"].Status = "partially_filled"
	if _, err := restarted.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 1 {
		t.Fatalf("a partially filled order must keep being followed: placed=%d err=%v", len(broker.placed), err)
	}
}

func TestResolverNeverReplacesAnUncertainOrder(t *testing.T) {
	store := newLiveGroupStore(callSpreadState(2))
	orders, broker := &memOrders{}, openBroker(optPos(callLow, 2), stockPos(-200))
	broker.placeErr = &SubmissionUncertainError{Err: fmt.Errorf("timeout")}
	r := newResolver(store, orders, broker)
	report, err := r.ResolveOnce(context.Background())
	if err != nil || report.Actions[0].Outcome != "waiting" || orders.orders["resolver-gc-1"].Status != "submission_uncertain" || !orders.orders["resolver-gc-1"].SubmissionAttempted {
		t.Fatalf("an uncertain submission must be recorded as uncertain: %+v order=%+v err=%v", report.Actions, orders.orders["resolver-gc-1"], err)
	}
	broker.placeErr = nil
	for i := 0; i < 2; i++ {
		report, err = r.ResolveOnce(context.Background())
		if err != nil || len(broker.placed) != 0 || report.Actions[0].Outcome != "waiting" {
			t.Fatalf("an uncertain order must never get a new id: placed=%d report=%+v err=%v", len(broker.placed), report, err)
		}
	}
	if store.groups["gc"].ResolverClientID != "resolver-gc-1" {
		t.Fatalf("the client id must not change, got %q", store.groups["gc"].ResolverClientID)
	}
}

func TestResolverCreatesANewAttemptOnlyAfterATerminalOrderAndTheRetryWait(t *testing.T) {
	// Real scenario: first attempt expires unfilled; a later pass makes attempt 2 for the stock that remains.
	store := newLiveGroupStore(callSpreadState(2))
	orders, broker := &memOrders{}, openBroker(optPos(callLow, 2), stockPos(-200))
	r := newResolver(store, orders, broker)
	if _, err := r.ResolveOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	orders.orders["resolver-gc-1"].Status = "expired"
	orders.orders["resolver-gc-1"].SubmittedAt = resolverNow.Add(-5 * time.Minute) // inside the retry wait
	report, _ := r.ResolveOnce(context.Background())
	if len(broker.placed) != 1 || report.Actions[0].Outcome != "waiting" {
		t.Fatalf("a terminal attempt inside the retry wait must wait: placed=%d %+v", len(broker.placed), report.Actions)
	}
	orders.orders["resolver-gc-1"].SubmittedAt = resolverNow.Add(-20 * time.Minute)
	if _, err := r.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 2 {
		t.Fatalf("after the wait a new attempt must be made: placed=%d err=%v", len(broker.placed), err)
	}
	if broker.placed[1].ClientOrderID != "resolver-gc-2" || store.groups["gc"].ResolverClientID != "resolver-gc-2" {
		t.Fatalf("the new attempt has its own id, saved first: %q / %q", broker.placed[1].ClientOrderID, store.groups["gc"].ResolverClientID)
	}
	// The remainder is recalculated from the broker position: stock now -120 does not match the missing legs, so nothing more is placed.
	orders.orders["resolver-gc-2"].Status = "canceled"
	orders.orders["resolver-gc-2"].SubmittedAt = resolverNow.Add(-20 * time.Minute)
	broker.positions = []*interfaces.Position{optPos(callLow, 2), stockPos(-120)}
	report, _ = r.ResolveOnce(context.Background())
	if len(broker.placed) != 2 || report.Actions[0].Outcome != "unresolved" {
		t.Fatalf("a remainder that no longer matches must be left alone: placed=%d %+v", len(broker.placed), report.Actions)
	}
}

func TestResolverOneOwnerPerSymbolAndRefusalsAreRecorded(t *testing.T) {
	// Two broken groups on the same underlying: only one operation is in flight.
	a, b := callSpreadState(1), callSpreadState(1)
	a.Group.GroupID, b.Group.GroupID = "ga", "gb"
	store := newLiveGroupStore(a, b)
	broker := openBroker(optPos(callLow, 2), stockPos(-200))
	orders := &memOrders{}
	r := newResolver(store, orders, broker)
	// Both groups' legs are the same symbols, so both break; only one resolver order may be created per pass and none while one is in flight.
	if _, err := r.ResolveOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(broker.placed) > 1 {
		t.Fatalf("one owner per symbol: %d orders placed", len(broker.placed))
	}
	// A pre-submission refusal (for example an operator confirmation stop) is recorded as refused and not hammered.
	store = newLiveGroupStore(callSpreadState(2))
	broker = openBroker(optPos(callLow, 2), stockPos(-200))
	broker.placeErr = &PreSubmissionRejectionError{Err: fmt.Errorf("operator confirmation is required")}
	orders = &memOrders{}
	r = newResolver(store, orders, broker)
	report, _ := r.ResolveOnce(context.Background())
	if report.Actions[0].Outcome != "refused" || orders.orders["resolver-gc-1"].Status != "rejected_before_submission" {
		t.Fatalf("a refusal must be recorded: %+v order=%+v", report.Actions, orders.orders["resolver-gc-1"])
	}
	broker.placeErr = nil
	if report, _ = r.ResolveOnce(context.Background()); len(broker.placed) != 0 || report.Actions[0].Outcome != "waiting" {
		t.Fatalf("a recent refusal must not be hammered: placed=%d %+v", len(broker.placed), report.Actions)
	}
}

func TestRollbackClearanceListsEveryBlocker(t *testing.T) {
	open := callSpreadState(2)
	open.Group.GroupID = "g-open"
	broken := callSpreadState(1)
	broken.Group.GroupID, broken.Group.Status, broken.Group.ResolverClientID = "g-broken", "broken", "resolver-g-broken-1"
	pending := callSpreadState(0)
	pending.Group.GroupID, pending.Group.Status = "g-pending", "pending_entry"
	closing := callSpreadState(2)
	closing.Group.GroupID, closing.PendingClose = "g-closing", true
	working := &interfaces.Order{ClientOrderID: "mleg-1", Status: "new", OptionLegs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "sell", "sell_to_open")}}
	planned := &interfaces.Order{ClientOrderID: "mleg-2", Status: "planned_for_next_session", OptionLegs: working.OptionLegs}
	resolver := &interfaces.Order{ClientOrderID: "resolver-g-broken-1", Status: "accepted"}
	blockers := RollbackClearance([]database.OptionGroupState{open, broken, pending, closing}, []*interfaces.Order{working, planned, resolver}, nil)
	joined := strings.Join(blockers, " | ")
	for _, want := range []string{"g-open", "g-broken", "g-pending", "g-closing", "mleg-1", "mleg-2", "resolver order resolver-g-broken-1"} {
		if !strings.Contains(joined, want) {
			t.Errorf("a blocker for %q is missing: %s", want, joined)
		}
	}
	// Fully terminal, flat and reconciled: nothing blocks. Closed historical groups do not appear at all.
	done := &interfaces.Order{ClientOrderID: "mleg-3", Status: "filled", OptionLegs: working.OptionLegs}
	if got := RollbackClearance(nil, []*interfaces.Order{done}, nil); len(got) != 0 {
		t.Fatalf("a flat, terminal state must clear the rollback: %v", got)
	}
}
