package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// Phase C, Step 4 (D10, amendments A1 and A2): the backend-owned assignment resolver.
//
// When a multi-leg group breaks because a short leg was assigned (or a long leg exercised), the broker leaves stock in an
// options-only sandbox. The resolver reduces that stock to zero and nothing else:
//   - it acts only on stock that matches the group's missing legs exactly (an unlinked or mismatched position is left
//     alone and reported);
//   - authority is a server-created grant (never the agent's AllowStocks, which stays off); an operator-wide
//     RequireConfirmation stop is respected and the resolver waits;
//   - there is one durable operation per group: its stable client order id is saved on the group BEFORE any submission, a
//     later or concurrent pass follows that order instead of creating another, an uncertain order never gets a new id, and a
//     replacement is created only after the previous order is terminal;
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
	IssueAssignmentResolutionGrant(groupID, symbol, side string, qty float64) (*interfaces.AssignmentResolutionGrant, error)
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

// nextResolverAttempt returns the attempt number that follows the saved client id (1 when there is none).
func nextResolverAttempt(groupID, saved string) int {
	prefix := "resolver-" + groupID + "-"
	if !strings.HasPrefix(saved, prefix) {
		return 1
	}
	n, err := strconv.Atoi(strings.TrimPrefix(saved, prefix))
	if err != nil || n < 1 {
		return 1
	}
	return n + 1
}

var resolverWorkingStatuses = map[string]bool{
	"new": true, "accepted": true, "pending_new": true, "partially_filled": true, "pending_cancel": true, "pending_replace": true,
	"accepted_for_bidding": true, "open": true, "pending": true,
}

var resolverTerminalStatuses = map[string]bool{
	"canceled": true, "cancelled": true, "expired": true, "rejected": true, "rejected_before_submission": true, "done_for_day": true, "replaced": true,
}

// ResolveOnce runs one pass: reconcile the groups against the broker, then advance the single resolver operation of each
// group whose stock matches exactly. It returns what it found and did; it places at most one order per group.
func (r *AssignmentResolver) ResolveOnce(ctx context.Context) (ResolverReport, error) {
	var report ResolverReport
	states, err := r.Store.OptionGroupStates()
	if err != nil {
		return report, err
	}
	if len(states) == 0 {
		return report, nil // nothing to reconcile: no broker call is made
	}
	positions, err := r.Broker.GetPositions(ctx)
	if err != nil {
		return report, fmt.Errorf("positions unavailable for group reconciliation: %w", err)
	}
	report.Reconcile, err = ReconcileOptionGroups(r.Store, positions)
	if err != nil {
		return report, err
	}
	for _, finding := range report.Reconcile.Unresolved {
		report.Actions = append(report.Actions, ResolverAction{GroupID: finding.GroupID, Symbol: finding.Underlying, Outcome: "unresolved",
			Detail: "left alone: " + firstNonEmpty(finding.Mismatch, finding.Reason)})
	}
	for _, finding := range report.Reconcile.NeedsResolver {
		action, err := r.resolveGroup(ctx, finding, positions)
		if err != nil {
			return report, err
		}
		report.Actions = append(report.Actions, action)
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

func (r *AssignmentResolver) resolveGroup(ctx context.Context, finding GroupFinding, positions []*interfaces.Position) (ResolverAction, error) {
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
	// One owner per account and symbol: another group's resolver operation that is still in flight for the same stock goes first.
	for _, state := range states {
		other := state.Group
		if other == nil || other.GroupID == group.GroupID || other.ResolverClientID == "" || !strings.EqualFold(other.Underlying, group.Underlying) || other.Status != "broken" {
			continue
		}
		order, err := r.Orders.GetOrderByClientOrderID(other.ResolverClientID)
		if err != nil {
			return action, err
		}
		if order == nil || resolverWorkingStatuses[strings.ToLower(order.Status)] || strings.EqualFold(order.Status, "submission_uncertain") {
			action.Outcome, action.Detail = "waiting", fmt.Sprintf("resolver operation %s already owns the %s stock", other.ResolverClientID, group.Underlying)
			return action, nil
		}
	}
	side, qty := "sell", finding.StockQty
	if finding.StockQty < 0 {
		side, qty = "buy", -finding.StockQty
	}
	// Follow the group's existing operation before ever creating another.
	attempt := nextResolverAttempt(group.GroupID, "")
	if group.ResolverClientID != "" {
		existing, err := r.Orders.GetOrderByClientOrderID(group.ResolverClientID)
		if err != nil {
			return action, err
		}
		action.ClientID = group.ResolverClientID
		switch {
		case existing == nil:
			// Saved on the group but never persisted as an order (a crash between the two): it never reached the broker.
			attempt = nextResolverAttempt(group.GroupID, group.ResolverClientID) - 1
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
			attempt = nextResolverAttempt(group.GroupID, group.ResolverClientID)
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
	// A2: the operation's stable client identity is saved BEFORE the order can exist.
	clientID := resolverAttemptID(group.GroupID, attempt)
	group.ResolverClientID = clientID
	if err := r.Store.SaveOptionGroup(group); err != nil {
		return action, fmt.Errorf("could not save the resolver operation of group %s: %w", group.GroupID, err)
	}
	action.ClientID = clientID
	grant, err := r.Broker.IssueAssignmentResolutionGrant(group.GroupID, group.Underlying, side, qty)
	if err != nil {
		action.Outcome, action.Detail = "refused", err.Error()
		return action, nil
	}
	metadata, _ := json.Marshal(map[string]any{"resolver": true, "group_id": group.GroupID, "attempt": attempt, "implied_stock": finding.ImpliedStock})
	order := &interfaces.Order{
		ClientOrderID: clientID, Symbol: group.Underlying, Underlying: group.Underlying, AssetClass: "us_equity", Qty: qty, Side: side, Type: "limit", TimeInForce: "day",
		LimitPrice: &price, Purpose: "close", Status: "pending", SubmittedAt: r.now(), Metadata: string(metadata), ResolverGrant: grant,
	}
	if err := r.Orders.SaveOrder(order); err != nil {
		return action, fmt.Errorf("could not persist the resolver intent %s: %w", clientID, err)
	}
	result, err := r.Broker.PlaceOrder(ctx, order)
	if err != nil {
		var closed *MarketClosedError
		switch {
		case errors.As(err, &closed):
			order.Status = "rejected_before_submission"
			action.Outcome, action.Detail = "waiting", "the market closed before submission"
		case IsPreSubmissionRejection(err):
			order.Status = "rejected_before_submission"
			action.Outcome, action.Detail = "refused", err.Error()
		case IsBrokerRejection(err):
			order.Status, order.SubmissionAttempted = "rejected", true
			action.Outcome, action.Detail = "refused", err.Error()
		default:
			order.Status, order.SubmissionAttempted = "submission_uncertain", true
			action.Outcome, action.Detail = "waiting", "the submission is uncertain and will be reconciled, never replaced: "+err.Error()
		}
		if saveErr := r.Orders.SaveOrder(order); saveErr != nil {
			return action, fmt.Errorf("could not record the resolver outcome of %s: %w", clientID, saveErr)
		}
		return action, nil
	}
	order.SubmissionAttempted = true
	if result != nil {
		order.ID = result.OrderID
		order.Status = result.Status
		order.FilledQty = result.FilledQty
		order.FilledAvgPrice = result.FilledAvgPrice
	}
	if err := r.Orders.SaveOrder(order); err != nil {
		return action, fmt.Errorf("could not record the submitted resolver order %s: %w", clientID, err)
	}
	action.Outcome, action.Detail = "submitted", fmt.Sprintf("%s %.0f %s at a limit of %.2f", side, qty, group.Underlying, price)
	return action, nil
}

// RollbackClearance reports why the Step 4 build cannot be rolled back below its group-capable version (amendment A3).
// An empty list means nothing blocks it. It reads state and changes nothing.
func RollbackClearance(states []database.OptionGroupState, openOrders []*interfaces.Order, positions []*interfaces.Position) []string {
	var blockers []string
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
	for _, order := range openOrders {
		if order == nil || len(order.OptionLegs) == 0 {
			continue
		}
		status := strings.ToLower(order.Status)
		if resolverTerminalStatuses[status] || status == "filled" {
			continue
		}
		blockers = append(blockers, fmt.Sprintf("multi-leg order %s is %s (working, uncertain or planned)", order.ClientOrderID, order.Status))
	}
	for _, order := range openOrders {
		if order != nil && strings.HasPrefix(order.ClientOrderID, "resolver-") {
			status := strings.ToLower(order.Status)
			if !resolverTerminalStatuses[status] && status != "filled" {
				blockers = append(blockers, fmt.Sprintf("resolver order %s is %s", order.ClientOrderID, order.Status))
			}
		}
	}
	_ = positions
	return blockers
}
