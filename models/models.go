package models

import (
	"time"

	"gorm.io/gorm"
)

// DurableIdentity binds persisted broker state to the server-owned execution
// context. Empty or mismatched identity is never treated as current state.
type DurableIdentity struct {
	BrokerAccountID string `gorm:"index"`
	PaperLive       string `gorm:"index"` // exactly "paper" or "live"
	TenantID        string `gorm:"index"`
	SandboxID       string `gorm:"index"`
}

// DBOrder represents an order in the database
type DBOrder struct {
	gorm.Model
	DurableIdentity
	OrderID             string  `gorm:"index"`
	ClientOrderID       *string `gorm:"uniqueIndex"` // pointer so empty stays NULL — many NULLs allowed, only non-empty ids dedupe
	Symbol              string  `gorm:"index"`
	Qty                 float64
	Side                string
	Type                string
	TimeInForce         string
	LimitPrice          *float64
	StopPrice           *float64
	Status              string `gorm:"index"`
	FilledQty           float64
	FilledAvgPrice      *float64
	SubmittedAt         time.Time
	FilledAt            *time.Time
	CanceledAt          *time.Time
	ReplacedBy          string
	AssetClass          string
	Underlying          string
	PositionIntent      string
	Purpose             string
	NextEligibleAt      *time.Time
	ExpiresAt           *time.Time
	Revision            int64
	SubmissionAttempted bool
	StrategyName        string
	Metadata            string // JSON string for flexible data
	OptionLegsJSON      string // JSON-encoded atomic options leg identity
}

// DBBar represents historical price data in the database
type DBBar struct {
	gorm.Model
	Symbol    string    `gorm:"index:idx_symbol_timestamp"`
	Timestamp time.Time `gorm:"index:idx_symbol_timestamp"`
	Open      float64
	High      float64
	Low       float64
	Close     float64
	Volume    int64
	VWAP      float64
	Timeframe string
}

// DBPosition represents a position snapshot in the database
type DBPosition struct {
	gorm.Model
	DurableIdentity
	Symbol         string `gorm:"index:idx_position_symbol_snapshot"`
	Qty            float64
	AvgEntryPrice  float64
	MarketValue    float64
	CostBasis      float64
	UnrealizedPL   float64
	UnrealizedPLPC float64
	CurrentPrice   float64
	Side           string
	SnapshotTime   time.Time `gorm:"index:idx_position_symbol_snapshot"`
}

// DBTrade represents executed trades for analysis
type DBTrade struct {
	gorm.Model
	DurableIdentity
	Symbol       string `gorm:"index"`
	EntryPrice   float64
	ExitPrice    float64
	Qty          float64
	Side         string
	PnL          float64
	PnLPercent   float64
	EntryTime    time.Time
	ExitTime     time.Time
	Duration     int64 // seconds
	StrategyName string
	Metadata     string
}

// DBAccountSnapshot represents account state at a point in time
type DBAccountSnapshot struct {
	gorm.Model
	DurableIdentity
	Cash             float64
	PortfolioValue   float64
	BuyingPower      float64
	DayTradeCount    int
	PatternDayTrader bool
	SnapshotTime     time.Time `gorm:"index"`
}

// DBSignal represents trading signals for audit/analysis
type DBSignal struct {
	gorm.Model
	Symbol       string `gorm:"index"`
	SignalType   string // "BUY", "SELL", "HOLD"
	Strength     float64
	StrategyName string `gorm:"index"`
	Reason       string
	Metadata     string
	Executed     bool
	ExecutedAt   *time.Time
	OrderID      string
}

// DBManagedOrder is the durable source of truth for one managed entry,
// protection, exit, or replacement order. Position rows are projections.
type DBManagedOrder struct {
	gorm.Model
	DurableIdentity
	PositionID          string `gorm:"index:idx_managed_order_position_role"`
	Role                string `gorm:"index:idx_managed_order_position_role"`
	Purpose             string
	ClientOrderID       string `gorm:"uniqueIndex"`
	BrokerOrderID       string `gorm:"index"`
	Symbol              string
	Side                string
	AssetClass          string
	Underlying          string
	PositionIntent      string
	OrderType           string
	TimeInForce         string
	RequestedQty        float64
	FilledQty           float64
	FilledAvgPrice      *float64
	FillWatermark       float64
	LimitPrice          *float64
	StopPrice           *float64
	Lifecycle           string `gorm:"index"`
	SubmissionAttempted bool
	Revision            int64 `gorm:"not null;default:0"`
	SubmittedAt         *time.Time
	FilledAt            *time.Time
	CanceledAt          *time.Time
}

// DBManagedPosition represents a managed position with automated risk management
type DBManagedPosition struct {
	gorm.Model
	DurableIdentity
	PositionID string `gorm:"uniqueIndex"`
	Revision   int64  `gorm:"not null;default:0"`
	Symbol     string `gorm:"index"`
	Side       string
	Strategy   string

	// Entry details
	Quantity           float64
	EntryRemainingQty  float64
	EntryPrice         float64
	EntryOrderID       string
	EntryClientOrderID string
	ExitOrderID        string
	ExitClientOrderID  string
	ExitFilledQty      float64
	ExitFillWatermarks string `gorm:"type:text"`
	EntryOrderType     string
	AllocationDollars  float64

	// Risk management
	StopLossPrice         float64
	StopLossPercent       float64
	StopLossOrderID       string
	StopLossClientOrderID string
	TrailingStop          bool
	TrailingPercent       float64

	// Profit targets
	TakeProfitPrice         float64
	TakeProfitPercent       float64
	TakeProfitOrderID       string
	TakeProfitClientOrderID string

	// Partial exit
	PartialExitEnabled       bool
	PartialExitPercent       float64
	PartialExitTargetPercent float64
	PartialExitTargetPrice   float64
	PartialExitOrders        string // JSON array of order IDs
	PartialExitClientOrderID string
	ProtectionFillWatermarks string `gorm:"type:text"`
	Status                   string `gorm:"index"` // PENDING, ACTIVE, PARTIAL, CLOSED, STOPPED_OUT
	CurrentPrice             float64
	UnrealizedPL             float64
	UnrealizedPLPC           float64
	RemainingQty             float64

	// Metadata
	Notes    string
	Tags     string // JSON array
	ClosedAt *time.Time
}

// TableName overrides for cleaner table names
func (DBOrder) TableName() string {
	return "orders"
}

func (DBBar) TableName() string {
	return "bars"
}

func (DBPosition) TableName() string {
	return "positions"
}

func (DBTrade) TableName() string {
	return "trades"
}

func (DBAccountSnapshot) TableName() string {
	return "account_snapshots"
}

func (DBSignal) TableName() string {
	return "signals"
}

func (DBManagedOrder) TableName() string {
	return "managed_orders"
}

func (DBManagedPosition) TableName() string {
	return "managed_positions"
}
