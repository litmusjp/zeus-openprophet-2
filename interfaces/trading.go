package interfaces

import (
	"context"
	"time"
)

// TradingService defines the interface for executing trades
type TradingService interface {
	PlaceOrder(ctx context.Context, order *Order) (*OrderResult, error)
	CancelOrder(ctx context.Context, orderID string) error
	GetOrder(ctx context.Context, orderID string) (*Order, error)
	GetOrderByClientOrderID(ctx context.Context, clientOrderID string) (*Order, error)
	ListOrders(ctx context.Context, status string) ([]*Order, error)
	GetPositions(ctx context.Context) ([]*Position, error)
	GetAccount(ctx context.Context) (*Account, error)

	// Options trading methods
	PlaceOptionsOrder(ctx context.Context, order *OptionsOrder) (*OrderResult, error)
	GetOptionsChain(ctx context.Context, underlying string, expiration time.Time) ([]*OptionContract, error)
	GetOptionsQuote(ctx context.Context, symbol string) (*OptionsQuote, error)
	GetOptionsPosition(ctx context.Context, symbol string) (*OptionsPosition, error)
	ListOptionsPositions(ctx context.Context) ([]*OptionsPosition, error)
}

// DataService defines the interface for market data operations
type DataService interface {
	GetHistoricalBars(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*Bar, error)
	GetLatestBar(ctx context.Context, symbol string) (*Bar, error)
	GetLatestQuote(ctx context.Context, symbol string) (*Quote, error)
	GetLatestTrade(ctx context.Context, symbol string) (*Trade, error)
	StreamBars(ctx context.Context, symbols []string) (<-chan *Bar, error)
}

// StorageService defines the interface for local data persistence
type StorageService interface {
	SaveBars(bars []*Bar) error
	GetBars(symbol string, start, end time.Time) ([]*Bar, error)
	SaveOrder(order *Order) error
	GetOrder(orderID string) (*Order, error)
	GetOrderByClientOrderID(clientOrderID string) (*Order, error)
	GetOrders(status string) ([]*Order, error)
	GetOrdersNeedingReconciliation() ([]*Order, error)
	CleanupOldData(before time.Time) error
}

// StrategyExecutor defines the interface for strategy execution
// This will be useful for AI personas and quant strategies later
type StrategyExecutor interface {
	Initialize(config map[string]interface{}) error
	ShouldBuy(ctx context.Context, symbol string, data *MarketData) (bool, *OrderRequest)
	ShouldSell(ctx context.Context, symbol string, data *MarketData) (bool, *OrderRequest)
	OnOrderFilled(order *Order)
	OnMarketData(data *MarketData)
	GetName() string
}

// Common data structures used across interfaces
type Order struct {
	BrokerAccountID string
	PaperLive       string
	TenantID        string
	SandboxID       string
	ID              string
	ClientOrderID   string
	Symbol          string
	Qty             float64
	Side            string // "buy" or "sell"
	Type            string // "market", "limit", etc.
	TimeInForce     string // "day", "gtc", etc.
	LimitPrice      *float64
	StopPrice       *float64
	Status          string
	FilledQty       float64
	FilledAvgPrice  *float64
	SubmittedAt     time.Time
	FilledAt        *time.Time
	CanceledAt      *time.Time
	ReplacedBy      string
	AssetClass      string
	Underlying      string // underlying equity for option orders
	PositionIntent  string // options intent, e.g. "buy_to_open"
	Purpose         string // entry, protection, or close; required at the broker boundary
	// Managed identity is transient routing metadata for the service-owned
	// pre-submission marker; it is not broker or database order state.
	ManagedPositionID   string
	ManagedRole         string
	NextEligibleAt      *time.Time // next broker session for planned intents
	ExpiresAt           *time.Time // planned-intent authorization expiry
	Revision            int64      // optimistic lifecycle revision
	SubmissionAttempted bool       // broker call may have occurred; never blind-retry when true
	Metadata            string     `json:"metadata,omitempty"` // server-produced audit metadata; never credentials
}

type OrderRequest struct {
	Symbol      string
	Qty         float64
	Side        string
	Type        string
	TimeInForce string
	LimitPrice  *float64
	StopPrice   *float64
}

type MarketClock struct {
	Timestamp time.Time `json:"timestamp"`
	IsOpen    bool      `json:"is_open"`
	NextOpen  time.Time `json:"next_open"`
	NextClose time.Time `json:"next_close"`
}

// OrderResult describes broker acknowledgement separately from confirmed execution.
type OrderResult struct {
	BrokerAccountID    string     `json:"broker_account_id,omitempty"`
	PaperLive          string     `json:"paper_live,omitempty"`
	TenantID           string     `json:"tenant_id,omitempty"`
	SandboxID          string     `json:"sandbox_id,omitempty"`
	OrderID            string     `json:"order_id,omitempty"`
	Status             string     `json:"status"`
	Message            string     `json:"message"`
	ClientOrderID      string     `json:"client_order_id,omitempty"`
	FilledQty          float64    `json:"filled_qty"`
	FilledAvgPrice     *float64   `json:"filled_avg_price,omitempty"`
	SubmittedAt        time.Time  `json:"submitted_at,omitempty"`
	FilledAt           *time.Time `json:"filled_at,omitempty"`
	CanceledAt         *time.Time `json:"canceled_at,omitempty"`
	Symbol             string     `json:"symbol,omitempty"`
	Side               string     `json:"side,omitempty"`
	Qty                float64    `json:"qty,omitempty"`
	Type               string     `json:"type,omitempty"`
	TimeInForce        string     `json:"time_in_force,omitempty"`
	LimitPrice         *float64   `json:"limit_price,omitempty"`
	StopPrice          *float64   `json:"stop_price,omitempty"`
	AssetClass         string     `json:"asset_class,omitempty"`
	Underlying         string     `json:"underlying,omitempty"`
	PositionIntent     string     `json:"position_intent,omitempty"`
	Purpose            string     `json:"purpose,omitempty"`
	ExecutionConfirmed bool       `json:"execution_confirmed"`
	FullyFilled        bool       `json:"fully_filled"`
	NextEligibleAt     *time.Time `json:"next_eligible_at,omitempty"`
}

type Position struct {
	BrokerAccountID string
	PaperLive       string
	TenantID        string
	SandboxID       string
	Symbol          string
	Qty             float64
	AvgEntryPrice   float64
	MarketValue     float64
	CostBasis       float64
	UnrealizedPL    float64
	UnrealizedPLPC  float64
	CurrentPrice    float64
	Side            string
}

type Account struct {
	BrokerAccountID string
	PaperLive       string
	TenantID        string
	SandboxID       string
	ID              string
	// Equity is the broker's current account equity. DailyPnL is explicitly
	// account-scoped and is valid only for the broker's current daily window.
	Equity           float64
	Cash             float64
	PortfolioValue   float64
	BuyingPower      float64
	DayTradeCount    int
	PatternDayTrader bool
	LastEquity       float64
	DailyPnL         float64
	DailyPnLPercent  float64
	DailyPnLValid    bool
}

type Bar struct {
	Symbol    string
	Timestamp time.Time
	Open      float64
	High      float64
	Low       float64
	Close     float64
	Volume    int64
	VWAP      float64
}

type Quote struct {
	Symbol    string
	BidPrice  float64
	BidSize   int64
	AskPrice  float64
	AskSize   int64
	Timestamp time.Time
}

type Trade struct {
	Symbol    string
	Price     float64
	Size      int64
	Timestamp time.Time
}

type MarketData struct {
	Symbol      string
	CurrentBar  *Bar
	RecentBars  []*Bar
	LatestQuote *Quote
	LatestTrade *Trade
	Indicators  map[string]float64 // For calculated indicators
}

// Options trading structures
type OptionsOrder struct {
	ClientOrderID         string
	Symbol                string // Options symbol in OCC format (e.g., TSLA251219C00400000)
	Underlying            string // Underlying stock symbol
	Qty                   float64
	Side                  string // "buy" or "sell"
	PositionIntent        string // "buy_to_open", "buy_to_close", "sell_to_open", "sell_to_close"
	Type                  string // "market", "limit"
	TimeInForce           string // "day", "gtc"
	LimitPrice            *float64
	SubmissionAttempted   bool
	MarketScannerFeatures any                              `json:"-"`
	AlphaDeskAssessment   *AlphaDeskAssessment             `json:"-"`
	AssessmentAuditSink   func(*AlphaDeskAssessment) error `json:"-"`
	AssessmentLegs        []AlphaDeskAssessmentLeg         `json:"-"`
	AssessmentMaxLoss     *float64                         `json:"-"`
	AssessmentGreeks      map[string]float64               `json:"-"`
	MarketEvidenceAt      time.Time                        `json:"-"`
	ObservedAt            time.Time                        `json:"-"`
	AssessmentExpiresAt   time.Time                        `json:"-"`
	StrategyType          string                           `json:"-"`
}

type AlphaDeskAssessmentLeg struct {
	Symbol       string    `json:"symbol"`
	Side         string    `json:"side"`
	Quantity     int       `json:"quantity"`
	Price        float64   `json:"price"`
	Bid          float64   `json:"bid"`
	Ask          float64   `json:"ask"`
	QuoteSize    float64   `json:"quote_size"`
	QuotedAt     time.Time `json:"quoted_at"`
	OpenInterest *int64    `json:"open_interest,omitempty"`
	Delta        *float64  `json:"delta,omitempty"`
	Gamma        *float64  `json:"gamma,omitempty"`
	Theta        *float64  `json:"theta,omitempty"`
	Vega         *float64  `json:"vega,omitempty"`
}

type AlphaDeskAssessment struct {
	AssessmentID          string    `json:"assessment_id"`
	Decision              string    `json:"decision"`
	SignalScore           *float64  `json:"signal_score,omitempty"`
	Threshold             *float64  `json:"execution_threshold,omitempty"`
	Policy                any       `json:"policy,omitempty"`
	Evidence              any       `json:"evidence,omitempty"`
	ExpiresAt             time.Time `json:"expires_at"`
	Fingerprint           string    `json:"trade_fingerprint"`
	HumanApprovalRequired bool      `json:"human_approval_required"`
	ExecutionAllowed      bool      `json:"execution_allowed"`
	Pass                  bool      `json:"pass"`
	FailedCheckCodes      []string  `json:"failed_check_codes,omitempty"`
	PolicyVersion         string    `json:"policy_version,omitempty"`
	MarketEvidenceAt      time.Time `json:"market_evidence_at,omitempty"`
	ObservedAt            time.Time `json:"observed_at,omitempty"`
	QualificationStatus   string    `json:"qualification_status"`
	Qualified             bool      `json:"qualified"`
}

type OptionsQuote struct {
	Symbol    string
	BidPrice  float64
	BidSize   int64
	AskPrice  float64
	AskSize   int64
	LastPrice float64
	Volume    int64
	Timestamp time.Time
}

type OptionsPosition struct {
	BrokerAccountID string
	PaperLive       string
	TenantID        string
	SandboxID       string
	Symbol          string
	Underlying      string
	Qty             float64
	AvgEntryPrice   float64
	MarketValue     float64
	CostBasis       float64
	UnrealizedPL    float64
	UnrealizedPLPC  float64
	CurrentPrice    float64
	Side            string // "long" or "short"
	Expiration      time.Time
	Strike          float64
	OptionType      string // "call" or "put"
}
