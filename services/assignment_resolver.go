package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// Phase C, Step 4 (D10, amendments A1 and A2): the backend-owned assignment resolver.
//
// When a multi-leg group breaks because a short leg was assigned (or a long leg exercised), the broker leaves stock in an
// options-only sandbox. The resolver reduces that stock to zero and nothing else:
//   - it acts only on a stock CHANGE that equals what the missing legs imply, measured from the stock position recorded
//     while the group was intact (provenance), net of what the resolver has already delivered; any other stock is left
//     alone and reported, including unrelated stock whose size happens to match;
//   - authority is a server-created grant bound to one client order (never the agent's AllowStocks, which stays off); an
//     operator-wide RequireConfirmation stop is respected and the resolver waits;
//   - there is one durable operation per underlying: its stable client order id is claimed atomically on the group BEFORE any
//     submission, a later or concurrent pass follows that order instead of creating another, an uncertain order never gets a
//     new id, and a replacement is created only after the previous order is terminal;
//   - it runs in the regular session only, with a marketable limit inside a bounded price band, through the ordinary
//     broker adapter with its identity, session, quote, result and submission-boundary guards.

const (
	// resolverPriceBand is the bounded distance from the touch for the marketable limit (0.5%).
	resolverPriceBand = 0.005
	// resolverRetryAfter is how long after a refused or terminal-unfilled attempt the resolver waits before a new attempt.
	resolverRetryAfter = 15 * time.Minute
	resolverQuoteAge   = 2 * time.Minute
)

type resolverBroker interface {
	GetPositions(ctx context.Context) ([]*interfaces.Position, error)
	RegularSessionOpen(ctx context.Context) (bool, error)
	LatestStockQuote(ctx context.Context, symbol string) (bid, ask float64, at time.Time, err error)
	IssueAssignmentResolutionGrant(groupID, clientOrderID, symbol, side string, qty float64) (*interfaces.AssignmentResolutionGrant, error)
	PlaceOrder(ctx context.Context, order *interfaces.Order) (*interfaces.OrderResult, error)
}

type resolverOrders interface {
	GetOrderByClientOrderID(clientOrderID string) (*interfaces.Order, error)
	SaveOrder(order *interfaces.Order) error
}

// AssignmentResolver reconciles groups and resolves linked assignment stock. It never cancels or modifies an order.
type AssignmentResolver struct {
	Store  OptionGroupStore
	Orders resolverOrders
	Broker resolverBroker
	Now    func() time.Time
	// Refresh brings the local order ledger up to date with the broker (the validated order-reconciliation owner). It runs at
	// the start of every pass that has live groups, so fills of entries, closes and resolver orders advance the derived group
	// state during normal operation, not only at startup.
	Refresh func(ctx context.Context)
	mu      sync.Mutex // one pass at a time in this process
}

// ResolverAction is one thing the resolver did or decided to wait on, for the beat report and the logs.
type ResolverAction struct {
	GroupID  string
	Symbol   string
	Outcome  string // submitted, waiting, refused, unresolved
	Detail   string
	ClientID string
}

// ResolverReport is the result of one pass.
type ResolverReport struct {
	Reconcile OptionGroupReconcileReport
	Actions   []ResolverAction
}

func (r *AssignmentResolver) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func resolverAttemptID(groupID string, attempt int) string {
	return "resolver-" + groupID + "-" + strconv.Itoa(attempt)
}

// resolverAttemptNumber returns the attempt number encoded in the saved client id (0 when there is none).
func resolverAttemptNumber(groupID, saved string) int {
	prefix := "resolver-" + groupID + "-"
	if !strings.HasPrefix(saved, prefix) {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimPrefix(saved, prefix))
	if err != nil || n < 1 {
		return 0
	}
	return n
}

var resolverWorkingStatuses = map[string]bool{
	"new": true, "accepted": true, "pending_new": true, "partially_filled": true, "pending_cancel": true, "pending_replace": true,
	"accepted_for_bidding": true, "open": true, "pending": true,
}

var resolverTerminalStatuses = map[string]bool{
	"canceled": true, "cancelled": true, "expired": true, "rejected": true, "rejected_before_submission": true, "done_for_day": true, "replaced": true,
}

// coverage reads every resolver attempt of the group from the order ledger: the cumulative shares delivered and whether any
// attempt is still working or uncertain.
func (r *AssignmentResolver) coverage(group *models.DBOptionGroup) (ResolverCoverage, error) {
	var out ResolverCoverage
	for attempt := 1; attempt <= resolverAttemptNumber(group.GroupID, group.ResolverClientID); attempt++ {
		order, err := r.Orders.GetOrderByClientOrderID(resolverAttemptID(group.GroupID, attempt))
		if err != nil {
			return out, err
		}
		if order == nil {
			continue
		}
		status := strings.ToLower(order.Status)
		switch order.Side {
		case "buy":
			out.SignedShares += order.FilledQty
		case "sell":
			out.SignedShares -= order.FilledQty
		}
		switch {
		case resolverWorkingStatuses[status]:
			out.Working = true
		case status == "submission_uncertain":
			out.Uncertain = true
		case !resolverTerminalStatuses[status] && status != "filled":
			out.Uncertain = true
		}
	}
	return out, nil
}

// ResolveOnce runs one pass: refresh the order ledger, reconcile the groups against the broker, then advance the single
// resolver operation of each group whose stock change matches exactly. It places at most one order per group.
func (r *AssignmentResolver) ResolveOnce(ctx context.Context) (ResolverReport, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var report ResolverReport
	states, err := r.Store.OptionGroupStates()
	if err != nil {
		return report, err
	}
	if len(states) == 0 {
		return report, nil // nothing to reconcile: no broker call is made
	}
	if r.Refresh != nil {
		r.Refresh(ctx)
		if states, err = r.Store.OptionGroupStates(); err != nil {
			return report, err
		}
	}
	positions, err := r.Broker.GetPositions(ctx)
	if err != nil {
		return report, fmt.Errorf("positions unavailable for group reconciliation: %w", err)
	}
	report.Reconcile, err = ReconcileOptionGroupsWith(r.Store, positions, ReconcileDeps{Coverage: r.coverage})
	if err != nil {
		return report, err
	}
	for _, finding := range report.Reconcile.Unresolved {
		report.Actions = append(report.Actions, ResolverAction{GroupID: finding.GroupID, Symbol: finding.Underlying, Outcome: "unresolved",
			Detail: "left alone: " + firstNonEmpty(finding.Mismatch, finding.Reason)})
	}
	for _, finding := range report.Reconcile.Waiting {
		report.Actions = append(report.Actions, ResolverAction{GroupID: finding.GroupID, Symbol: finding.Underlying, Outcome: "waiting",
			Detail: "a resolver order is not yet terminal; the group stays broken until it is"})
	}
	for _, finding := range report.Reconcile.NeedsResolver {
		action, err := r.resolveGroup(ctx, finding)
		if err != nil {
			return report, err
		}
		report.Actions = append(report.Actions, action)
	}
	if live, err := r.Store.OptionGroupStates(); err == nil {
		r.advise(ctx, live) // information only (short leg near expiry in the money); never an order
	}
	return report, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// recordOrder reloads the order at its CURRENT revision (the submission marker and reconciliation both advance it), applies
// the change, and saves it, retrying once on a stale-revision refusal. Revision checks are never bypassed.
func (r *AssignmentResolver) recordOrder(clientID string, fallback *interfaces.Order, apply func(o *interfaces.Order)) error {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		fresh, err := r.Orders.GetOrderByClientOrderID(clientID)
		if err != nil {
			return err
		}
		if fresh == nil {
			copied := *fallback
			fresh = &copied
		}
		apply(fresh)
		if lastErr = r.Orders.SaveOrder(fresh); lastErr == nil {
			return nil
		}
		if !strings.Contains(lastErr.Error(), "stale") {
			return lastErr
		}
	}
	return lastErr
}

func (r *AssignmentResolver) resolveGroup(ctx context.Context, finding GroupFinding) (ResolverAction, error) {
	action := ResolverAction{GroupID: finding.GroupID, Symbol: finding.Underlying}
	states, err := r.Store.OptionGroupStates()
	if err != nil {
		return action, err
	}
	var group *models.DBOptionGroup
	for _, state := range states {
		if state.Group != nil && state.Group.GroupID == finding.GroupID {
			group = state.Group
		}
	}
	if group == nil {
		action.Outcome, action.Detail = "waiting", "group is no longer live"
		return action, nil
	}
	// The linked stock still to be reduced is the CHANGE from the pre-event baseline (net of earlier resolver fills), never the whole position.
	side, qty := "sell", finding.StockDelta
	if finding.StockDelta < 0 {
		side, qty = "buy", -finding.StockDelta
	}
	attempt := 1
	if group.ResolverClientID != "" {
		existing, err := r.Orders.GetOrderByClientOrderID(group.ResolverClientID)
		if err != nil {
			return action, err
		}
		action.ClientID = group.ResolverClientID
		saved := resolverAttemptNumber(group.GroupID, group.ResolverClientID)
		switch {
		case existing == nil:
			// Saved on the group but never persisted as an order (a crash between the two): it never reached the broker.
			attempt = saved
			if attempt < 1 {
				attempt = 1
			}
		case strings.EqualFold(existing.Status, "submission_uncertain") || (existing.SubmissionAttempted && !resolverTerminalStatuses[strings.ToLower(existing.Status)] && !resolverWorkingStatuses[strings.ToLower(existing.Status)] && !strings.EqualFold(existing.Status, "filled")):
			action.Outcome, action.Detail = "waiting", "the resolver order is uncertain; it is reconciled, never replaced"
			return action, nil
		case resolverWorkingStatuses[strings.ToLower(existing.Status)]:
			action.Outcome, action.Detail = "waiting", "the resolver order is still working"
			return action, nil
		case strings.EqualFold(existing.Status, "filled"):
			action.Outcome, action.Detail = "waiting", "the resolver order is filled; waiting for the broker position to clear"
			return action, nil
		case resolverTerminalStatuses[strings.ToLower(existing.Status)]:
			if !existing.SubmittedAt.IsZero() && r.now().Sub(existing.SubmittedAt) < resolverRetryAfter {
				action.Outcome, action.Detail = "waiting", fmt.Sprintf("the last attempt ended %s; the next attempt waits %s", existing.Status, resolverRetryAfter)
				return action, nil
			}
			attempt = saved + 1
		default:
			action.Outcome, action.Detail = "waiting", fmt.Sprintf("the resolver order is in the unrecognised state %q", existing.Status)
			return action, nil
		}
	}
	open, err := r.Broker.RegularSessionOpen(ctx)
	if err != nil || !open {
		action.Outcome, action.Detail = "waiting", "the regular session is closed or its clock is unreadable; the resolver acts in regular hours only"
		return action, nil
	}
	bid, ask, quotedAt, err := r.Broker.LatestStockQuote(ctx, group.Underlying)
	if err != nil {
		action.Outcome, action.Detail = "waiting", "no stock quote: "+err.Error()
		return action, nil
	}
	if quotedAt.IsZero() || r.now().Sub(quotedAt) > resolverQuoteAge || quotedAt.After(r.now().Add(time.Minute)) {
		action.Outcome, action.Detail = "waiting", "the stock quote is stale or undated"
		return action, nil
	}
	price := ask * (1 + resolverPriceBand)
	touch := ask
	if side == "sell" {
		price, touch = bid*(1-resolverPriceBand), bid
	}
	if touch <= 0 || math.IsNaN(touch) || math.IsInf(touch, 0) {
		action.Outcome, action.Detail = "waiting", "the stock quote has no positive executable price"
		return action, nil
	}
	if side == "sell" {
		price = math.Floor(price*100) / 100
	} else {
		price = math.Ceil(price*100) / 100
	}
	if price <= 0 {
		action.Outcome, action.Detail = "waiting", "the bounded limit price is not positive"
		return action, nil
	}
	// A2: the operation's stable client identity is claimed atomically on the group BEFORE the order can exist, and only one
	// group per underlying may own an in-flight operation.
	clientID := resolverAttemptID(group.GroupID, attempt)
	claimed, owner, err := r.Store.ClaimResolverOperation(group.GroupID, clientID)
	if err != nil {
		return action, fmt.Errorf("could not claim the resolver operation of group %s: %w", group.GroupID, err)
	}
	if !claimed {
		action.Outcome, action.Detail = "waiting", fmt.Sprintf("resolver operation %s already owns the %s stock", owner, group.Underlying)
		return action, nil
	}
	action.ClientID = clientID
	grant, err := r.Broker.IssueAssignmentResolutionGrant(group.GroupID, clientID, group.Underlying, side, qty)
	if err != nil {
		action.Outcome, action.Detail = "refused", err.Error()
		return action, nil
	}
	metadata, _ := json.Marshal(map[string]any{"resolver": true, "group_id": group.GroupID, "attempt": attempt, "implied_stock": finding.ImpliedStock, "stock_delta": finding.StockDelta})
	order := &interfaces.Order{
		ClientOrderID: clientID, Symbol: group.Underlying, Underlying: group.Underlying, AssetClass: "us_equity", Qty: qty, Side: side, Type: "limit", TimeInForce: "day",
		LimitPrice: &price, Purpose: "close", Status: "pending", SubmittedAt: r.now(), Metadata: string(metadata), ResolverGrant: grant,
	}
	if existing, err := r.Orders.GetOrderByClientOrderID(clientID); err != nil {
		return action, err
	} else if existing == nil {
		if err := r.Orders.SaveOrder(order); err != nil {
			return action, fmt.Errorf("could not persist the resolver intent %s: %w", clientID, err)
		}
	}
	result, err := r.Broker.PlaceOrder(ctx, order)
	if err != nil {
		var closed *MarketClosedError
		status, attempted := "submission_uncertain", true
		switch {
		case errors.As(err, &closed):
			status, attempted = "rejected_before_submission", false
			action.Outcome, action.Detail = "waiting", "the market closed before submission"
		case IsPreSubmissionRejection(err):
			status, attempted = "rejected_before_submission", false
			action.Outcome, action.Detail = "refused", err.Error()
		case IsBrokerRejection(err):
			status, attempted = "rejected", true
			action.Outcome, action.Detail = "refused", err.Error()
		default:
			action.Outcome, action.Detail = "waiting", "the submission is uncertain and will be reconciled, never replaced: "+err.Error()
		}
		if saveErr := r.recordOrder(clientID, order, func(o *interfaces.Order) {
			o.Status = status
			o.SubmissionAttempted = o.SubmissionAttempted || attempted
		}); saveErr != nil {
			return action, fmt.Errorf("could not record the resolver outcome of %s: %w", clientID, saveErr)
		}
		return action, nil
	}
	if saveErr := r.recordOrder(clientID, order, func(o *interfaces.Order) {
		o.SubmissionAttempted = true
		if result != nil {
			o.ID = result.OrderID
			o.Status = result.Status
			if result.FilledQty >= o.FilledQty {
				o.FilledQty = result.FilledQty
				o.FilledAvgPrice = result.FilledAvgPrice
			}
		}
	}); saveErr != nil {
		return action, fmt.Errorf("could not record the submitted resolver order %s: %w", clientID, saveErr)
	}
	action.Outcome, action.Detail = "submitted", fmt.Sprintf("%s %.0f %s at a limit of %.2f", side, qty, group.Underlying, price)
	return action, nil
}

// RollbackClearance reports why the Step 4 build cannot be rolled back below its group-capable version (amendment A3).
// An empty list means nothing blocks it. It reads state and changes nothing. It needs the identity-bound broker and local
// state: every group of every status (history included), the live group states, the open and planned orders, and the broker
// positions. Unreadable or unknown proof is never clearance (positionsKnown must be true).
func RollbackClearance(groups []*models.DBOptionGroup, states []database.OptionGroupState, openOrders []*interfaces.Order, positions []*interfaces.Position, positionsKnown bool) []string {
	var blockers []string
	if !positionsKnown {
		blockers = append(blockers, "broker positions are unreadable, so linked stock cannot be ruled out")
	}
	for _, state := range states {
		group := state.Group
		if group == nil {
			continue
		}
		id := group.GroupID
		switch {
		case state.OpenUnits > 0 && group.Status != "broken":
			blockers = append(blockers, fmt.Sprintf("group %s still holds %.0f open spread units", id, state.OpenUnits))
		case group.Status == "pending_entry":
			blockers = append(blockers, fmt.Sprintf("group %s has an entry that is not yet terminal", id))
		case group.Status == "broken":
			blockers = append(blockers, fmt.Sprintf("group %s is broken and unresolved", id))
		}
		if state.PendingClose {
			blockers = append(blockers, fmt.Sprintf("group %s has a working or uncertain close order", id))
		}
		if group.ResolverClientID != "" && group.Status == "broken" {
			blockers = append(blockers, fmt.Sprintf("group %s has a resolver operation %s", id, group.ResolverClientID))
		}
	}
	// Residual stock from any group that ever broke or had a resolver operation blocks the downgrade, even after the group closed.
	stock := map[string]float64{}
	for _, position := range positions {
		if position != nil && position.Qty != 0 && !IsOCCOptionSymbol(position.Symbol) {
			stock[strings.ToUpper(strings.TrimSpace(position.Symbol))] += signedPositionQty(position)
		}
	}
	for _, group := range groups {
		if group == nil || (group.BrokenReason == "" && group.ResolverClientID == "") {
			continue
		}
		underlying := strings.ToUpper(strings.TrimSpace(group.Underlying))
		baseline := 0.0
		if group.StockBaselineSet {
			baseline = group.StockBaseline
		}
		if held, ok := stock[underlying]; ok && math.Abs(held-baseline) > 1e-9 {
			blockers = append(blockers, fmt.Sprintf("group %s (%s) left %.0f shares of %s beyond its recorded baseline of %.0f", group.GroupID, group.Status, held, underlying, baseline))
		}
	}
	for _, order := range openOrders {
		if order == nil {
			continue
		}
		status := strings.ToLower(order.Status)
		if resolverTerminalStatuses[status] || status == "filled" {
			continue
		}
		if len(order.OptionLegs) > 0 {
			blockers = append(blockers, fmt.Sprintf("multi-leg order %s is %s (working, uncertain or planned)", order.ClientOrderID, order.Status))
		}
		if strings.HasPrefix(order.ClientOrderID, "resolver-") {
			blockers = append(blockers, fmt.Sprintf("resolver order %s is %s", order.ClientOrderID, order.Status))
		}
	}
	return blockers
}
