package database

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"

	"gorm.io/gorm"

	"prophet-trader/models"
)

// Phase C, Step 4: the durable multi-leg group ledger. Every method is scoped to this storage's own durable execution
// identity (account, paper/live, tenant, sandbox); a record of another identity is never read or written. Every
// read-modify-write of a group runs under one process-wide lock, so a close registration, a resolver claim and a status
// change can never overwrite each other.

var groupWriteMu sync.Mutex

// ErrStaleOptionGroup is returned when a group save was built on an older revision than the stored one.
var ErrStaleOptionGroup = errors.New("stale option group revision")

// OptionGroupState is a group together with the quantities derived from the order ledger.
type OptionGroupState struct {
	Group        *models.DBOptionGroup
	EntryFilled  float64
	CloseFilled  float64
	OpenUnits    float64
	CloseOrders  []string
	PendingClose bool // a recorded close order is still working or uncertain
	// EntryPending: the entry order is missing, working, uncertain, or filled with no recorded quantity, so the ledger cannot yet
	// say whether the group owns its legs. A terminal entry with no fills (cancelled, rejected, expired) is not pending.
	EntryPending bool
	// ReservedCloseUnits is the unfilled quantity of recorded close orders that are still working or uncertain (a close recorded
	// but not yet persisted as an order reserves every open unit, its quantity being unknown). The close named by the exclude
	// argument is the candidate being evaluated and never reserves against itself.
	ReservedCloseUnits float64
}

var terminalOrderStatuses = map[string]bool{
	"filled": true, "canceled": true, "cancelled": true, "expired": true, "rejected": true, "rejected_before_submission": true, "done_for_day": true, "replaced": true,
}

func isTerminalOrderStatus(status string) bool {
	return terminalOrderStatuses[strings.ToLower(strings.TrimSpace(status))]
}

// SaveOptionGroup inserts a group or updates the existing one with the same group id. The identity is always the
// storage's own. An existing group's id, entry order, structure and legs can never be rewritten.
func (s *LocalStorage) SaveOptionGroup(group *models.DBOptionGroup) error {
	groupWriteMu.Lock()
	defer groupWriteMu.Unlock()
	return s.saveOptionGroupLocked(group)
}

func (s *LocalStorage) saveOptionGroupLocked(group *models.DBOptionGroup) error {
	if group == nil || strings.TrimSpace(group.GroupID) == "" {
		return fmt.Errorf("option group id is required")
	}
	if !durableIdentityComplete(s.identity) {
		return fmt.Errorf("storage has incomplete durable execution identity")
	}
	group.DurableIdentity = s.identity
	var existing models.DBOptionGroup
	err := s.identityQuery(s.db.Where("group_id = ?", group.GroupID)).First(&existing).Error
	if err == nil {
		if existing.EntryClientOrderID != group.EntryClientOrderID || existing.LegsJSON != group.LegsJSON || existing.Structure != group.Structure {
			return fmt.Errorf("option group %s is already recorded with different legs or entry order", group.GroupID)
		}
		// Compare-and-set: the caller must have read the current revision. A save built on an older read (a slower writer, or a
		// fresh object for an existing group) would otherwise overwrite the close registrations and the resolver claim that were
		// recorded since; it is refused and the caller reloads on its next pass.
		if group.Revision != existing.Revision {
			return fmt.Errorf("%w: option group %s is at revision %d, the save was built on revision %d", ErrStaleOptionGroup, group.GroupID, existing.Revision, group.Revision)
		}
		group.ID = existing.ID
		group.CreatedAt = existing.CreatedAt
		group.Revision = existing.Revision + 1
		return s.db.Save(group).Error
	}
	if err != gorm.ErrRecordNotFound {
		return fmt.Errorf("failed to read option group: %w", err)
	}
	group.Revision = 1
	return s.db.Create(group).Error
}

// GetOptionGroup returns one group of this identity.
func (s *LocalStorage) GetOptionGroup(groupID string) (*models.DBOptionGroup, error) {
	if !durableIdentityComplete(s.identity) {
		return nil, fmt.Errorf("storage has incomplete durable execution identity")
	}
	var group models.DBOptionGroup
	if err := s.identityQuery(s.db.Where("group_id = ?", groupID)).First(&group).Error; err != nil {
		return nil, err
	}
	return &group, nil
}

// ListOptionGroups returns this identity's groups, optionally limited to the given statuses.
func (s *LocalStorage) ListOptionGroups(statuses ...string) ([]*models.DBOptionGroup, error) {
	if !durableIdentityComplete(s.identity) {
		return nil, fmt.Errorf("storage has incomplete durable execution identity")
	}
	var groups []*models.DBOptionGroup
	query := s.identityQuery(s.db.Model(&models.DBOptionGroup{}))
	if len(statuses) > 0 {
		query = query.Where("status IN ?", statuses)
	}
	if err := query.Order("created_at ASC").Find(&groups).Error; err != nil {
		return nil, fmt.Errorf("failed to list option groups: %w", err)
	}
	return groups, nil
}

// AddOptionGroupCloseOrder records a close order's client id on its group before the order is submitted, so its fills
// are always subtracted from the group's open units and its quantity is reserved. It is idempotent and atomic.
func (s *LocalStorage) AddOptionGroupCloseOrder(groupID, clientOrderID string) error {
	groupWriteMu.Lock()
	defer groupWriteMu.Unlock()
	group, err := s.GetOptionGroup(groupID)
	if err != nil {
		return fmt.Errorf("option group %s: %w", groupID, err)
	}
	var ids []string
	if group.CloseClientOrderIDs != "" {
		if err := json.Unmarshal([]byte(group.CloseClientOrderIDs), &ids); err != nil {
			return fmt.Errorf("option group %s has unreadable close orders: %w", groupID, err)
		}
	}
	for _, id := range ids {
		if id == clientOrderID {
			return nil
		}
	}
	ids = append(ids, clientOrderID)
	encoded, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	group.CloseClientOrderIDs = string(encoded)
	group.Revision++
	return s.db.Save(group).Error
}

// ClaimResolverOperation makes groupID's resolver order clientID the one durable operation for its underlying: it succeeds
// only when no other group on the same underlying (any status) has a resolver order that is missing, working or uncertain.
// It is one atomic step under the group write lock; on a refusal it returns the owning client order id.
func (s *LocalStorage) ClaimResolverOperation(groupID, clientID string) (bool, string, error) {
	groupWriteMu.Lock()
	defer groupWriteMu.Unlock()
	group, err := s.GetOptionGroup(groupID)
	if err != nil {
		return false, "", fmt.Errorf("option group %s: %w", groupID, err)
	}
	if group.ResolverClientID == clientID {
		return true, "", nil
	}
	others, err := s.ListOptionGroups()
	if err != nil {
		return false, "", err
	}
	for _, other := range others {
		if other.GroupID == groupID || other.ResolverClientID == "" || !strings.EqualFold(other.Underlying, group.Underlying) {
			continue
		}
		var order models.DBOrder
		err := s.identityQuery(s.db.Where("client_order_id = ?", other.ResolverClientID)).First(&order).Error
		if err == gorm.ErrRecordNotFound || (err == nil && !isTerminalOrderStatus(order.Status)) {
			return false, other.ResolverClientID, nil
		}
		if err != nil {
			return false, "", fmt.Errorf("failed to read resolver order %s: %w", other.ResolverClientID, err)
		}
	}
	group.ResolverClientID = clientID
	group.Revision++
	if err := s.db.Save(group).Error; err != nil {
		return false, "", err
	}
	return true, "", nil
}

// OptionGroupStates returns the non-terminal groups of this identity with units derived from the order ledger:
// open units = the entry order's filled quantity - the filled quantity of every recorded close order (never below zero).
func (s *LocalStorage) OptionGroupStates() ([]OptionGroupState, error) {
	return s.OptionGroupStatesExcluding("")
}

// OptionGroupStatesExcluding is OptionGroupStates for evaluating one candidate close: that order's own registration never
// reserves units against itself.
func (s *LocalStorage) OptionGroupStatesExcluding(exclude string) ([]OptionGroupState, error) {
	groups, err := s.ListOptionGroups("pending_entry", "open", "broken")
	if err != nil {
		return nil, err
	}
	states := make([]OptionGroupState, 0, len(groups))
	for _, group := range groups {
		state := OptionGroupState{Group: group}
		if group.EntryClientOrderID != "" {
			var entry models.DBOrder
			if err := s.identityQuery(s.db.Where("client_order_id = ?", group.EntryClientOrderID)).First(&entry).Error; err == nil {
				state.EntryFilled = entry.FilledQty
				// Not yet reconciled: the entry may still fill (or already has at the broker) without the ledger knowing.
				state.EntryPending = !isTerminalOrderStatus(entry.Status) || (strings.EqualFold(strings.TrimSpace(entry.Status), "filled") && entry.FilledQty <= 0)
			} else if err == gorm.ErrRecordNotFound {
				state.EntryPending = group.Status == "pending_entry" || group.Status == "open"
			} else {
				return nil, fmt.Errorf("failed to read entry order of group %s: %w", group.GroupID, err)
			}
		}
		if group.CloseClientOrderIDs != "" {
			if err := json.Unmarshal([]byte(group.CloseClientOrderIDs), &state.CloseOrders); err != nil {
				return nil, fmt.Errorf("option group %s has unreadable close orders: %w", group.GroupID, err)
			}
		}
		openBeforeReservation := 0.0
		type pendingClose struct {
			id       string
			unfilled float64
			unknown  bool
		}
		var pending []pendingClose
		for _, id := range state.CloseOrders {
			var closeOrder models.DBOrder
			err := s.identityQuery(s.db.Where("client_order_id = ?", id)).First(&closeOrder).Error
			if err == gorm.ErrRecordNotFound {
				// Recorded before submission and not yet persisted as an order: treated as working so nothing is double counted.
				state.PendingClose = true
				pending = append(pending, pendingClose{id: id, unknown: true})
				continue
			}
			if err != nil {
				return nil, fmt.Errorf("failed to read close order %s of group %s: %w", id, group.GroupID, err)
			}
			state.CloseFilled += closeOrder.FilledQty
			if !isTerminalOrderStatus(closeOrder.Status) {
				state.PendingClose = true
				pending = append(pending, pendingClose{id: id, unfilled: math.Max(0, closeOrder.Qty-closeOrder.FilledQty)})
			}
		}
		state.OpenUnits = math.Max(0, state.EntryFilled-state.CloseFilled)
		openBeforeReservation = state.OpenUnits
		for _, p := range pending {
			if p.id == exclude {
				continue
			}
			if p.unknown {
				state.ReservedCloseUnits += openBeforeReservation
			} else {
				state.ReservedCloseUnits += p.unfilled
			}
		}
		state.ReservedCloseUnits = math.Min(state.ReservedCloseUnits, openBeforeReservation)
		states = append(states, state)
	}
	return states, nil
}
