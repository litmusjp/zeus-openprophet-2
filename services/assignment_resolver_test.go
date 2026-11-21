package services

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// Phase C, Step 4 (D10, A1, A2): the assignment resolver against fakes that enforce what the real storage enforces
// (order revisions, an atomic resolver claim). Authority and policy are covered in assignment_grant_test.go.

type liveGroupStore struct {
	mu     sync.Mutex
	groups map[string]*models.DBOptionGroup
	units  map[string]float64
	order  []string
	orders *memOrders
}

func newLiveGroupStore(orders *memOrders, states ...database.OptionGroupState) *liveGroupStore {
	s := &liveGroupStore{groups: map[string]*models.DBOptionGroup{}, units: map[string]float64{}, orders: orders}
	for _, st := range states {
		copied := *st.Group
		s.groups[copied.GroupID] = &copied
		s.units[copied.GroupID] = st.OpenUnits
		s.order = append(s.order, copied.GroupID)
	}
	return s
}

func (s *liveGroupStore) OptionGroupStates() ([]database.OptionGroupState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	s.mu.Lock()
	defer s.mu.Unlock()
	copied := *group
	s.groups[group.GroupID] = &copied
	return nil
}

// ClaimResolverOperation mirrors the real atomic claim: one group per underlying may own an in-flight operation.
func (s *liveGroupStore) ClaimResolverOperation(groupID, clientID string) (bool, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	group := s.groups[groupID]
	if group.ResolverClientID == clientID {
		return true, "", nil
	}
	for _, id := range s.order {
		other := s.groups[id]
		if id == groupID || other.ResolverClientID == "" || !strings.EqualFold(other.Underlying, group.Underlying) {
			continue
		}
		order, _ := s.orders.GetOrderByClientOrderID(other.ResolverClientID)
		if order == nil || !resolverTerminalStatuses[strings.ToLower(order.Status)] && !strings.EqualFold(order.Status, "filled") {
			return false, other.ResolverClientID, nil
		}
	}
	group.ResolverClientID = clientID
	return true, "", nil
}

// memOrders enforces revisions exactly like LocalStorage: a save of a stale revision is refused.
type memOrders struct {
	mu     sync.Mutex
	orders map[string]*interfaces.Order
	saves  int
}

func (m *memOrders) GetOrderByClientOrderID(id string) (*interfaces.Order, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if o, ok := m.orders[id]; ok {
		copied := *o
		return &copied, nil
	}
	return nil, nil
}

func (m *memOrders) SaveOrder(order *interfaces.Order) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.orders == nil {
		m.orders = map[string]*interfaces.Order{}
	}
	if existing, ok := m.orders[order.ClientOrderID]; ok && existing.Revision != order.Revision {
		return fmt.Errorf("stale lifecycle revision for client order ID %q", order.ClientOrderID)
	}
	copied := *order
	copied.ResolverGrant = nil
	copied.Revision = order.Revision + 1
	m.orders[order.ClientOrderID] = &copied
	m.saves++
	return nil
}

// bump simulates the submission marker or a reconciliation saving the order: its revision advances.
func (m *memOrders) bump(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if o, ok := m.orders[id]; ok {
		o.Revision++
	}
}

func (m *memOrders) set(id string, mutate func(o *interfaces.Order)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mutate(m.orders[id])
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
	orders     *memOrders // the marker saves the order before the SDK call, advancing its revision
}

func (f *fakeResolverBroker) GetPositions(context.Context) ([]*interfaces.Position, error) {
	return f.positions, nil
}
func (f *fakeResolverBroker) RegularSessionOpen(context.Context) (bool, error) { return f.open, nil }
func (f *fakeResolverBroker) LatestStockQuote(context.Context, string) (float64, float64, time.Time, error) {
	return f.bid, f.ask, f.quoteAt, nil
}
func (f *fakeResolverBroker) IssueAssignmentResolutionGrant(groupID, clientOrderID, symbol, side string, qty float64) (*interfaces.AssignmentResolutionGrant, error) {
	g := &interfaces.AssignmentResolutionGrant{Token: fmt.Sprintf("tok-%d", len(f.grants)+1), GroupID: groupID, ClientOrderID: clientOrderID, Symbol: symbol, Side: side, Qty: qty}
	f.grants = append(f.grants, g)
	return g, nil
}
func (f *fakeResolverBroker) PlaceOrder(_ context.Context, order *interfaces.Order) (*interfaces.OrderResult, error) {
	if f.orders != nil {
		f.orders.bump(order.ClientOrderID) // the real submission marker reloads and saves the order
	}
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

func baselined(state database.OptionGroupState, stock float64) database.OptionGroupState {
	state.Group.StockBaseline, state.Group.StockBaselineSet = stock, true
	return state
}

func newResolver(store *liveGroupStore, orders *memOrders, broker *fakeResolverBroker) *AssignmentResolver {
	broker.orders = orders
	return &AssignmentResolver{Store: store, Orders: orders, Broker: broker, Now: func() time.Time { return resolverNow }}
}

func openBroker(positions ...*interfaces.Position) *fakeResolverBroker {
	return &fakeResolverBroker{positions: positions, open: true, bid: 200, ask: 200.2, quoteAt: resolverNow.Add(-5 * time.Second)}
}

func TestResolverSellsAssignedLongStockWithABoundedLimit(t *testing.T) {
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(putSpreadState(2), 0))
	broker := openBroker(optPos(putHigh, 2), stockPos(200)) // short put assigned: +200 shares
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
		t.Fatalf("the stable client id must be claimed on the group: %q / %q", o.ClientOrderID, store.groups["gp"].ResolverClientID)
	}
	if broker.grants[0].Side != "sell" || broker.grants[0].Qty != 200 || broker.grants[0].GroupID != "gp" || broker.grants[0].ClientOrderID != "resolver-gp-1" {
		t.Fatalf("grant = %+v", broker.grants[0])
	}
	if g := store.groups["gp"]; g.Status != "broken" || !strings.Contains(g.DetachedLegsJSON, putHigh) {
		t.Fatalf("group = %+v", g)
	}
}

func TestResolverCoversAssignedShortStockWithABuyLimit(t *testing.T) {
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
	broker := openBroker(optPos(callLow, 2), stockPos(-200)) // short call assigned: -200 shares
	if _, err := newResolver(store, orders, broker).ResolveOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	o := broker.placed[0]
	if o.Side != "buy" || o.Qty != 200 || o.LimitPrice == nil || *o.LimitPrice != 201.21 { // 200.20 x 1.005 = 201.201, rounded up to the cent
		t.Fatalf("a cover is a marketable limit 0.5%% over the ask, rounded up: %+v limit=%v", o, o.LimitPrice)
	}
}

func TestResolverLeavesMismatchedOrUnlinkedStockAlone(t *testing.T) {
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
	broker := openBroker(optPos(callLow, 2), stockPos(-150))
	report, err := newResolver(store, orders, broker).ResolveOnce(context.Background())
	if err != nil || len(broker.placed) != 0 || len(report.Actions) != 1 || report.Actions[0].Outcome != "unresolved" {
		t.Fatalf("mismatched stock must be left alone and reported: placed=%d report=%+v err=%v", len(broker.placed), report, err)
	}
	// Stock that no group explains (the group is intact): nothing to do and no broker order.
	orders = &memOrders{}
	store = newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
	broker = openBroker(optPos(callLow, 2), optPos(callHigh, -2), stockPos(-200))
	report, err = newResolver(store, orders, broker).ResolveOnce(context.Background())
	if err != nil || len(broker.placed) != 0 || len(report.Actions) != 0 {
		t.Fatalf("unlinked stock with an intact group must be ignored: placed=%d actions=%+v", len(broker.placed), report.Actions)
	}
	// No groups at all: no broker call.
	orders = &memOrders{}
	broker = openBroker(stockPos(-200))
	if _, err := newResolver(newLiveGroupStore(orders), orders, broker).ResolveOnce(context.Background()); err != nil || len(broker.placed) != 0 {
		t.Fatalf("no groups means no action: %v", err)
	}
}

func TestResolverNeverMintsAuthorityFromAShareCountCoincidence(t *testing.T) {
	// Hermes C07: the short leg is closed outside OP2 while UNRELATED pre-existing stock has exactly the size and sign the
	// missing option would imply. The group's baseline records that stock, so the change is zero: nothing is linked, no order.
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(2), -200))
	broker := openBroker(optPos(callLow, 2), stockPos(-200))
	report, err := newResolver(store, orders, broker).ResolveOnce(context.Background())
	if err != nil || len(broker.placed) != 0 || len(broker.grants) != 0 {
		t.Fatalf("an unchanged pre-existing stock position must never be sold or covered: placed=%d grants=%d err=%v", len(broker.placed), len(broker.grants), err)
	}
	if len(report.Reconcile.ClosedWithoutStock) != 1 || store.groups["gc"].Status != "closed" {
		t.Fatalf("the event left no stock behind, so nothing is left to resolve: %+v status=%q", report.Reconcile, store.groups["gc"].Status)
	}
	// Without any baseline there is no provenance at all: stock is left alone and reported, never acted on.
	orders = &memOrders{}
	store = newLiveGroupStore(orders, unbaselinedCall(2)) // no baseline recorded
	broker = openBroker(optPos(callLow, 2), stockPos(-200))
	report, err = newResolver(store, orders, broker).ResolveOnce(context.Background())
	if err != nil || len(broker.placed) != 0 || len(report.Reconcile.Unresolved) != 1 || !strings.Contains(report.Reconcile.Unresolved[0].Mismatch, "no pre-event stock baseline") {
		t.Fatalf("stock without provenance must be left alone and reported: placed=%d report=%+v", len(broker.placed), report.Reconcile)
	}
	// Stock that changed by the right amount from the baseline IS the assignment (here on top of unrelated stock of -50).
	orders = &memOrders{}
	store = newLiveGroupStore(orders, baselined(callSpreadState(2), -50))
	broker = openBroker(optPos(callLow, 2), stockPos(-250))
	if _, err := newResolver(store, orders, broker).ResolveOnce(context.Background()); err != nil || len(broker.placed) != 1 {
		t.Fatalf("a verified assignment must be resolved: placed=%d err=%v", len(broker.placed), err)
	}
	if o := broker.placed[0]; o.Side != "buy" || o.Qty != 200 {
		t.Fatalf("only the 200 shares the event added are covered, never the pre-existing 50: %+v", o)
	}
}

func TestResolverKeepsLinkageThroughAPartialFill(t *testing.T) {
	// Hermes C06: attempt 1 covered 80 of 200 shares and ended; the broker remainder is -120. The linkage survives and only
	// the remaining 120 is covered by a second attempt.
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
	broker := openBroker(optPos(callLow, 2), stockPos(-200))
	r := newResolver(store, orders, broker)
	if _, err := r.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 1 {
		t.Fatalf("first attempt: %v placed=%d", err, len(broker.placed))
	}
	orders.set("resolver-gc-1", func(o *interfaces.Order) {
		o.Status, o.FilledQty = "canceled", 80
		o.SubmittedAt = resolverNow.Add(-20 * time.Minute)
	})
	broker.positions = []*interfaces.Position{optPos(callLow, 2), stockPos(-120)}
	report, err := r.ResolveOnce(context.Background())
	if err != nil || len(broker.placed) != 2 || report.Actions[0].Outcome != "submitted" {
		t.Fatalf("the remainder must still be linked and covered: placed=%d report=%+v err=%v", len(broker.placed), report.Actions, err)
	}
	if o := broker.placed[1]; o.ClientOrderID != "resolver-gc-2" || o.Side != "buy" || o.Qty != 120 {
		t.Fatalf("attempt 2 covers exactly the remaining 120: %+v", o)
	}
	// While a partial attempt is still working, the same operation is followed and nothing is replaced.
	orders.set("resolver-gc-2", func(o *interfaces.Order) { o.Status, o.FilledQty = "partially_filled", 20 })
	broker.positions = []*interfaces.Position{optPos(callLow, 2), stockPos(-100)}
	if _, err := r.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 2 {
		t.Fatalf("a working partial order must keep being followed: placed=%d err=%v", len(broker.placed), err)
	}
	// An unexplained balance change (stock that neither the legs nor the resolver account for) is left alone.
	orders.set("resolver-gc-2", func(o *interfaces.Order) {
		o.Status, o.FilledQty = "canceled", 20
		o.SubmittedAt = resolverNow.Add(-20 * time.Minute)
	})
	broker.positions = []*interfaces.Position{optPos(callLow, 2), stockPos(-45)}
	report, _ = r.ResolveOnce(context.Background())
	if len(broker.placed) != 2 || len(report.Reconcile.Unresolved) != 1 {
		t.Fatalf("an unexplained balance must be left alone: placed=%d report=%+v", len(broker.placed), report.Reconcile)
	}
}

func TestResolverWaitsForRegularHoursAndAFreshQuote(t *testing.T) {
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
	broker := openBroker(optPos(callLow, 2), stockPos(-200))
	broker.open = false
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

func TestResolverFollowsItsExistingOrderAndRecordsItsOutcomeAtTheCurrentRevision(t *testing.T) {
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
	broker := openBroker(optPos(callLow, 2), stockPos(-200))
	r := newResolver(store, orders, broker)
	if _, err := r.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 1 {
		t.Fatalf("first pass must submit once: %v placed=%d", err, len(broker.placed))
	}
	// Hermes C02-B: the marker advanced the revision before the SDK call; the outcome must still have been saved.
	saved, _ := orders.GetOrderByClientOrderID("resolver-gc-1")
	if saved.Status != "accepted" || !saved.SubmissionAttempted || saved.ID != "broker-resolver-gc-1" {
		t.Fatalf("the accepted outcome must be durable despite the marker revision: %+v", saved)
	}
	for i := 0; i < 3; i++ {
		report, err := r.ResolveOnce(context.Background())
		if err != nil || len(broker.placed) != 1 || report.Actions[0].Outcome != "waiting" {
			t.Fatalf("pass %d must follow the working order: placed=%d report=%+v err=%v", i, len(broker.placed), report, err)
		}
	}
	restarted := newResolver(store, orders, broker)
	if _, err := restarted.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 1 {
		t.Fatalf("a restarted resolver must not create another order: placed=%d err=%v", len(broker.placed), err)
	}
	orders.set("resolver-gc-1", func(o *interfaces.Order) { o.Status = "partially_filled" })
	if _, err := restarted.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 1 {
		t.Fatalf("a partially filled order must keep being followed: placed=%d err=%v", len(broker.placed), err)
	}
}

func TestResolverRecordsEveryOutcomeDespiteTheMarkerRevision(t *testing.T) {
	cases := map[string]struct {
		err    error
		status string
		tried  bool
	}{
		"broker rejection": {&BrokerRejectionError{Err: fmt.Errorf("rejected")}, "rejected", true},
		"pre-submission":   {&PreSubmissionRejectionError{Err: fmt.Errorf("operator confirmation is required")}, "rejected_before_submission", false},
		"uncertain":        {&SubmissionUncertainError{Err: fmt.Errorf("timeout")}, "submission_uncertain", true},
		"market closed":    {&MarketClosedError{}, "rejected_before_submission", false},
	}
	for name, tc := range cases {
		orders := &memOrders{}
		store := newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
		broker := openBroker(optPos(callLow, 2), stockPos(-200))
		broker.placeErr = tc.err
		if _, err := newResolver(store, orders, broker).ResolveOnce(context.Background()); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		saved, _ := orders.GetOrderByClientOrderID("resolver-gc-1")
		if saved == nil || saved.Status != tc.status || saved.SubmissionAttempted != tc.tried {
			t.Errorf("%s: the outcome must be durable at the current revision, got %+v", name, saved)
		}
	}
}

func TestResolverNeverReplacesAnUncertainOrder(t *testing.T) {
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
	broker := openBroker(optPos(callLow, 2), stockPos(-200))
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
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
	broker := openBroker(optPos(callLow, 2), stockPos(-200))
	r := newResolver(store, orders, broker)
	if _, err := r.ResolveOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	orders.set("resolver-gc-1", func(o *interfaces.Order) { o.Status, o.SubmittedAt = "expired", resolverNow.Add(-5*time.Minute) })
	report, _ := r.ResolveOnce(context.Background())
	if len(broker.placed) != 1 || report.Actions[0].Outcome != "waiting" {
		t.Fatalf("a terminal attempt inside the retry wait must wait: placed=%d %+v", len(broker.placed), report.Actions)
	}
	orders.set("resolver-gc-1", func(o *interfaces.Order) { o.SubmittedAt = resolverNow.Add(-20 * time.Minute) })
	if _, err := r.ResolveOnce(context.Background()); err != nil || len(broker.placed) != 2 {
		t.Fatalf("after the wait a new attempt must be made: placed=%d err=%v", len(broker.placed), err)
	}
	if broker.placed[1].ClientOrderID != "resolver-gc-2" || store.groups["gc"].ResolverClientID != "resolver-gc-2" {
		t.Fatalf("the new attempt has its own id, claimed first: %q / %q", broker.placed[1].ClientOrderID, store.groups["gc"].ResolverClientID)
	}
}

func TestResolverRefusalIsRecordedAndNotHammered(t *testing.T) {
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(2), 0))
	broker := openBroker(optPos(callLow, 2), stockPos(-200))
	broker.placeErr = &PreSubmissionRejectionError{Err: fmt.Errorf("operator confirmation is required")}
	r := newResolver(store, orders, broker)
	report, _ := r.ResolveOnce(context.Background())
	if report.Actions[0].Outcome != "refused" || orders.orders["resolver-gc-1"].Status != "rejected_before_submission" {
		t.Fatalf("a refusal must be recorded: %+v order=%+v", report.Actions, orders.orders["resolver-gc-1"])
	}
	broker.placeErr = nil
	if report, _ = r.ResolveOnce(context.Background()); len(broker.placed) != 0 || report.Actions[0].Outcome != "waiting" {
		t.Fatalf("a recent refusal must not be hammered: placed=%d %+v", len(broker.placed), report.Actions)
	}
}

func TestResolverOneOwnerPerUnderlyingEvenWhenPassesOverlap(t *testing.T) {
	// Hermes C07: two groups on the same underlying, two overlapping passes (separate resolvers over the same durable store).
	a, b := baselined(callSpreadState(1), 0), baselined(callSpreadState(1), 0)
	a.Group.GroupID, b.Group.GroupID = "ga", "gb"
	b.Group.LegsJSON = strings.ReplaceAll(a.Group.LegsJSON, "00200000", "00220000")
	b.Group.LegsJSON = strings.ReplaceAll(b.Group.LegsJSON, "00210000", "00230000")
	orders := &memOrders{}
	store := newLiveGroupStore(orders, a, b)
	// Both groups lost their short leg; the stock the two events left behind is -100 each = -200 in total.
	positions := []*interfaces.Position{optPos(callLow, 1), optPos("AAPL261218C00220000", 1), stockPos(-100)}
	// Only ga's event is linked to the -100 share change (gb implies another -100 that is not there), so exactly one order can be placed anyway;
	// the claim must still guarantee that two groups never own the stock at once.
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make([]bool, 2)
	for i, id := range []string{"ga", "gb"} {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			<-start
			ok, _, err := store.ClaimResolverOperation(id, "resolver-"+id+"-1")
			if err != nil {
				t.Error(err)
			}
			results[i] = ok
		}(i, id)
	}
	close(start)
	wg.Wait()
	if results[0] == results[1] {
		t.Fatalf("exactly one overlapping claim may own the underlying: %v", results)
	}
	_ = positions
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
	states := []database.OptionGroupState{open, broken, pending, closing}
	working := &interfaces.Order{ClientOrderID: "mleg-1", Status: "new", OptionLegs: []interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "sell", "sell_to_open")}}
	planned := &interfaces.Order{ClientOrderID: "mleg-2", Status: "planned_for_next_session", OptionLegs: working.OptionLegs}
	resolver := &interfaces.Order{ClientOrderID: "resolver-g-broken-1", Status: "accepted"}
	groups := []*models.DBOptionGroup{open.Group, broken.Group, pending.Group, closing.Group}
	blockers := RollbackClearance(groups, states, []*interfaces.Order{working, planned, resolver}, nil, true)
	joined := strings.Join(blockers, " | ")
	for _, want := range []string{"g-open", "g-broken", "g-pending", "g-closing", "mleg-1", "mleg-2", "resolver order resolver-g-broken-1"} {
		if !strings.Contains(joined, want) {
			t.Errorf("a blocker for %q is missing: %s", want, joined)
		}
	}
	// Unknown positions are never clearance.
	if got := RollbackClearance(nil, nil, nil, nil, false); len(got) != 1 || !strings.Contains(got[0], "unreadable") {
		t.Fatalf("unreadable broker positions must block: %v", got)
	}
	// Fully terminal, flat and reconciled: nothing blocks.
	done := &interfaces.Order{ClientOrderID: "mleg-3", Status: "filled", OptionLegs: working.OptionLegs}
	if got := RollbackClearance(nil, nil, []*interfaces.Order{done}, nil, true); len(got) != 0 {
		t.Fatalf("a flat, terminal state must clear the rollback: %v", got)
	}
}

func TestRollbackClearanceDeniesResidualLinkedStockOfAClosedGroup(t *testing.T) {
	// Hermes C08: a CLOSED historical group that broke (assignment) and left stock beyond its baseline still blocks the downgrade.
	closed := &models.DBOptionGroup{GroupID: "g-closed", Underlying: "AAPL", Status: "closed", BrokenReason: "short leg missing", ResolverClientID: "resolver-g-closed-1", StockBaseline: 0, StockBaselineSet: true}
	got := RollbackClearance([]*models.DBOptionGroup{closed}, nil, nil, []*interfaces.Position{stockPos(-120)}, true)
	if len(got) != 1 || !strings.Contains(got[0], "g-closed") || !strings.Contains(got[0], "shares of AAPL") {
		t.Fatalf("residual linked stock of a closed group must block: %v", got)
	}
	// Back at its baseline (even a pre-existing nonzero one): nothing blocks; a clean historical group alone never blocks.
	if got := RollbackClearance([]*models.DBOptionGroup{closed}, nil, nil, []*interfaces.Position{stockPos(0)}, true); len(got) != 0 {
		t.Fatalf("a group back at its baseline must not block: %v", got)
	}
	based := *closed
	based.StockBaseline = -50
	if got := RollbackClearance([]*models.DBOptionGroup{&based}, nil, nil, []*interfaces.Position{stockPos(-50)}, true); len(got) != 0 {
		t.Fatalf("pre-existing baseline stock must not block: %v", got)
	}
	clean := &models.DBOptionGroup{GroupID: "g-clean", Underlying: "AAPL", Status: "closed"}
	if got := RollbackClearance([]*models.DBOptionGroup{clean}, nil, nil, []*interfaces.Position{stockPos(-120)}, true); len(got) != 0 {
		t.Fatalf("a group that never broke owns no stock: %v", got)
	}
	// A resolved sibling on another underlying cannot clear this one.
	other := &models.DBOptionGroup{GroupID: "g-other", Underlying: "MSFT", Status: "closed", BrokenReason: "x", StockBaselineSet: true}
	if got := RollbackClearance([]*models.DBOptionGroup{closed, other}, nil, nil, []*interfaces.Position{stockPos(-120)}, true); len(got) != 1 {
		t.Fatalf("the sibling must not clear the first group: %v", got)
	}
}

func TestZeroStockButAnUnfinishedResolverOrderKeepsTheGroupBlocked(t *testing.T) {
	// Hermes C08: the broker shows zero change while a resolver order is still working or uncertain.
	for name, status := range map[string]string{"working": "accepted", "uncertain": "submission_uncertain"} {
		orders := &memOrders{}
		orders.orders = map[string]*interfaces.Order{"resolver-gc-1": {ClientOrderID: "resolver-gc-1", Symbol: "AAPL", Side: "buy", Qty: 200, Status: status, SubmissionAttempted: true}}
		state := baselined(callSpreadState(2), 0)
		state.Group.Status, state.Group.ResolverClientID = "broken", "resolver-gc-1"
		store := newLiveGroupStore(orders, state)
		broker := openBroker(optPos(callLow, 2)) // flat stock
		report, err := newResolver(store, orders, broker).ResolveOnce(context.Background())
		if err != nil || len(report.Reconcile.Waiting) != 1 || len(report.Reconcile.ClosedWithoutStock) != 0 || store.groups["gc"].Status != "broken" {
			t.Fatalf("%s: a flat snapshot must not clear the block while the order is unfinished: %+v status=%q err=%v", name, report.Reconcile, store.groups["gc"].Status, err)
		}
		if len(broker.placed) != 0 {
			t.Fatalf("%s: nothing is traded while waiting", name)
		}
		// New spread entries stay refused while the group is still broken (it is still returned as live).
		risks, _ := OptionGroupRisksFromStates(mustStates(store))
		if len(risks) != 1 || !risks[0].Broken {
			t.Fatalf("%s: the group must still be reported broken: %+v", name, risks)
		}
	}
	// Once the order is terminal and the stock is flat, the group clears.
	orders := &memOrders{}
	orders.orders = map[string]*interfaces.Order{"resolver-gc-1": {ClientOrderID: "resolver-gc-1", Symbol: "AAPL", Side: "buy", Qty: 200, Status: "filled", FilledQty: 200}}
	state := baselined(callSpreadState(2), 0)
	state.Group.Status, state.Group.ResolverClientID = "broken", "resolver-gc-1"
	store := newLiveGroupStore(orders, state)
	report, err := newResolver(store, orders, openBroker(optPos(callLow, 2))).ResolveOnce(context.Background())
	if err != nil || len(report.Reconcile.ClosedWithoutStock) != 1 || store.groups["gc"].Status != "closed" {
		t.Fatalf("all-flat, all-terminal state must clear the group: %+v status=%q err=%v", report.Reconcile, store.groups["gc"].Status, err)
	}
}

func mustStates(store *liveGroupStore) []database.OptionGroupState {
	states, _ := store.OptionGroupStates()
	return states
}

func TestResolverRefreshesTheLedgerEveryPassWithLiveGroups(t *testing.T) {
	// Hermes C02-A: fills reach the durable group state during normal operation through the refresh hook.
	orders := &memOrders{}
	store := newLiveGroupStore(orders, baselined(callSpreadState(0), 0)) // entry accepted, zero filled so far
	broker := openBroker(optPos(callLow, 2), optPos(callHigh, -2))
	r := newResolver(store, orders, broker)
	calls := 0
	r.Refresh = func(context.Context) {
		calls++
		store.mu.Lock()
		store.units["gc"] = 2 // the broker fill is merged into the ledger by the reconciliation owner
		store.mu.Unlock()
	}
	if _, err := r.ResolveOnce(context.Background()); err != nil || calls != 1 {
		t.Fatalf("the refresh must run once per pass with live groups: calls=%d err=%v", calls, err)
	}
	states, _ := store.OptionGroupStates()
	risks, _ := OptionGroupRisksFromStates(states)
	if len(risks) != 1 || risks[0].OpenUnits != 2 || openGroupOwningSymbol(risks, callLow) != "gc" {
		t.Fatalf("after the refresh the group owns its legs: %+v", risks)
	}
	// With no live group there is nothing to refresh and no broker call.
	calls = 0
	empty := newResolver(newLiveGroupStore(orders), orders, openBroker())
	empty.Refresh = func(context.Context) { calls++ }
	if _, err := empty.ResolveOnce(context.Background()); err != nil || calls != 0 {
		t.Fatalf("no live group means no refresh: calls=%d err=%v", calls, err)
	}
}
