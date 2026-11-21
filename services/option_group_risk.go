package services

import (
	"encoding/json"
	"fmt"
	"strings"

	"prophet-trader/database"
	"prophet-trader/interfaces"
)

// Phase C, Step 4: turning the durable group ledger into the risk view the policy reads.

// EncodeGroupLegs is the one encoding of a group's exact legs in the ledger.
func EncodeGroupLegs(legs []interfaces.OptionLeg) (string, error) {
	encoded, err := json.Marshal(legs)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func decodeGroupLegs(raw string) ([]interfaces.OptionLeg, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var legs []interfaces.OptionLeg
	if err := json.Unmarshal([]byte(raw), &legs); err != nil {
		return nil, err
	}
	return legs, nil
}

// OptionGroupRisksFromStates builds the policy's group view. The legs still attached to a group are its recorded legs
// minus any durably detached into ordinary single-leg management. The amount deployed is the group's maximum loss
// (net debit x open units x 100). A group with no filled units owns nothing yet, and an unreadable record fails closed.
func OptionGroupRisksFromStates(states []database.OptionGroupState) ([]OptionGroupRisk, error) {
	groups := make([]OptionGroupRisk, 0, len(states))
	for _, state := range states {
		group := state.Group
		if group == nil {
			continue
		}
		legs, err := decodeGroupLegs(group.LegsJSON)
		if err != nil {
			return nil, fmt.Errorf("option group %s has unreadable legs: %w", group.GroupID, err)
		}
		detached, err := decodeGroupLegs(group.DetachedLegsJSON)
		if err != nil {
			return nil, fmt.Errorf("option group %s has unreadable detached legs: %w", group.GroupID, err)
		}
		gone := map[string]bool{}
		for _, leg := range detached {
			gone[strings.ToUpper(strings.TrimSpace(leg.Symbol))] = true
		}
		symbols := make([]string, 0, len(legs))
		for _, leg := range legs {
			if !gone[strings.ToUpper(strings.TrimSpace(leg.Symbol))] {
				symbols = append(symbols, leg.Symbol)
			}
		}
		allocations := map[string]float64{}
		for _, leg := range legs {
			symbol := strings.ToUpper(strings.TrimSpace(leg.Symbol))
			if gone[symbol] {
				continue
			}
			allocations[symbol] += legExpectedQty(leg, state.OpenUnits)
		}
		groups = append(groups, OptionGroupRisk{
			ID:                 group.GroupID,
			LegSymbols:         symbols,
			OpenUnits:          state.OpenUnits,
			MaxLoss:            group.NetDebit * state.OpenUnits * 100,
			Broken:             group.Status == "broken",
			Closing:            state.PendingClose,
			StructureID:        group.Structure,
			LegAllocations:     allocations,
			ReservedCloseUnits: state.ReservedCloseUnits,
			EntryPending:       state.EntryPending,
		})
	}
	return groups, nil
}
