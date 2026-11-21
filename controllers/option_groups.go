package controllers

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"

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

// GetOptionGroups is the read-only status of this sandbox's live multi-leg groups (Phase C): what is open, what is
// broken and why, and which resolver operation owns any linked stock. It changes nothing and places no order.
func (oc *OrderController) GetOptionGroups(c *gin.Context) {
	store := oc.optionGroups()
	if store == nil {
		c.JSON(503, gin.H{"status": "unavailable", "error": "the durable option group ledger is unavailable"})
		return
	}
	states, err := store.OptionGroupStates()
	if err != nil {
		c.JSON(500, gin.H{"status": "error", "error": err.Error()})
		return
	}
	groups := make([]gin.H, 0, len(states))
	advisories := []string{}
	broken := 0
	for _, state := range states {
		g := state.Group
		if g.Status == "broken" {
			broken++
		}
		if g.Advisory != "" {
			advisories = append(advisories, g.GroupID+": "+g.Advisory)
		}
		var legs []interfaces.OptionLeg
		_ = json.Unmarshal([]byte(g.LegsJSON), &legs)
		groups = append(groups, gin.H{
			"group_id": g.GroupID, "underlying": g.Underlying, "structure": g.Structure, "status": g.Status,
			"legs": legs, "entry_units": g.EntryUnits, "entry_filled_units": state.EntryFilled, "closed_units": state.CloseFilled, "open_units": state.OpenUnits,
			"net_debit_per_unit": g.NetDebit, "close_order_client_ids": state.CloseOrders, "close_order_pending": state.PendingClose,
			"broken_reason": g.BrokenReason, "resolver_client_order_id": g.ResolverClientID, "advisory": g.Advisory,
		})
	}
	note := "A spread is closed as one order with both legs. One leg of an open group cannot be closed on its own."
	if broken > 0 {
		note = "A group is broken: new spread entries are refused for this sandbox until it is resolved; single-leg trading continues; the backend resolves linked assignment stock on its own and leaves anything it cannot match exactly alone."
	}
	c.JSON(200, gin.H{"status": "ok", "groups": groups, "broken_groups": broken, "advisories": advisories, "note": note})
}
