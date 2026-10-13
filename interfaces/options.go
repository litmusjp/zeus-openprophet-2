package interfaces

import (
	"encoding/json"
	"time"
)

func marshalKnownNumericJSON(value any, omit ...string) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	for _, name := range omit {
		delete(fields, name)
	}
	return json.Marshal(fields)
}

// OptionContract represents an option contract
type OptionContract struct {
	Symbol              string    // Option symbol (e.g., "AAPL231215C00150000")
	UnderlyingSymbol    string    // Underlying stock symbol
	ContractType        string    // "call" or "put"
	StrikePrice         float64   // Strike price
	ExpirationDate      time.Time // Expiration date
	Premium             float64   // Current premium/price
	Bid                 float64
	Ask                 float64
	BidSize             int64
	AskSize             int64
	QuoteTimestamp      time.Time
	Volume              int64
	LatestTradeSize     int64  `json:"latest_trade_size,omitempty"`
	VolumeKnown         bool   `json:"volume_known"`
	VolumeBasis         string `json:"volume_basis,omitempty"`
	OpenInterest        int64
	OpenInterestPresent bool
	ImpliedVolatility   float64
	Delta               float64
	Gamma               float64
	Theta               float64
	Vega                float64
	DTE                 int    // Days to expiration
	MarketDataFeed      string `json:"market_data_feed,omitempty"`
	MarketDataQuality   string `json:"market_data_quality,omitempty"`
}

func (c OptionContract) MarshalJSON() ([]byte, error) {
	type plain OptionContract
	var omit []string
	if !c.VolumeKnown {
		omit = append(omit, "Volume")
	}
	if !c.OpenInterestPresent {
		omit = append(omit, "OpenInterest")
	}
	return marshalKnownNumericJSON(plain(c), omit...)
}

// OptionPosition represents an open options position
type OptionPosition struct {
	Contract       *OptionContract
	Quantity       int
	EntryPrice     float64
	EntryTime      time.Time
	CurrentPrice   float64
	UnrealizedPL   float64
	UnrealizedPLPC float64
}

// OptionChain represents available options for a symbol
type OptionChain struct {
	UnderlyingSymbol string
	UnderlyingPrice  float64
	Timestamp        time.Time
	Calls            []*OptionContract
	Puts             []*OptionContract
}

// OptionDataService defines interface for options market data
type OptionDataService interface {
	GetOptionChain(symbol string, expirationDate time.Time) (*OptionChain, error)
	GetOptionChains(symbol string) (map[time.Time]*OptionChain, error)
	GetOptionSnapshot(optionSymbol string) (*OptionContract, error)
}
