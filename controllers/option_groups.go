package controllers

import (
	"fmt"
	"strings"

	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"prophet-trader/services"
)

// Phase C, Step 4: the controller side of the durable multi-leg group ledger. A spread is recorded BEFORE its order is
// submitted (an entry creates its group, a close is added to its group), so a crash or restart can never leave a
// submitted spread unknown to the ledger. Single-leg orders never touch any of this.

type optionGroupStore interface {
	SaveOptionGroup(group *models.DBOptionGroup) error
	GetOptionGroup(groupID string) (*models.DBOptionGroup, error)
	AddOptionGroupCloseOrder(groupID, clientOrderID string) error
	OptionGroupStates() ([]database.OptionGroupState, error)
}

func (oc *OrderController) optionGroups() optionGroupStore {
	store, _ := oc.storageService.(optionGroupStore)
	return store
}

// registerSpreadBeforeSubmission records a multi-leg order on the group ledger. It returns the group id. A single-leg
// order returns "" and nothing changes. With no ledger available a spread is refused (fail closed).
func (oc *OrderController) registerSpreadBeforeSubmission(order *interfaces.OptionsOrder) (string, error) {
	if order == nil || len(order.Legs) == 0 {
		return "", nil
	}
	store := oc.optionGroups()
	if store == nil {
		return "", fmt.Errorf("multi-leg orders need the durable option group ledger, which is unavailable")
	}
	structure, err := services.ClassifyOptionsStructure(order)
	if err != nil {
		return "", err
	}
	opening := strings.HasSuffix(order.Legs[0].PositionIntent, "_to_open")
	if opening {
		if order.LimitPrice == nil || *order.LimitPrice <= 0 {
			return "", fmt.Errorf("a spread opening needs a positive net debit")
		}
		legs, err := services.EncodeGroupLegs(order.Legs)
		if err != nil {
			return "", err
		}
		group := &models.DBOptionGroup{
			GroupID: order.ClientOrderID, Underlying: strings.ToUpper(strings.TrimSpace(order.Underlying)), Structure: structure, Status: "pending_entry",
			LegsJSON: legs, EntryClientOrderID: order.ClientOrderID, EntryUnits: order.Qty, NetDebit: *order.LimitPrice,
		}
		if err := store.SaveOptionGroup(group); err != nil {
			return "", err
		}
		return group.GroupID, nil
	}
	states, err := store.OptionGroupStates()
	if err != nil {
		return "", err
	}
	risks, err := services.OptionGroupRisksFromStates(states)
	if err != nil {
		return "", err
	}
	for _, risk := range risks {
		if risk.OpenUnits <= 0 || risk.Broken || len(risk.LegSymbols) != len(order.Legs) {
			continue
		}
		matched := 0
		for _, leg := range order.Legs {
			for _, symbol := range risk.LegSymbols {
				if strings.EqualFold(symbol, leg.Symbol) {
					matched++
					break
				}
			}
		}
		if matched == len(order.Legs) {
			if err := store.AddOptionGroupCloseOrder(risk.ID, order.ClientOrderID); err != nil {
				return "", err
			}
			return risk.ID, nil
		}
	}
	return "", fmt.Errorf("spread close is not backed by an open spread group")
}

// finishSpreadEntry marks an entry's group after the submission outcome: open once the broker acknowledged it, void
// when the entry never crossed the broker boundary or was rejected. Failures to record are logged, never fatal: the
// derived open units, not the status, are what the risk view reads.
func (oc *OrderController) finishSpreadEntry(groupID string, order *interfaces.OptionsOrder, status string) {
	if groupID == "" || order == nil || len(order.Legs) == 0 || !strings.HasSuffix(order.Legs[0].PositionIntent, "_to_open") {
		return
	}
	store := oc.optionGroups()
	if store == nil {
		return
	}
	group, err := store.GetOptionGroup(groupID)
	if err != nil {
		oc.logger.WithError(err).Warn("Could not reload the option group to record the entry outcome")
		return
	}
	next := group.Status
	switch status {
	case "void":
		next = "void"
	case "open":
		next = "open"
	}
	if next == group.Status {
		return
	}
	group.Status = next
	if err := store.SaveOptionGroup(group); err != nil {
		oc.logger.WithError(err).Warn("Could not record the option group entry outcome")
	}
}

// optionLegsMatch compares the identity of two multi-leg orders: the same legs with the same side, intent and ratio.
// The per-leg price is not compared (the broker does not return one).
func optionLegsMatch(local, broker []interfaces.OptionLeg) bool {
	if len(local) == 0 || len(local) != len(broker) {
		return false
	}
	used := make([]bool, len(broker))
	for _, l := range local {
		found := false
		for i, b := range broker {
			if used[i] {
				continue
			}
			if strings.EqualFold(l.Symbol, b.Symbol) && l.Side == b.Side && l.PositionIntent == b.PositionIntent && l.RatioQty == b.RatioQty {
				used[i] = true
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
