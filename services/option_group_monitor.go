package services

import (
	"fmt"
	"math"
	"strings"

	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// Phase C, Step 4 (B07): detecting a broken multi-leg group. Reconciliation compares each live group's attached legs with
// the broker's positions. A leg that is missing or short of its expected quantity (assigned, exercised, expired or closed
// outside OP2) breaks the group. A broken group is recorded, its surviving legs are detached into ordinary single-leg
// management, new spread entries for the sandbox are refused while it is unresolved, and stock is only ever acted on when
// its CHANGE from the stock position recorded while the group was intact equals exactly what the missing legs imply
// (provenance), never because a share count happens to match.

const sharesPerContract = 100.0

// GroupFinding is the result of evaluating one live group against the broker's positions.
type GroupFinding struct {
	GroupID       string
	Underlying    string
	Intact        bool
	Reason        string                 // empty when intact
	GoneLegs      []interfaces.OptionLeg // attached legs that are missing or short at the broker
	SurvivingLegs []interfaces.OptionLeg // attached legs still held in full
	// ImpliedStock is the signed share change the gone legs imply if they were assigned or exercised (a short call
	// assigned = -100 per contract, a short put assigned = +100, a long call exercised = +100, a long put exercised = -100).
	ImpliedStock float64
	// StockQty is the signed broker stock position in the underlying (zero when none).
	StockQty float64
	// BaselineKnown says whether a stock position was recorded for this group while it was intact. StockDelta is the change
	// from that baseline (the stock this event left behind). Without a baseline there is no provenance: any stock is left alone.
	BaselineKnown bool
	StockDelta    float64
	// Linked is true only when the baseline is known, StockDelta is not zero and equals ImpliedStock plus the shares the
	// resolver has already delivered: the stock is the assignment of this group and nothing else.
	Linked   bool
	Mismatch string // stock change that cannot be attributed to this group's gone legs
}

func signedPositionQty(position *interfaces.Position) float64 {
	qty := position.Qty
	side := strings.ToLower(strings.TrimSpace(position.Side))
	if (side == "short" || side == "sell") && qty > 0 {
		return -qty
	}
	return qty
}

// legExpectedQty is the broker quantity an attached leg should show: long (+) for a leg opened by buying, short (-) for one opened by selling.
func legExpectedQty(leg interfaces.OptionLeg, units float64) float64 {
	qty := units * float64(leg.RatioQty)
	if leg.Side == "sell" {
		return -qty
	}
	return qty
}

// impliedStockForGoneLeg is the share change if the missing quantity of this leg was assigned or exercised.
func impliedStockForGoneLeg(leg interfaces.OptionLeg, missingContracts float64) float64 {
	_, _, optionType, _, ok := parseOCCOptionSymbol(leg.Symbol)
	if !ok || missingContracts <= 0 {
		return 0
	}
	shares := missingContracts * sharesPerContract
	long := leg.Side == "buy"
	switch {
	case optionType == "C" && long:
		return shares // exercise of a long call buys shares
	case optionType == "C" && !long:
		return -shares // assignment of a short call sells shares
	case optionType == "P" && long:
		return -shares // exercise of a long put sells shares
	default:
		return shares // assignment of a short put buys shares
	}
}

// EvaluateOptionGroup compares one live group with the broker's positions. resolvedShares is the signed shares the
// resolver has already delivered for this group (a buy to cover is positive, a sale is negative), so a partly resolved
// event keeps its linkage. A group with no open units is intact by definition. An unreadable record is an error.
func EvaluateOptionGroup(state database.OptionGroupState, positions []*interfaces.Position, resolvedShares float64) (GroupFinding, error) {
	group := state.Group
	if group == nil {
		return GroupFinding{}, fmt.Errorf("option group is required")
	}
	finding := GroupFinding{GroupID: group.GroupID, Underlying: strings.ToUpper(strings.TrimSpace(group.Underlying)), Intact: true, BaselineKnown: group.StockBaselineSet}
	if state.OpenUnits <= 0 {
		return finding, nil
	}
	legs, err := decodeGroupLegs(group.LegsJSON)
	if err != nil {
		return finding, fmt.Errorf("option group %s has unreadable legs: %w", group.GroupID, err)
	}
	detached, err := decodeGroupLegs(group.DetachedLegsJSON)
	if err != nil {
		return finding, fmt.Errorf("option group %s has unreadable detached legs: %w", group.GroupID, err)
	}
	gone := map[string]bool{}
	for _, leg := range detached {
		gone[strings.ToUpper(strings.TrimSpace(leg.Symbol))] = true
	}
	held := map[string]float64{}
	var stock float64
	for _, position := range positions {
		if position == nil || position.Qty == 0 {
			continue
		}
		symbol := strings.ToUpper(strings.TrimSpace(position.Symbol))
		if IsOCCOptionSymbol(symbol) {
			held[symbol] += signedPositionQty(position)
		} else if symbol == finding.Underlying {
			stock += signedPositionQty(position)
		}
	}
	finding.StockQty = stock
	for _, leg := range legs {
		symbol := strings.ToUpper(strings.TrimSpace(leg.Symbol))
		if gone[symbol] {
			continue
		}
		expected := legExpectedQty(leg, state.OpenUnits)
		actual := held[symbol]
		if math.Abs(actual) >= math.Abs(expected)-1e-9 && (actual > 0) == (expected > 0) {
			finding.SurvivingLegs = append(finding.SurvivingLegs, leg)
			continue
		}
		finding.GoneLegs = append(finding.GoneLegs, leg)
		missing := math.Abs(expected) - math.Abs(actual)
		if (actual > 0) != (expected > 0) {
			missing = math.Abs(expected)
		}
		finding.ImpliedStock += impliedStockForGoneLeg(leg, missing)
	}
	if len(finding.GoneLegs) == 0 {
		return finding, nil
	}
	finding.Intact = false
	switch {
	case len(finding.SurvivingLegs) == 0:
		finding.Reason = "all legs missing at the broker"
	case len(finding.GoneLegs) == 1 && finding.GoneLegs[0].Side == "sell":
		finding.Reason = "short leg missing at the broker (assigned, expired or closed outside OP2)"
	default:
		finding.Reason = "a leg is missing or short at the broker"
	}
	switch {
	case group.StockBaselineSet:
		finding.StockDelta = stock - group.StockBaseline
	case stock == 0:
		finding.StockDelta = 0 // no stock at all: nothing was left behind
	default:
		finding.StockDelta = stock
		finding.Mismatch = fmt.Sprintf("stock position %.0f in %s exists but no pre-event stock baseline was recorded for this group, so it cannot be attributed to the missing legs", stock, finding.Underlying)
		return finding, nil
	}
	if finding.StockDelta == 0 {
		return finding, nil
	}
	if finding.ImpliedStock != 0 && math.Abs(finding.StockDelta-(finding.ImpliedStock+resolvedShares)) < 1e-9 {
		finding.Linked = true
	} else {
		finding.Mismatch = fmt.Sprintf("a stock change of %.0f shares in %s does not match the %.0f shares implied by the missing legs (already delivered by the resolver: %.0f)", finding.StockDelta, finding.Underlying, finding.ImpliedStock, resolvedShares)
	}
	return finding, nil
}

// OptionGroupStore is the durable ledger the monitor and the resolver read and write.
type OptionGroupStore interface {
	OptionGroupStates() ([]database.OptionGroupState, error)
	SaveOptionGroup(group *models.DBOptionGroup) error
	// ClaimResolverOperation atomically makes clientID the one resolver operation for the group's underlying, refusing (and
	// naming the owner) when another group's resolver order on the same underlying is missing, working or uncertain.
	ClaimResolverOperation(groupID, clientID string) (claimed bool, owner string, err error)
}

// ResolverCoverage is what the group's resolver orders have done so far, read from the order ledger.
type ResolverCoverage struct {
	SignedShares float64 // a buy to cover is positive, a sale negative, summed over cumulative fills of every attempt
	Working      bool    // a resolver order is still working
	Uncertain    bool    // a resolver order is uncertain (or its state is unknown)
}

// ReconcileDeps lets the resolver supply the order-ledger facts the pure monitor cannot see.
type ReconcileDeps struct {
	Coverage func(group *models.DBOptionGroup) (ResolverCoverage, error)
}

// OptionGroupReconcileReport is what one reconciliation pass found and recorded.
type OptionGroupReconcileReport struct {
	Findings           []GroupFinding // every non-intact group, newly or already broken
	NewlyBroken        []string       // groups marked broken in this pass
	ClosedWithoutStock []string       // broken groups with nothing left to resolve, closed in this pass
	NeedsResolver      []GroupFinding // broken groups whose stock change matches the missing legs exactly
	Unresolved         []GroupFinding // broken groups with stock that cannot be attributed: left alone and reported
	Waiting            []GroupFinding // broken groups with nothing left to trade but a resolver order not yet terminal
}

// ReconcileOptionGroups is ReconcileOptionGroupsWith with no resolver coverage: any group that already has a resolver
// operation is then treated as unresolved rather than closed.
func ReconcileOptionGroups(store OptionGroupStore, positions []*interfaces.Position) (OptionGroupReconcileReport, error) {
	return ReconcileOptionGroupsWith(store, positions, ReconcileDeps{})
}

// ReconcileOptionGroupsWith evaluates every live group against the broker positions and records the result durably:
//   - an intact group keeps its stock baseline current (the provenance for any later event);
//   - a newly broken group is marked broken with its reason and its surviving legs are durably detached into ordinary
//     single-leg management (only then may that leg be closed on its own);
//   - a broken group whose stock change matches its missing legs exactly (net of what the resolver delivered) is returned
//     for the resolver;
//   - a broken group with no stock change is closed only when its resolver orders (if any) are all terminal; otherwise it
//     stays broken and is reported as waiting;
//   - a broken group with stock that cannot be attributed is left broken and reported (never guessed at).
//
// It places no order. Spread entries stay refused for the sandbox while any group is broken.
func ReconcileOptionGroupsWith(store OptionGroupStore, positions []*interfaces.Position, deps ReconcileDeps) (OptionGroupReconcileReport, error) {
	var report OptionGroupReconcileReport
	states, err := store.OptionGroupStates()
	if err != nil {
		return report, err
	}
	for _, state := range states {
		group := state.Group
		if group == nil || state.OpenUnits <= 0 {
			continue
		}
		var coverage ResolverCoverage
		if group.ResolverClientID != "" {
			if deps.Coverage == nil {
				coverage.Uncertain = true
			} else if coverage, err = deps.Coverage(group); err != nil {
				return report, err
			}
		}
		finding, err := EvaluateOptionGroup(state, positions, coverage.SignedShares)
		if err != nil {
			return report, err
		}
		if finding.Intact {
			if group.Status != "broken" && (!group.StockBaselineSet || group.StockBaseline != finding.StockQty) {
				group.StockBaseline, group.StockBaselineSet = finding.StockQty, true
				if err := store.SaveOptionGroup(group); err != nil {
					return report, fmt.Errorf("failed to record the stock baseline of option group %s: %w", group.GroupID, err)
				}
			}
			continue
		}
		if group.Status != "broken" {
			detached, err := decodeGroupLegs(group.DetachedLegsJSON)
			if err != nil {
				return report, err
			}
			detached = append(detached, finding.SurvivingLegs...)
			encoded, err := EncodeGroupLegs(detached)
			if err != nil {
				return report, err
			}
			group.Status = "broken"
			group.BrokenReason = finding.Reason
			group.DetachedLegsJSON = encoded
			if err := store.SaveOptionGroup(group); err != nil {
				return report, fmt.Errorf("failed to record broken option group %s: %w", group.GroupID, err)
			}
			report.NewlyBroken = append(report.NewlyBroken, group.GroupID)
		}
		report.Findings = append(report.Findings, finding)
		switch {
		case finding.Linked:
			report.NeedsResolver = append(report.NeedsResolver, finding)
		case finding.Mismatch != "":
			report.Unresolved = append(report.Unresolved, finding)
		case coverage.Working || coverage.Uncertain:
			// Nothing is left to trade, but a resolver order is not yet terminal: only all-flat, all-terminal state clears the block.
			report.Waiting = append(report.Waiting, finding)
		default:
			// A leg is gone and no stock change was left behind (expired worthless or closed outside OP2), and any resolver
			// order is terminal: the surviving legs are already detached, so nothing is left to resolve.
			group.Status = "closed"
			if err := store.SaveOptionGroup(group); err != nil {
				return report, fmt.Errorf("failed to close resolved option group %s: %w", group.GroupID, err)
			}
			report.ClosedWithoutStock = append(report.ClosedWithoutStock, group.GroupID)
		}
	}
	return report, nil
}
