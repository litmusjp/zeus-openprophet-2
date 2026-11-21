package database

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"gorm.io/gorm"

	"prophet-trader/models"
)

// Phase C, Step 4: the durable multi-leg group ledger. Every method is scoped to this storage's own durable execution
// identity (account, paper/live, tenant, sandbox); a record of another identity is never read or written.

// OptionGroupState is a group together with the quantities derived from the order ledger.
type OptionGroupState struct {
	Group        *models.DBOptionGroup
	EntryFilled  float64
	CloseFilled  float64
	OpenUnits    float64
	CloseOrders  []string
	PendingClose bool // a recorded close order is still working or uncertain
}

// SaveOptionGroup inserts a group or updates the existing one with the same group id. The identity is always the
// storage's own. An existing group's id, entry order, structure and legs can never be rewritten.
func (s *LocalStorage) SaveOptionGroup(group *models.DBOptionGroup) error {
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
// are always subtracted from the group's open units. It is idempotent.
func (s *LocalStorage) AddOptionGroupCloseOrder(groupID, clientOrderID string) error {
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

// OptionGroupStates returns the non-terminal groups of this identity with units derived from the order ledger:
// open units = the entry order's filled quantity - the filled quantity of every recorded close order (never below zero).
func (s *LocalStorage) OptionGroupStates() ([]OptionGroupState, error) {
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
			} else if err != gorm.ErrRecordNotFound {
				return nil, fmt.Errorf("failed to read entry order of group %s: %w", group.GroupID, err)
			}
		}
		if group.CloseClientOrderIDs != "" {
			if err := json.Unmarshal([]byte(group.CloseClientOrderIDs), &state.CloseOrders); err != nil {
				return nil, fmt.Errorf("option group %s has unreadable close orders: %w", group.GroupID, err)
			}
		}
		for _, id := range state.CloseOrders {
			var closeOrder models.DBOrder
			err := s.identityQuery(s.db.Where("client_order_id = ?", id)).First(&closeOrder).Error
			if err == gorm.ErrRecordNotFound {
				// Recorded before submission and not yet persisted as an order: treat as working so nothing is double counted.
				state.PendingClose = true
				continue
			}
			if err != nil {
				return nil, fmt.Errorf("failed to read close order %s of group %s: %w", id, group.GroupID, err)
			}
			state.CloseFilled += closeOrder.FilledQty
			switch strings.ToLower(closeOrder.Status) {
			case "filled", "canceled", "cancelled", "expired", "rejected", "rejected_before_submission", "done_for_day", "replaced":
			default:
				state.PendingClose = true
			}
		}
		state.OpenUnits = math.Max(0, state.EntryFilled-state.CloseFilled)
		states = append(states, state)
	}
	return states, nil
}
