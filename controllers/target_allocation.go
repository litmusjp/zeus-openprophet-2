package controllers

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"prophet-trader/interfaces"
)

// Herald target-allocation guard (F2).
//
// Recognition: OP2 has no dedicated "target" field. The rule owner (agent/trading-guidance.js) has the agent label a target
// exit through its client_order_id, e.g. herald-20261125-dis-target-1330-01. A sell is a target-intent sell when it is a
// single-leg sell_to_close whose client_order_id carries the standalone token "target" (case-insensitive, delimited by any
// non-alphanumeric character or the string ends). Stop, trail, invalidation and time closes carry no such token and are
// never examined by this guard.
var targetIntentTokenPattern = regexp.MustCompile(`(?i)(^|[^a-z0-9])target([^a-z0-9]|$)`)

const (
	targetEvidenceConfirmed = "confirmed"
	targetEvidenceUnknown   = "unknown"

	targetRefusalSpent    = "TARGET_ALLOCATION_SPENT"
	targetRefusalExceeded = "TARGET_ALLOCATION_EXCEEDED"
	targetRefusalUnknown  = "TARGET_ALLOCATION_UNKNOWN"
)

// TargetAllocation is the read-only view of one position cycle's once-only half-target allocation.
type TargetAllocation struct {
	AllocatedQty   float64 `json:"allocated_qty"`
	FilledQty      float64 `json:"filled_qty"`
	ReservedQty    float64 `json:"reserved_qty"`
	AvailableQty   float64 `json:"available_qty"`
	Spent          bool    `json:"spent"`
	PositionCycle  string  `json:"position_cycle"`
	EvidenceStatus string  `json:"evidence_status"`
	EvidenceReason string  `json:"evidence_reason,omitempty"`
}

func isTargetIntentClientID(clientOrderID string) bool {
	return targetIntentTokenPattern.MatchString(clientOrderID)
}

// isTargetIntentSell reports whether an options request is a target-intent sell under the rule.
func isTargetIntentSell(req OptionsOrderRequest) bool {
	return len(req.OptionLegs) == 0 && req.Side == "sell" && req.PositionIntent == "sell_to_close" && isTargetIntentClientID(req.ClientOrderID)
}

func targetUnknown(cycle, reason string) *TargetAllocation {
	return &TargetAllocation{PositionCycle: cycle, EvidenceStatus: targetEvidenceUnknown, EvidenceReason: reason}
}

// terminalOrderStatus reports whether a status can no longer fill. Unknown statuses are not terminal, so they keep a reservation.
func terminalOrderStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "filled", "canceled", "cancelled", "expired", "rejected", "rejected_before_submission", "done_for_day", "replaced", "withdrawn", "stopped", "suspended":
		return true
	}
	return false
}

func orderEventTime(o *interfaces.Order) time.Time {
	if o.FilledAt != nil && !o.FilledAt.IsZero() {
		return *o.FilledAt
	}
	return o.SubmittedAt
}

// computeTargetAllocation reconciles the exact contract's complete all-status broker order history (plus local uncertain
// intents) into the current position cycle's target allocation. excludeClientID is the request being admitted, so a retried
// intent never reserves against itself. Any gap in the evidence yields evidence_status "unknown".
func (oc *OrderController) computeTargetAllocation(ctx context.Context, symbol, excludeClientID string) *TargetAllocation {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if oc.tradingService == nil {
		return targetUnknown("", "broker service unavailable")
	}
	position, err := oc.tradingService.GetOptionsPosition(ctx, symbol)
	if err != nil || position == nil {
		return targetUnknown("", "broker-confirmed position could not be read")
	}
	cyclePrefix := position.BrokerAccountID + "/" + symbol
	if position.Side == "short" || position.Qty <= 0 || position.Qty != math.Trunc(position.Qty) {
		return targetUnknown(cyclePrefix, "broker position is not a whole-contract long position")
	}
	brokerOrders, err := oc.tradingService.ListOrders(ctx, "all")
	if err != nil {
		return targetUnknown(cyclePrefix, "complete broker order history is unavailable")
	}
	var localOrders []*interfaces.Order
	if oc.storageService != nil {
		if localOrders, err = oc.storageService.GetOrders(""); err != nil {
			return targetUnknown(cyclePrefix, "local order records are unavailable")
		}
	}

	// Dedupe: one record per broker order (by id and by client id); a local record never double-counts a broker-visible order.
	seenID := map[string]bool{}
	seenClient := map[string]bool{}
	var broker, local []*interfaces.Order
	for _, o := range brokerOrders {
		if o == nil || !strings.EqualFold(o.Symbol, symbol) {
			continue
		}
		if (o.ID != "" && seenID[o.ID]) || (o.ClientOrderID != "" && seenClient[o.ClientOrderID]) {
			continue
		}
		if o.ID != "" {
			seenID[o.ID] = true
		}
		if o.ClientOrderID != "" {
			seenClient[o.ClientOrderID] = true
		}
		broker = append(broker, o)
	}
	for _, o := range localOrders {
		if o == nil || !strings.EqualFold(o.Symbol, symbol) {
			continue
		}
		if (o.ID != "" && seenID[o.ID]) || (o.ClientOrderID != "" && seenClient[o.ClientOrderID]) {
			continue
		}
		if o.ClientOrderID != "" {
			seenClient[o.ClientOrderID] = true
		}
		local = append(local, o)
	}

	// Walk filled quantity chronologically to find the current open cycle.
	type fill struct {
		at    time.Time
		id    string
		delta float64
	}
	var fills []fill
	for _, o := range broker {
		if o.FilledQty <= 0 {
			continue
		}
		delta := o.FilledQty
		if strings.EqualFold(o.Side, "sell") {
			delta = -delta
		} else if !strings.EqualFold(o.Side, "buy") {
			return targetUnknown(cyclePrefix, "an order for this contract has an unrecognised side")
		}
		fills = append(fills, fill{at: orderEventTime(o), id: o.ID, delta: delta})
	}
	sort.SliceStable(fills, func(i, j int) bool {
		if !fills[i].at.Equal(fills[j].at) {
			return fills[i].at.Before(fills[j].at)
		}
		return fills[i].id < fills[j].id
	})
	net := 0.0
	var cycleStart time.Time
	cycleOpener := ""
	for _, f := range fills {
		if net == 0 && f.delta > 0 {
			cycleStart, cycleOpener = f.at, f.id
		}
		net += f.delta
		if net < 0 {
			return targetUnknown(cyclePrefix, "order history is inconsistent with a long position")
		}
		if net == 0 {
			cycleOpener = ""
		}
	}
	if cycleOpener == "" || net != position.Qty {
		return targetUnknown(cyclePrefix, "order history does not reconcile to the broker-confirmed position quantity")
	}
	cycle := cyclePrefix + "/" + cycleOpener

	// Target orders of this cycle. A broker order rejected outright never became a target event.
	var targets []*interfaces.Order
	for _, o := range broker {
		if !strings.EqualFold(o.Side, "sell") || !isTargetIntentClientID(o.ClientOrderID) || o.ClientOrderID == excludeClientID {
			continue
		}
		if o.SubmittedAt.Before(cycleStart) {
			continue
		}
		if strings.EqualFold(o.Status, "rejected") && o.FilledQty <= 0 {
			continue
		}
		targets = append(targets, o)
	}
	sort.SliceStable(targets, func(i, j int) bool { return targets[i].SubmittedAt.Before(targets[j].SubmittedAt) })

	// Allocation basis: broker-confirmed quantity at the first target event (the order being admitted when none exists yet).
	basis := position.Qty
	if len(targets) > 0 {
		first := targets[0]
		basis = 0
		for _, f := range fills {
			if !f.at.Before(cycleStart) && f.at.Before(first.SubmittedAt) {
				basis += f.delta
			}
		}
		for _, o := range broker {
			if strings.EqualFold(o.Side, "buy") && !terminalOrderStatus(o.Status) && o.SubmittedAt.Before(first.SubmittedAt) {
				return targetUnknown(cycle, "an opening order was still working at the first target event")
			}
		}
	} else {
		for _, o := range broker {
			if strings.EqualFold(o.Side, "buy") && !terminalOrderStatus(o.Status) {
				return targetUnknown(cycle, "an opening order is still working, so the position quantity is not final")
			}
		}
	}
	if basis <= 0 || basis != math.Trunc(basis) {
		return targetUnknown(cycle, "the quantity held at the first target event could not be established")
	}
	allocated := 1.0
	if basis > 1 {
		allocated = math.Floor(basis / 2)
	}

	filled, reserved := 0.0, 0.0
	for _, o := range targets {
		filled += o.FilledQty
		if !terminalOrderStatus(o.Status) {
			if o.Qty <= 0 || o.Qty < o.FilledQty {
				return targetUnknown(cycle, "a working target order has an unusable quantity")
			}
			reserved += o.Qty - o.FilledQty
		}
	}
	// Local-only target intents that may have reached the broker (uncertain) also reserve; planned or terminal ones do not.
	for _, o := range local {
		if !strings.EqualFold(o.Side, "sell") || !isTargetIntentClientID(o.ClientOrderID) || o.ClientOrderID == excludeClientID {
			continue
		}
		if o.SubmittedAt.Before(cycleStart) || strings.EqualFold(o.Status, "planned_for_next_session") {
			continue
		}
		if terminalOrderStatus(o.Status) || (strings.EqualFold(o.Status, "submit_failed") && !o.SubmissionAttempted) {
			continue
		}
		if o.Qty <= 0 {
			return targetUnknown(cycle, "an uncertain local target intent has an unusable quantity")
		}
		reserved += o.Qty - o.FilledQty
	}
	available := allocated - filled - reserved
	if available < 0 {
		available = 0
	}
	return &TargetAllocation{
		AllocatedQty:   allocated,
		FilledQty:      filled,
		ReservedQty:    reserved,
		AvailableQty:   available,
		Spent:          filled >= allocated,
		PositionCycle:  cycle,
		EvidenceStatus: targetEvidenceConfirmed,
	}
}

// targetAdmissionRefusal returns a refusal code and message when a target-intent sell may not be admitted, or "" to admit.
func (oc *OrderController) targetAdmissionRefusal(ctx context.Context, req OptionsOrderRequest) (code, message string) {
	state := oc.computeTargetAllocation(ctx, req.Symbol, req.ClientOrderID)
	const advice = " This refusal applies only to a target-labelled sell. A genuinely different due exit (stop, trail, invalidation or time close) needs a fresh intent with its own correctly labelled client_order_id; it is not blocked."
	if state.EvidenceStatus != targetEvidenceConfirmed {
		return targetRefusalUnknown, fmt.Sprintf("target allocation for this contract's position cycle is unknown (%s), so no target sell is admitted.%s", state.EvidenceReason, advice)
	}
	if state.Spent {
		return targetRefusalSpent, fmt.Sprintf("the once-only target allocation of %g contract(s) for this position cycle is already filled (%g filled); no further target sell is admitted.%s", state.AllocatedQty, state.FilledQty, advice)
	}
	if req.Qty > state.AvailableQty {
		return targetRefusalExceeded, fmt.Sprintf("requested target quantity %g exceeds the %g available (allocated %g, filled %g, reserved by working or uncertain target orders %g).%s", req.Qty, state.AvailableQty, state.AllocatedQty, state.FilledQty, state.ReservedQty, advice)
	}
	return "", ""
}
