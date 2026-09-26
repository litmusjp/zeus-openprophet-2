package database

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func encodeOptionLegs(legs []interfaces.OptionLeg) (string, error) {
	if len(legs) == 0 {
		return "", nil
	}
	b, err := json.Marshal(legs)
	return string(b), err
}

func decodeOptionLegs(raw string) ([]interfaces.OptionLeg, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var legs []interfaces.OptionLeg
	if err := json.Unmarshal([]byte(raw), &legs); err != nil {
		return nil, err
	}
	return legs, nil
}

// LocalStorage implements the StorageService interface using SQLite
type LocalStorage struct {
	db       *gorm.DB
	logger   *logrus.Logger
	identity models.DurableIdentity
}

func durableIdentityComplete(identity models.DurableIdentity) bool {
	return strings.TrimSpace(identity.BrokerAccountID) != "" &&
		(identity.PaperLive == "paper" || identity.PaperLive == "live") &&
		strings.TrimSpace(identity.TenantID) != "" &&
		strings.TrimSpace(identity.SandboxID) != ""
}

func durableIdentityMatches(existing models.DurableIdentity, current models.DurableIdentity) bool {
	return existing.BrokerAccountID == current.BrokerAccountID && existing.PaperLive == current.PaperLive && existing.TenantID == current.TenantID && existing.SandboxID == current.SandboxID
}

func (s *LocalStorage) requireCurrentIdentity(identity models.DurableIdentity) error {
	if !durableIdentityComplete(s.identity) {
		return fmt.Errorf("storage has incomplete durable execution identity")
	}
	if !durableIdentityComplete(identity) || !durableIdentityMatches(identity, s.identity) {
		return fmt.Errorf("record belongs to a different or incomplete durable execution identity")
	}
	return nil
}

func (s *LocalStorage) identityQuery(query *gorm.DB) *gorm.DB {
	return query.Where("broker_account_id = ? AND paper_live = ? AND tenant_id = ? AND sandbox_id = ?", s.identity.BrokerAccountID, s.identity.PaperLive, s.identity.TenantID, s.identity.SandboxID)
}

func runtimeDurableIdentity() models.DurableIdentity {
	paperLive := ""
	if value, ok := os.LookupEnv("ALPACA_PAPER"); ok {
		if strings.EqualFold(value, "true") {
			paperLive = "paper"
		} else if strings.EqualFold(value, "false") {
			paperLive = "live"
		}
	}
	return models.DurableIdentity{
		BrokerAccountID: strings.TrimSpace(os.Getenv("ALPACA_ACCOUNT_ID")),
		PaperLive:       paperLive,
		TenantID:        strings.TrimSpace(os.Getenv("OPENPROPHET_TENANT_ID")),
		SandboxID:       strings.TrimSpace(os.Getenv("OPENPROPHET_SANDBOX_ID")),
	}
}

// NewLocalStorage creates a new local storage service
func newLocalStorage(dbPath string, readOnly bool) (*LocalStorage, error) {
	// Ensure the directory exists only for execution-capable startup.
	dir := filepath.Dir(dbPath)
	if !readOnly {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create database directory: %w", err)
		}
	}

	// Open SQLite database. Inert mode must never create or migrate storage.
	dsn := dbPath
	if readOnly {
		dsn = "file:" + filepath.ToSlash(dbPath) + "?mode=ro"
	}
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if !readOnly {
		// Auto-migrate schemas
		if err := db.AutoMigrate(
			&models.DBOrder{},
			&models.DBBar{},
			&models.DBPosition{},
			&models.DBTrade{},
			&models.DBAccountSnapshot{},
			&models.DBSignal{},
			&models.DBManagedOrder{},
			&models.DBManagedPosition{},
		); err != nil {
			return nil, fmt.Errorf("failed to migrate database: %w", err)
		}
		if db.Migrator().HasIndex(&models.DBPosition{}, "idx_positions_symbol") {
			if err := db.Migrator().DropIndex(&models.DBPosition{}, "idx_positions_symbol"); err != nil {
				return nil, fmt.Errorf("failed to migrate position symbol index: %w", err)
			}
		}
		if db.Migrator().HasIndex(&models.DBOrder{}, "idx_orders_order_id") {
			if err := db.Migrator().DropIndex(&models.DBOrder{}, "idx_orders_order_id"); err != nil {
				return nil, fmt.Errorf("failed to migrate order ID index: %w", err)
			}
			if err := db.Migrator().CreateIndex(&models.DBOrder{}, "OrderID"); err != nil {
				return nil, fmt.Errorf("failed to migrate order ID index: %w", err)
			}
		}
	}

	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	return &LocalStorage{
		db:       db,
		logger:   logger,
		identity: runtimeDurableIdentity(),
	}, nil
}

// NewLocalStorage creates or migrates an execution-capable local store.
func NewLocalStorage(dbPath string) (*LocalStorage, error) {
	return newLocalStorage(dbPath, false)
}

// NewReadOnlyStorage opens an existing store without creating or migrating it.
func NewReadOnlyStorage(dbPath string) (*LocalStorage, error) {
	return newLocalStorage(dbPath, true)
}

// DurableIdentity returns the server-owned execution identity bound to this store.
func (s *LocalStorage) DurableIdentity() models.DurableIdentity {
	return s.identity
}

// SaveBars saves multiple bars to the database
func (s *LocalStorage) SaveBars(bars []*interfaces.Bar) error {
	if len(bars) == 0 {
		return nil
	}

	s.logger.WithField("count", len(bars)).Info("Saving bars to database")

	// Convert interface bars to DB bars
	dbBars := make([]*models.DBBar, len(bars))
	for i, bar := range bars {
		dbBars[i] = &models.DBBar{
			Symbol:    bar.Symbol,
			Timestamp: bar.Timestamp,
			Open:      bar.Open,
			High:      bar.High,
			Low:       bar.Low,
			Close:     bar.Close,
			Volume:    bar.Volume,
			VWAP:      bar.VWAP,
		}
	}

	// Batch insert with upsert on conflict
	result := s.db.Create(&dbBars)
	if result.Error != nil {
		return fmt.Errorf("failed to save bars: %w", result.Error)
	}

	s.logger.WithField("saved", result.RowsAffected).Info("Bars saved successfully")
	return nil
}

// GetBars retrieves bars for a symbol within a time range
func (s *LocalStorage) GetBars(symbol string, start, end time.Time) ([]*interfaces.Bar, error) {
	var dbBars []*models.DBBar

	result := s.db.Where("symbol = ? AND timestamp >= ? AND timestamp <= ?", symbol, start, end).
		Order("timestamp ASC").
		Find(&dbBars)

	if result.Error != nil {
		return nil, fmt.Errorf("failed to get bars: %w", result.Error)
	}

	// Convert DB bars to interface bars
	bars := make([]*interfaces.Bar, len(dbBars))
	for i, dbBar := range dbBars {
		bars[i] = &interfaces.Bar{
			Symbol:    dbBar.Symbol,
			Timestamp: dbBar.Timestamp,
			Open:      dbBar.Open,
			High:      dbBar.High,
			Low:       dbBar.Low,
			Close:     dbBar.Close,
			Volume:    dbBar.Volume,
			VWAP:      dbBar.VWAP,
		}
	}

	return bars, nil
}

// SaveOrder saves an order to the database
// clientOrderIDPtr returns nil for an empty client order id so it is stored as SQL NULL
// (SQLite allows many NULLs under a unique index; only non-empty ids must be unique).
func clientOrderIDPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func sameOptionalFloat(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return math.Abs(*left-*right) <= 1e-9
}

func terminalOrderStatus(status string) bool {
	switch status {
	case "filled", "canceled", "cancelled", "rejected", "expired", "done_for_day", "replaced":
		return true
	default:
		return false
	}
}

func orderIdentityMatchesDB(existing *models.DBOrder, incoming *interfaces.Order) bool {
	return existing.Symbol == incoming.Symbol && existing.Qty == incoming.Qty && existing.Side == incoming.Side &&
		existing.Type == incoming.Type && existing.TimeInForce == incoming.TimeInForce &&
		sameOptionalFloat(existing.LimitPrice, incoming.LimitPrice) && sameOptionalFloat(existing.StopPrice, incoming.StopPrice) &&
		existing.AssetClass == incoming.AssetClass && existing.Underlying == incoming.Underlying &&
		existing.PositionIntent == incoming.PositionIntent && existing.Purpose == incoming.Purpose && existing.OptionLegsJSON == func() string { value, _ := encodeOptionLegs(incoming.OptionLegs); return value }()
}

func (s *LocalStorage) SaveOrder(order *interfaces.Order) error {
	if order == nil {
		return fmt.Errorf("order is required")
	}
	if !durableIdentityComplete(s.identity) {
		return fmt.Errorf("storage has incomplete durable execution identity")
	}
	callerIdentity := models.DurableIdentity{BrokerAccountID: order.BrokerAccountID, PaperLive: order.PaperLive, TenantID: order.TenantID, SandboxID: order.SandboxID}
	if (order.BrokerAccountID != "" || order.PaperLive != "" || order.TenantID != "" || order.SandboxID != "") && !durableIdentityMatches(callerIdentity, s.identity) {
		return fmt.Errorf("order durable identity does not match storage identity")
	}
	identity := s.identity
	dbOrder := &models.DBOrder{
		DurableIdentity:     identity,
		OrderID:             order.ID,
		ClientOrderID:       clientOrderIDPtr(order.ClientOrderID),
		Symbol:              order.Symbol,
		Qty:                 order.Qty,
		Side:                order.Side,
		Type:                order.Type,
		TimeInForce:         order.TimeInForce,
		LimitPrice:          order.LimitPrice,
		StopPrice:           order.StopPrice,
		Status:              order.Status,
		FilledQty:           order.FilledQty,
		FilledAvgPrice:      order.FilledAvgPrice,
		SubmittedAt:         order.SubmittedAt,
		FilledAt:            order.FilledAt,
		CanceledAt:          order.CanceledAt,
		ReplacedBy:          order.ReplacedBy,
		AssetClass:          order.AssetClass,
		Underlying:          order.Underlying,
		PositionIntent:      order.PositionIntent,
		Purpose:             order.Purpose,
		NextEligibleAt:      order.NextEligibleAt,
		ExpiresAt:           order.ExpiresAt,
		Revision:            order.Revision,
		SubmissionAttempted: order.SubmissionAttempted,
		Metadata:            order.Metadata,
	}
	var legsErr error
	dbOrder.OptionLegsJSON, legsErr = encodeOptionLegs(order.OptionLegs)
	if legsErr != nil {
		return fmt.Errorf("encode options leg identity: %w", legsErr)
	}

	var existingRevision int64
	var existingID uint
	if order.ClientOrderID != "" {
		var existing models.DBOrder
		lookupErr := s.db.Where("client_order_id = ?", order.ClientOrderID).First(&existing).Error
		if lookupErr == nil {
			if !durableIdentityMatches(existing.DurableIdentity, s.identity) {
				return fmt.Errorf("client order ID %q belongs to a different durable execution identity", order.ClientOrderID)
			}
			if !orderIdentityMatchesDB(&existing, order) {
				return fmt.Errorf("client order ID %q is already bound to different order parameters", order.ClientOrderID)
			}
			if existing.OrderID != "" && order.ID != "" && existing.OrderID != order.ID {
				return fmt.Errorf("client order ID %q is already bound to broker order ID %q", order.ClientOrderID, existing.OrderID)
			}
			if order.Revision != existing.Revision {
				return fmt.Errorf("stale lifecycle revision for client order ID %q", order.ClientOrderID)
			}
			if terminalOrderStatus(existing.Status) && terminalOrderStatus(dbOrder.Status) && existing.Status != dbOrder.Status && dbOrder.FilledQty <= existing.FilledQty {
				return fmt.Errorf("non-monotonic terminal lifecycle update for client order ID %q", order.ClientOrderID)
			}
			if dbOrder.OrderID == "" {
				dbOrder.OrderID = existing.OrderID
			}
			if existing.SubmissionAttempted {
				dbOrder.SubmissionAttempted = true
			}
			if existing.FilledQty > dbOrder.FilledQty {
				dbOrder.FilledQty = existing.FilledQty
				dbOrder.FilledAvgPrice = existing.FilledAvgPrice
				dbOrder.FilledAt = existing.FilledAt
			}
			if terminalOrderStatus(existing.Status) && !terminalOrderStatus(dbOrder.Status) {
				dbOrder.Status = existing.Status
				dbOrder.CanceledAt = existing.CanceledAt
			}
			dbOrder.ID = existing.ID
			existingID = existing.ID
			existingRevision = existing.Revision
			dbOrder.Revision = existing.Revision + 1
		} else if !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
			return fmt.Errorf("failed to load existing order identity: %w", lookupErr)
		} else {
			dbOrder.Revision = 1
		}
	}
	query := s.db
	if dbOrder.Revision == 0 {
		dbOrder.Revision = 1
	}
	if existingID != 0 {
		query = query.Where("id = ? AND revision = ?", existingID, existingRevision)
	} else if order.ClientOrderID == "" && order.ID != "" {
		var existing models.DBOrder
		if err := s.db.Where("order_id = ?", order.ID).First(&existing).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return fmt.Errorf("failed to find existing order: %w", err)
			}
		} else {
			if !durableIdentityMatches(existing.DurableIdentity, s.identity) {
				return fmt.Errorf("broker order ID %q belongs to a different durable execution identity", order.ID)
			}
			if order.Revision != existing.Revision {
				return fmt.Errorf("stale lifecycle revision for broker order ID %q", order.ID)
			}
			dbOrder.ID = existing.ID
			existingID = existing.ID
			existingRevision = existing.Revision
			dbOrder.Revision = existing.Revision + 1
		}
	}

	result := query.Save(dbOrder)
	if result.Error != nil {
		return fmt.Errorf("failed to save order: %w", result.Error)
	}
	if existingID != 0 && result.RowsAffected != 1 {
		return fmt.Errorf("stale lifecycle revision for client order ID %q", order.ClientOrderID)
	}
	order.Revision = dbOrder.Revision

	return nil
}

// GetOrder retrieves an order by ID
func (s *LocalStorage) GetOrder(orderID string) (*interfaces.Order, error) {
	if !durableIdentityComplete(s.identity) {
		return nil, fmt.Errorf("storage has incomplete durable execution identity")
	}
	var dbOrder models.DBOrder

	result := s.identityQuery(s.db.Where("order_id = ?", orderID)).First(&dbOrder)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get order: %w", result.Error)
	}
	optionLegs, err := decodeOptionLegs(dbOrder.OptionLegsJSON)
	if err != nil {
		return nil, fmt.Errorf("stored options leg identity is malformed: %w", err)
	}

	return &interfaces.Order{
		BrokerAccountID:     dbOrder.BrokerAccountID,
		PaperLive:           dbOrder.PaperLive,
		TenantID:            dbOrder.TenantID,
		SandboxID:           dbOrder.SandboxID,
		ID:                  dbOrder.OrderID,
		ClientOrderID:       derefStr(dbOrder.ClientOrderID),
		Symbol:              dbOrder.Symbol,
		Qty:                 dbOrder.Qty,
		Side:                dbOrder.Side,
		Type:                dbOrder.Type,
		TimeInForce:         dbOrder.TimeInForce,
		LimitPrice:          dbOrder.LimitPrice,
		StopPrice:           dbOrder.StopPrice,
		Status:              dbOrder.Status,
		FilledQty:           dbOrder.FilledQty,
		FilledAvgPrice:      dbOrder.FilledAvgPrice,
		SubmittedAt:         dbOrder.SubmittedAt,
		FilledAt:            dbOrder.FilledAt,
		CanceledAt:          dbOrder.CanceledAt,
		ReplacedBy:          dbOrder.ReplacedBy,
		AssetClass:          dbOrder.AssetClass,
		Underlying:          dbOrder.Underlying,
		PositionIntent:      dbOrder.PositionIntent,
		Purpose:             dbOrder.Purpose,
		NextEligibleAt:      dbOrder.NextEligibleAt,
		ExpiresAt:           dbOrder.ExpiresAt,
		Revision:            dbOrder.Revision,
		SubmissionAttempted: dbOrder.SubmissionAttempted,
		Metadata:            dbOrder.Metadata,
		OptionLegs:          optionLegs,
	}, nil
}

// GetOrderByClientOrderID retrieves a local order intent by its stable client identity.
func (s *LocalStorage) GetOrderByClientOrderID(clientOrderID string) (*interfaces.Order, error) {
	if !durableIdentityComplete(s.identity) {
		return nil, fmt.Errorf("storage has incomplete durable execution identity")
	}
	if clientOrderID == "" {
		return nil, fmt.Errorf("client order ID is required")
	}
	var dbOrder models.DBOrder
	if err := s.identityQuery(s.db.Where("client_order_id = ?", clientOrderID)).First(&dbOrder).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get order by client order ID: %w", err)
	}
	optionLegs, err := decodeOptionLegs(dbOrder.OptionLegsJSON)
	if err != nil {
		return nil, fmt.Errorf("stored options leg identity is malformed: %w", err)
	}
	return &interfaces.Order{
		BrokerAccountID:     dbOrder.BrokerAccountID,
		PaperLive:           dbOrder.PaperLive,
		TenantID:            dbOrder.TenantID,
		SandboxID:           dbOrder.SandboxID,
		ID:                  dbOrder.OrderID,
		ClientOrderID:       derefStr(dbOrder.ClientOrderID),
		Symbol:              dbOrder.Symbol,
		Qty:                 dbOrder.Qty,
		Side:                dbOrder.Side,
		Type:                dbOrder.Type,
		TimeInForce:         dbOrder.TimeInForce,
		LimitPrice:          dbOrder.LimitPrice,
		StopPrice:           dbOrder.StopPrice,
		Status:              dbOrder.Status,
		FilledQty:           dbOrder.FilledQty,
		FilledAvgPrice:      dbOrder.FilledAvgPrice,
		SubmittedAt:         dbOrder.SubmittedAt,
		FilledAt:            dbOrder.FilledAt,
		CanceledAt:          dbOrder.CanceledAt,
		ReplacedBy:          dbOrder.ReplacedBy,
		AssetClass:          dbOrder.AssetClass,
		Underlying:          dbOrder.Underlying,
		PositionIntent:      dbOrder.PositionIntent,
		Purpose:             dbOrder.Purpose,
		NextEligibleAt:      dbOrder.NextEligibleAt,
		ExpiresAt:           dbOrder.ExpiresAt,
		Revision:            dbOrder.Revision,
		SubmissionAttempted: dbOrder.SubmissionAttempted,
		Metadata:            dbOrder.Metadata,
		OptionLegs:          optionLegs,
	}, nil
}

// GetOrders retrieves orders by status
func (s *LocalStorage) GetOrders(status string) ([]*interfaces.Order, error) {
	if !durableIdentityComplete(s.identity) {
		return nil, fmt.Errorf("storage has incomplete durable execution identity")
	}
	var dbOrders []*models.DBOrder

	query := s.identityQuery(s.db.Model(&models.DBOrder{}))
	if status != "" {
		query = query.Where("status = ?", status)
	}

	result := query.Order("submitted_at DESC").Find(&dbOrders)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get orders: %w", result.Error)
	}

	orders := make([]*interfaces.Order, len(dbOrders))
	for i, dbOrder := range dbOrders {
		optionLegs, err := decodeOptionLegs(dbOrder.OptionLegsJSON)
		if err != nil {
			return nil, fmt.Errorf("stored options leg identity is malformed: %w", err)
		}
		orders[i] = &interfaces.Order{
			BrokerAccountID:     dbOrder.BrokerAccountID,
			PaperLive:           dbOrder.PaperLive,
			TenantID:            dbOrder.TenantID,
			SandboxID:           dbOrder.SandboxID,
			ID:                  dbOrder.OrderID,
			ClientOrderID:       derefStr(dbOrder.ClientOrderID),
			Symbol:              dbOrder.Symbol,
			Qty:                 dbOrder.Qty,
			Side:                dbOrder.Side,
			Type:                dbOrder.Type,
			TimeInForce:         dbOrder.TimeInForce,
			LimitPrice:          dbOrder.LimitPrice,
			StopPrice:           dbOrder.StopPrice,
			Status:              dbOrder.Status,
			FilledQty:           dbOrder.FilledQty,
			FilledAvgPrice:      dbOrder.FilledAvgPrice,
			SubmittedAt:         dbOrder.SubmittedAt,
			FilledAt:            dbOrder.FilledAt,
			CanceledAt:          dbOrder.CanceledAt,
			AssetClass:          dbOrder.AssetClass,
			Underlying:          dbOrder.Underlying,
			PositionIntent:      dbOrder.PositionIntent,
			Purpose:             dbOrder.Purpose,
			NextEligibleAt:      dbOrder.NextEligibleAt,
			ExpiresAt:           dbOrder.ExpiresAt,
			Revision:            dbOrder.Revision,
			SubmissionAttempted: dbOrder.SubmissionAttempted,
			Metadata:            dbOrder.Metadata,
			OptionLegs:          optionLegs,
		}
	}

	return orders, nil
}

// GetOrdersNeedingReconciliation retrieves submitted orders whose broker result is unknown.
func (s *LocalStorage) GetOrdersNeedingReconciliation() ([]*interfaces.Order, error) {
	if !durableIdentityComplete(s.identity) {
		return nil, fmt.Errorf("storage has incomplete durable execution identity")
	}
	var dbOrders []*models.DBOrder

	result := s.identityQuery(s.db.Where("(status IN ? AND status != ?) OR (status = ? AND submission_attempted = ?)", []string{"pending", "pending_new", "new", "accepted", "open", "partially_filled", "submission_uncertain"}, "submit_failed", "submit_failed", true)).
		Order("submitted_at DESC").
		Find(&dbOrders)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get orders needing reconciliation: %w", result.Error)
	}

	orders := make([]*interfaces.Order, len(dbOrders))
	for i, dbOrder := range dbOrders {
		optionLegs, err := decodeOptionLegs(dbOrder.OptionLegsJSON)
		if err != nil {
			return nil, fmt.Errorf("stored options leg identity is malformed: %w", err)
		}
		orders[i] = &interfaces.Order{
			BrokerAccountID:     dbOrder.BrokerAccountID,
			PaperLive:           dbOrder.PaperLive,
			TenantID:            dbOrder.TenantID,
			SandboxID:           dbOrder.SandboxID,
			ID:                  dbOrder.OrderID,
			ClientOrderID:       derefStr(dbOrder.ClientOrderID),
			Symbol:              dbOrder.Symbol,
			Qty:                 dbOrder.Qty,
			Side:                dbOrder.Side,
			Type:                dbOrder.Type,
			TimeInForce:         dbOrder.TimeInForce,
			LimitPrice:          dbOrder.LimitPrice,
			StopPrice:           dbOrder.StopPrice,
			Status:              dbOrder.Status,
			FilledQty:           dbOrder.FilledQty,
			FilledAvgPrice:      dbOrder.FilledAvgPrice,
			SubmittedAt:         dbOrder.SubmittedAt,
			FilledAt:            dbOrder.FilledAt,
			CanceledAt:          dbOrder.CanceledAt,
			AssetClass:          dbOrder.AssetClass,
			Underlying:          dbOrder.Underlying,
			PositionIntent:      dbOrder.PositionIntent,
			Purpose:             dbOrder.Purpose,
			NextEligibleAt:      dbOrder.NextEligibleAt,
			ExpiresAt:           dbOrder.ExpiresAt,
			Revision:            dbOrder.Revision,
			SubmissionAttempted: dbOrder.SubmissionAttempted,
			OptionLegs:          optionLegs,
		}
	}

	return orders, nil
}

// CleanupOldData removes data older than the specified time
func (s *LocalStorage) CleanupOldData(before time.Time) error {
	s.logger.WithField("before", before).Info("Cleaning up old data")

	// Delete old bars
	if err := s.db.Where("timestamp < ?", before).Delete(&models.DBBar{}).Error; err != nil {
		return fmt.Errorf("failed to delete old bars: %w", err)
	}

	// Delete old account snapshots
	if err := s.db.Where("snapshot_time < ?", before).Delete(&models.DBAccountSnapshot{}).Error; err != nil {
		return fmt.Errorf("failed to delete old snapshots: %w", err)
	}

	// Delete old signals
	if err := s.db.Where("created_at < ?", before).Delete(&models.DBSignal{}).Error; err != nil {
		return fmt.Errorf("failed to delete old signals: %w", err)
	}

	s.logger.Info("Old data cleaned up successfully")
	return nil
}

// Additional helper methods

// SaveManagedOrder persists one role-specific managed-order projection. The
// client order ID is immutable; revisions and cumulative fill evidence are
// monotonic so restart/recovery cannot double-count a snapshot.
func (s *LocalStorage) SaveManagedOrder(order *models.DBManagedOrder) error {
	if order == nil || strings.TrimSpace(order.ClientOrderID) == "" {
		return fmt.Errorf("managed order client order ID is required")
	}
	if !durableIdentityComplete(order.DurableIdentity) {
		return fmt.Errorf("managed order requires complete durable execution identity")
	}
	if !durableIdentityMatches(order.DurableIdentity, s.identity) {
		return fmt.Errorf("managed order identity does not match storage execution context")
	}
	if order.RequestedQty <= 0 || math.IsNaN(order.RequestedQty) || math.IsInf(order.RequestedQty, 0) {
		return fmt.Errorf("managed order requested quantity must be finite and positive")
	}
	if strings.TrimSpace(order.Role) == "" || strings.TrimSpace(order.Purpose) == "" {
		return fmt.Errorf("managed order role and purpose are required")
	}
	if order.Role != order.Purpose && !(order.Role == "protection" && order.Purpose == "protection") {
		return fmt.Errorf("managed order role and purpose do not agree")
	}
	if order.FilledQty < 0 || order.FilledQty > order.RequestedQty || order.FillWatermark < 0 || order.FillWatermark > order.RequestedQty {
		return fmt.Errorf("managed order fill evidence is outside requested quantity")
	}
	if order.FillWatermark < order.FilledQty {
		order.FillWatermark = order.FilledQty
	}

	var existing models.DBManagedOrder
	result := s.db.Where("client_order_id = ?", order.ClientOrderID).First(&existing)
	if errors.Is(result.Error, gorm.ErrRecordNotFound) {
		if order.Revision == 0 {
			order.Revision = 1
		}
		if err := s.db.Create(order).Error; err != nil {
			return fmt.Errorf("failed to create managed order: %w", err)
		}
		return nil
	}
	if result.Error != nil {
		return fmt.Errorf("failed to load managed order: %w", result.Error)
	}
	if !durableIdentityMatches(existing.DurableIdentity, order.DurableIdentity) {
		return fmt.Errorf("managed order client identity belongs to a different execution context")
	}
	if existing.BrokerOrderID != "" && order.BrokerOrderID == "" {
		order.BrokerOrderID = existing.BrokerOrderID
	}
	if existing.BrokerOrderID != "" && order.BrokerOrderID != "" && existing.BrokerOrderID != order.BrokerOrderID {
		return fmt.Errorf("managed order broker identity cannot be rotated")
	}
	if existing.PositionID != order.PositionID || existing.Role != order.Role || existing.Purpose != order.Purpose ||
		existing.Symbol != order.Symbol || existing.Side != order.Side || existing.AssetClass != order.AssetClass ||
		existing.Underlying != order.Underlying || existing.PositionIntent != order.PositionIntent ||
		existing.OrderType != order.OrderType || existing.TimeInForce != order.TimeInForce ||
		existing.RequestedQty != order.RequestedQty || !managedPriceEqual(existing.LimitPrice, order.LimitPrice) ||
		!managedPriceEqual(existing.StopPrice, order.StopPrice) {
		return fmt.Errorf("managed order client identity is already bound to different order parameters")
	}
	if order.Revision != existing.Revision {
		return fmt.Errorf("stale managed order revision")
	}
	if existing.SubmissionAttempted {
		order.SubmissionAttempted = true
	}
	if existing.FillWatermark > order.FillWatermark {
		order.FillWatermark = existing.FillWatermark
	}
	if existing.FilledQty > order.FilledQty {
		order.FilledQty = existing.FilledQty
	}
	order.ID = existing.ID
	order.Revision = existing.Revision + 1
	updated := s.db.Model(&models.DBManagedOrder{}).Where("id = ? AND revision = ?", existing.ID, existing.Revision).Updates(order)
	if updated.Error != nil {
		return fmt.Errorf("failed to update managed order: %w", updated.Error)
	}
	if updated.RowsAffected != 1 {
		return fmt.Errorf("stale managed order revision")
	}
	return nil
}

// MarkManagedSubmissionAttempted is the single managed-order pre-SDK
// transition. Both durable rows advance under one transaction; a missing or
// mismatched projection fails closed and rolls back the generic row update.
func (s *LocalStorage) MarkManagedSubmissionAttempted(clientOrderID, positionID, role string) error {
	if strings.TrimSpace(clientOrderID) == "" || strings.TrimSpace(positionID) == "" || strings.TrimSpace(role) == "" {
		return fmt.Errorf("managed submission marker requires client order ID, position ID, and role")
	}
	if !durableIdentityComplete(s.identity) {
		return fmt.Errorf("storage has incomplete durable execution identity")
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		var generic models.DBOrder
		if err := s.identityQuery(tx.Where("client_order_id = ?", clientOrderID)).First(&generic).Error; err != nil {
			return fmt.Errorf("failed to load generic submission intent: %w", err)
		}
		var managed models.DBManagedOrder
		if err := tx.Where("client_order_id = ?", clientOrderID).First(&managed).Error; err != nil {
			return fmt.Errorf("failed to load managed submission projection: %w", err)
		}
		if managed.PositionID != positionID || managed.Role != role || managed.Purpose != generic.Purpose {
			return fmt.Errorf("managed submission projection identity mismatch for client order ID %q", clientOrderID)
		}
		if !generic.SubmissionAttempted {
			updated := s.identityQuery(tx.Model(&models.DBOrder{})).Where("id = ? AND revision = ?", generic.ID, generic.Revision).Updates(map[string]interface{}{"submission_attempted": true, "revision": generic.Revision + 1})
			if updated.Error != nil || updated.RowsAffected != 1 {
				if updated.Error != nil {
					return fmt.Errorf("failed to mark generic submission intent: %w", updated.Error)
				}
				return fmt.Errorf("stale generic submission intent revision")
			}
		}
		if !managed.SubmissionAttempted {
			updated := tx.Model(&models.DBManagedOrder{}).Where("id = ? AND revision = ?", managed.ID, managed.Revision).Updates(map[string]interface{}{"submission_attempted": true, "revision": managed.Revision + 1})
			if updated.Error != nil || updated.RowsAffected != 1 {
				if updated.Error != nil {
					return fmt.Errorf("failed to mark managed submission projection: %w", updated.Error)
				}
				return fmt.Errorf("stale managed submission projection revision")
			}
		}
		return nil
	})
}

func managedPriceEqual(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return math.Abs(*left-*right) <= 1e-9
}

func (s *LocalStorage) GetManagedOrder(clientOrderID string) (*models.DBManagedOrder, error) {
	if strings.TrimSpace(clientOrderID) == "" {
		return nil, fmt.Errorf("managed order client order ID is required")
	}
	var order models.DBManagedOrder
	result := s.db.Where("client_order_id = ?", clientOrderID).First(&order)
	if errors.Is(result.Error, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get managed order: %w", result.Error)
	}
	if !durableIdentityComplete(order.DurableIdentity) || !durableIdentityMatches(order.DurableIdentity, s.identity) {
		return nil, fmt.Errorf("managed order belongs to a different execution context")
	}
	return &order, nil
}

// GetManagedOrderByBrokerOrderID resolves the durable projection for a broker
// identity. More than one row is ambiguous and is rejected before execution.
func (s *LocalStorage) GetManagedOrderByBrokerOrderID(brokerOrderID string) (*models.DBManagedOrder, error) {
	if strings.TrimSpace(brokerOrderID) == "" {
		return nil, fmt.Errorf("managed order broker order ID is required")
	}
	var orders []models.DBManagedOrder
	if err := s.db.Where("broker_order_id = ?", brokerOrderID).Find(&orders).Error; err != nil {
		return nil, fmt.Errorf("failed to get managed order by broker order ID: %w", err)
	}
	if len(orders) != 1 {
		if len(orders) == 0 {
			return nil, nil
		}
		return nil, fmt.Errorf("ambiguous managed order broker identity %q", brokerOrderID)
	}
	if !durableIdentityComplete(orders[0].DurableIdentity) || !durableIdentityMatches(orders[0].DurableIdentity, s.identity) {
		return nil, fmt.Errorf("managed order belongs to a different execution context")
	}
	return &orders[0], nil
}

// SavePosition saves a position snapshot
func (s *LocalStorage) SavePosition(position *interfaces.Position) error {
	if position == nil {
		return fmt.Errorf("position is required")
	}
	if !durableIdentityComplete(s.identity) {
		return fmt.Errorf("position requires complete storage execution identity")
	}
	if position.BrokerAccountID != "" || position.PaperLive != "" || position.TenantID != "" || position.SandboxID != "" {
		incoming := models.DurableIdentity{BrokerAccountID: position.BrokerAccountID, PaperLive: position.PaperLive, TenantID: position.TenantID, SandboxID: position.SandboxID}
		if !durableIdentityComplete(incoming) || !durableIdentityMatches(incoming, s.identity) {
			return fmt.Errorf("position identity does not match storage execution context")
		}
	}
	dbPosition := &models.DBPosition{
		DurableIdentity: s.identity,
		Symbol:          position.Symbol,
		Qty:             position.Qty,
		AvgEntryPrice:   position.AvgEntryPrice,
		MarketValue:     position.MarketValue,
		CostBasis:       position.CostBasis,
		UnrealizedPL:    position.UnrealizedPL,
		UnrealizedPLPC:  position.UnrealizedPLPC,
		CurrentPrice:    position.CurrentPrice,
		Side:            position.Side,
		SnapshotTime:    time.Now(),
	}

	result := s.db.Save(dbPosition)
	if result.Error != nil {
		return fmt.Errorf("failed to save position: %w", result.Error)
	}

	return nil
}

// SaveAccountSnapshot saves an account snapshot
func (s *LocalStorage) SaveAccountSnapshot(account *interfaces.Account) error {
	if account == nil {
		return fmt.Errorf("account snapshot is required")
	}
	if !durableIdentityComplete(s.identity) {
		return fmt.Errorf("account snapshot requires complete storage execution identity")
	}
	if account.BrokerAccountID != "" || account.PaperLive != "" || account.TenantID != "" || account.SandboxID != "" {
		incoming := models.DurableIdentity{BrokerAccountID: account.BrokerAccountID, PaperLive: account.PaperLive, TenantID: account.TenantID, SandboxID: account.SandboxID}
		if !durableIdentityComplete(incoming) || !durableIdentityMatches(incoming, s.identity) {
			return fmt.Errorf("account snapshot identity does not match storage execution context")
		}
	}
	dbSnapshot := &models.DBAccountSnapshot{
		DurableIdentity:  s.identity,
		Cash:             account.Cash,
		PortfolioValue:   account.PortfolioValue,
		BuyingPower:      account.BuyingPower,
		DayTradeCount:    account.DayTradeCount,
		PatternDayTrader: account.PatternDayTrader,
		SnapshotTime:     time.Now(),
	}

	result := s.db.Save(dbSnapshot)
	if result.Error != nil {
		return fmt.Errorf("failed to save account snapshot: %w", result.Error)
	}

	return nil
}

// SaveSignal saves a trading signal
func (s *LocalStorage) SaveSignal(symbol, signalType, strategyName, reason string, strength float64) error {
	dbSignal := &models.DBSignal{
		Symbol:       symbol,
		SignalType:   signalType,
		Strength:     strength,
		StrategyName: strategyName,
		Reason:       reason,
		Executed:     false,
	}

	result := s.db.Save(dbSignal)
	if result.Error != nil {
		return fmt.Errorf("failed to save signal: %w", result.Error)
	}

	return nil
}

// managedPositionAssignments contains every mutable managed-position field, including
// client-only identities. Keeping this complete prevents a stale writer from orphaning
// an externally submitted order or silently dropping protection metadata.
func managedPositionAssignments(position *models.DBManagedPosition) map[string]interface{} {
	return map[string]interface{}{
		"broker_account_id": position.BrokerAccountID, "paper_live": position.PaperLive,
		"tenant_id": position.TenantID, "sandbox_id": position.SandboxID,
		"revision": position.Revision,
		"symbol":   position.Symbol, "side": position.Side, "strategy": position.Strategy,
		"quantity": position.Quantity, "entry_remaining_qty": position.EntryRemainingQty, "entry_price": position.EntryPrice,
		"entry_order_id": position.EntryOrderID, "entry_client_order_id": position.EntryClientOrderID,
		"exit_order_id": position.ExitOrderID, "exit_client_order_id": position.ExitClientOrderID,
		"exit_filled_qty": position.ExitFilledQty, "exit_fill_watermarks": position.ExitFillWatermarks, "entry_order_type": position.EntryOrderType,
		"protection_fill_watermarks": position.ProtectionFillWatermarks,
		"allocation_dollars":         position.AllocationDollars,
		"stop_loss_price":            position.StopLossPrice, "stop_loss_percent": position.StopLossPercent,
		"stop_loss_order_id": position.StopLossOrderID, "stop_loss_client_order_id": position.StopLossClientOrderID,
		"trailing_stop": position.TrailingStop, "trailing_percent": position.TrailingPercent,
		"take_profit_price": position.TakeProfitPrice, "take_profit_percent": position.TakeProfitPercent,
		"take_profit_order_id": position.TakeProfitOrderID, "take_profit_client_order_id": position.TakeProfitClientOrderID,
		"partial_exit_enabled": position.PartialExitEnabled, "partial_exit_percent": position.PartialExitPercent,
		"partial_exit_target_percent": position.PartialExitTargetPercent, "partial_exit_target_price": position.PartialExitTargetPrice,
		"partial_exit_orders": position.PartialExitOrders, "partial_exit_client_order_id": position.PartialExitClientOrderID,
		"status": position.Status, "current_price": position.CurrentPrice, "unrealized_pl": position.UnrealizedPL,
		"unrealized_plpc": position.UnrealizedPLPC, "remaining_qty": position.RemainingQty,
		"notes": position.Notes, "tags": position.Tags, "closed_at": position.ClosedAt,
		"updated_at": position.UpdatedAt,
	}
}

// SaveManagedPosition saves a managed position with optimistic revision protection.
func (s *LocalStorage) SaveManagedPosition(position *models.DBManagedPosition) error {
	if position == nil || position.PositionID == "" {
		return fmt.Errorf("managed position and position_id are required")
	}
	if !durableIdentityComplete(s.identity) {
		return fmt.Errorf("storage has incomplete durable execution identity")
	}
	callerIdentity := position.DurableIdentity
	if (callerIdentity.BrokerAccountID != "" || callerIdentity.PaperLive != "" || callerIdentity.TenantID != "" || callerIdentity.SandboxID != "") && !durableIdentityMatches(callerIdentity, s.identity) {
		return fmt.Errorf("managed position durable identity does not match storage identity")
	}
	position.DurableIdentity = s.identity

	tx := s.db.Begin()
	if tx.Error != nil {
		return fmt.Errorf("failed to begin managed position transaction: %w", tx.Error)
	}
	var existing models.DBManagedPosition
	lookupErr := s.identityQuery(tx.Where("position_id = ?", position.PositionID)).First(&existing).Error
	if errors.Is(lookupErr, gorm.ErrRecordNotFound) {
		position.Revision = 1
		if position.CreatedAt.IsZero() {
			position.CreatedAt = time.Now()
		}
		position.UpdatedAt = time.Now()
		if err := tx.Create(position).Error; err != nil {
			tx.Rollback()
			return fmt.Errorf("failed to save managed position: %w", err)
		}
		if err := tx.Commit().Error; err != nil {
			return fmt.Errorf("failed to commit managed position: %w", err)
		}
		return nil
	}
	if lookupErr != nil {
		tx.Rollback()
		return fmt.Errorf("failed to load managed position identity: %w", lookupErr)
	}
	if !durableIdentityMatches(existing.DurableIdentity, s.identity) {
		tx.Rollback()
		return fmt.Errorf("managed position %q belongs to a different durable execution identity", position.PositionID)
	}
	if position.Revision != existing.Revision {
		tx.Rollback()
		return fmt.Errorf("stale managed-position revision for %q", position.PositionID)
	}

	position.ID = existing.ID
	position.CreatedAt = existing.CreatedAt
	position.Revision = existing.Revision + 1
	position.UpdatedAt = time.Now()
	result := tx.Model(&models.DBManagedPosition{}).
		Where("id = ? AND position_id = ? AND revision = ?", existing.ID, position.PositionID, existing.Revision).
		Updates(managedPositionAssignments(position))
	if result.Error != nil {
		tx.Rollback()
		return fmt.Errorf("failed to update managed position: %w", result.Error)
	}
	if result.RowsAffected != 1 {
		tx.Rollback()
		return fmt.Errorf("stale managed-position revision for %q", position.PositionID)
	}
	if err := tx.Commit().Error; err != nil {
		return fmt.Errorf("failed to commit managed position: %w", err)
	}
	return nil
}

// GetManagedPosition retrieves a managed position by ID
func (s *LocalStorage) GetManagedPosition(positionID string) (*models.DBManagedPosition, error) {
	if !durableIdentityComplete(s.identity) {
		return nil, fmt.Errorf("storage has incomplete durable execution identity")
	}
	var dbPosition models.DBManagedPosition

	result := s.identityQuery(s.db.Where("position_id = ?", positionID)).First(&dbPosition)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get managed position: %w", result.Error)
	}

	return &dbPosition, nil
}

// GetAllManagedPositions retrieves all managed positions with optional status filter
func (s *LocalStorage) GetAllManagedPositions(status string) ([]*models.DBManagedPosition, error) {
	if !durableIdentityComplete(s.identity) {
		return nil, fmt.Errorf("storage has incomplete durable execution identity")
	}
	var dbPositions []*models.DBManagedPosition

	query := s.identityQuery(s.db.Model(&models.DBManagedPosition{}))
	if status != "" {
		query = query.Where("status = ?", status)
	}

	result := query.Order("created_at DESC").Find(&dbPositions)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get managed positions: %w", result.Error)
	}

	return dbPositions, nil
}

// DeleteManagedPosition deletes a managed position by ID
func (s *LocalStorage) DeleteManagedPosition(positionID string) error {
	if !durableIdentityComplete(s.identity) {
		return fmt.Errorf("storage has incomplete durable execution identity")
	}
	result := s.identityQuery(s.db.Where("position_id = ?", positionID)).Delete(&models.DBManagedPosition{})
	if result.Error != nil {
		return fmt.Errorf("failed to delete managed position: %w", result.Error)
	}
	return nil
}

// Close closes the database connection
func (s *LocalStorage) Close() error {
	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}
