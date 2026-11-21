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
// management, new spread entries for the sandbox are refused while it is unresolved, and any stock the assignment left
// in the options-only sandbox is only ever acted on when it matches the missing leg exactly (see the resolver).

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
	// Linked is true only when StockQty equals ImpliedStock exactly and is not zero: the stock is the assignment of this group.
	Linked   bool
	Mismatch string // stock present that does not match this group's gone legs
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

// EvaluateOptionGroup compares one live group with the broker's positions. A group with no open units is intact by
// definition (it owns nothing). An unreadable record is an error, never a guess.
func EvaluateOptionGroup(state database.OptionGroupState, positions []*interfaces.Position) (GroupFinding, error) {
	group := state.Group
	if group == nil {
		return GroupFinding{}, fmt.Errorf("option group is required")
	}
	finding := GroupFinding{GroupID: group.GroupID, Underlying: strings.ToUpper(strings.TrimSpace(group.Underlying)), Intact: true}
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
	if stock != 0 {
		if finding.ImpliedStock != 0 && math.Abs(stock-finding.ImpliedStock) < 1e-9 {
			finding.Linked = true
		} else {
			finding.Mismatch = fmt.Sprintf("stock position %.0f in %s does not match the %.0f shares implied by the missing legs", stock, finding.Underlying, finding.ImpliedStock)
		}
	}
	return finding, nil
}

// OptionGroupStore is the durable ledger the monitor and the resolver read and write.
type OptionGroupStore interface {
	OptionGroupStates() ([]database.OptionGroupState, error)
	SaveOptionGroup(group *models.DBOptionGroup) error
}

// OptionGroupReconcileReport is what one reconciliation pass found and recorded.
type OptionGroupReconcileReport struct {
	Findings           []GroupFinding // every non-intact group, newly or already broken
	NewlyBroken        []string       // groups marked broken in this pass
	ClosedWithoutStock []string       // broken groups with nothing left to resolve, closed in this pass
	NeedsResolver      []GroupFinding // broken groups whose stock matches the missing legs exactly
	Unresolved         []GroupFinding // broken groups with stock that does not match: left alone and reported
}

// ReconcileOptionGroups evaluates every live group against the broker positions and records the result durably:
//   - an intact group is untouched;
//   - a newly broken group is marked broken with its reason and its surviving legs are durably detached into ordinary
//     single-leg management (only then may that leg be closed on its own);
//   - a broken group with no stock to resolve is closed (nothing is left to resolve);
//   - a broken group whose stock matches its missing legs exactly is returned for the resolver;
//   - a broken group with stock that does not match, or no stock but a leg gone, is left broken and reported (never guessed at).
//
// It places no order. Spread entries stay refused for the sandbox while any group is broken.
func ReconcileOptionGroups(store OptionGroupStore, positions []*interfaces.Position) (OptionGroupReconcileReport, error) {
	var report OptionGroupReconcileReport
	states, err := store.OptionGroupStates()
	if err != nil {
		return report, err
	}
	for _, state := range states {
		finding, err := EvaluateOptionGroup(state, positions)
		if err != nil {
			return report, err
		}
		if finding.Intact {
			continue
		}
		group := state.Group
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
		case finding.StockQty == 0:
			// A leg is gone and no stock was left behind (expired worthless or closed outside OP2): the surviving legs are
			// already detached into single-leg management, so nothing is left to resolve.
			group.Status = "closed"
			if err := store.SaveOptionGroup(group); err != nil {
				return report, fmt.Errorf("failed to close resolved option group %s: %w", group.GroupID, err)
			}
			report.ClosedWithoutStock = append(report.ClosedWithoutStock, group.GroupID)
		default:
			report.Unresolved = append(report.Unresolved, finding)
		}
	}
	return report, nil
}
