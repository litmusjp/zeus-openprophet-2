package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"prophet-trader/interfaces"
	"time"

	"github.com/sirupsen/logrus"
)

// AlpacaOptionsDataService fetches real historical options data from Alpaca
type AlpacaOptionsDataService struct {
	apiKey    string
	secretKey string
	baseURL   string
	logger    *logrus.Logger
	client    *http.Client
}

// NewAlpacaOptionsDataService creates a new Alpaca options data service
func NewAlpacaOptionsDataService(apiKey, secretKey string) *AlpacaOptionsDataService {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	// Note: Options data API might require different subscription
	return &AlpacaOptionsDataService{
		apiKey:    apiKey,
		secretKey: secretKey,
		baseURL:   "https://data.alpaca.markets", // Options data endpoint
		logger:    logger,
		client:    &http.Client{Timeout: 30 * time.Second},
	}
}

// AlpacaOptionsSnapshot represents Alpaca's options snapshot response
type AlpacaOptionsSnapshot struct {
	Snapshots map[string]AlpacaOptionContract `json:"snapshots"`
}

// AlpacaOptionContract represents an option contract from Alpaca
type AlpacaOptionContract struct {
	LatestQuote       AlpacaQuote  `json:"latestQuote"`
	LatestTrade       AlpacaTrade  `json:"latestTrade"`
	Greeks            AlpacaGreeks `json:"greeks"`
	ImpliedVolatility float64      `json:"impliedVolatility"`
}

// AlpacaQuote represents quote data
type AlpacaQuote struct {
	Timestamp time.Time `json:"t"`
	BidPrice  float64   `json:"bp"`
	AskPrice  float64   `json:"ap"`
	BidSize   int       `json:"bs"`
	AskSize   int       `json:"as"`
}

// AlpacaTrade represents trade data
type AlpacaTrade struct {
	Timestamp time.Time `json:"t"`
	Price     float64   `json:"p"`
	Size      int       `json:"s"`
}

// AlpacaGreeks represents Greeks data
type AlpacaGreeks struct {
	Delta float64 `json:"delta"`
	Gamma float64 `json:"gamma"`
	Theta float64 `json:"theta"`
	Vega  float64 `json:"vega"`
	Rho   float64 `json:"rho"`
}

// AlpacaOptionChainResponse represents the option chain response
type AlpacaOptionChainResponse struct {
	OptionContracts []AlpacaOptionChainContract `json:"option_contracts"`
	NextPageToken   string                      `json:"next_page_token"`
}

// AlpacaOptionChainContract represents contract metadata
type AlpacaOptionChainContract struct {
	Symbol              string  `json:"symbol"`
	UnderlyingSymbol    string  `json:"underlying_symbol"`
	ExpirationDate      string  `json:"expiration_date"`
	StrikePrice         float64 `json:"strike_price"`
	Type                string  `json:"type"` // "call" or "put"
	Style               string  `json:"style"`
	OpenInterest        int64   `json:"open_interest"`
	OpenInterestPresent bool    `json:"-"`
	ContractSize        int     `json:"contract_size"`
}

func (c *AlpacaOptionChainContract) UnmarshalJSON(data []byte) error {
	type alias AlpacaOptionChainContract
	var decoded alias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*c = AlpacaOptionChainContract(decoded)
	value, ok := fields["open_interest"]
	c.OpenInterestPresent = ok && !bytes.Equal(bytes.TrimSpace(value), []byte("null"))
	return nil
}

// GetOptionSnapshot gets the latest snapshot for an option
func (s *AlpacaOptionsDataService) GetOptionSnapshot(ctx context.Context, optionSymbol string) (*interfaces.OptionContract, error) {
	url := fmt.Sprintf("%s/v1beta1/options/snapshots/%s", s.baseURL, optionSymbol)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("APCA-API-KEY-ID", s.apiKey)
	req.Header.Set("APCA-API-SECRET-KEY", s.secretKey)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch snapshot: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var snapshot AlpacaOptionsSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		return nil, fmt.Errorf("failed to decode snapshot: %w", err)
	}

	// Convert to our format
	if alpacaContract, ok := snapshot.Snapshots[optionSymbol]; ok {
		premium := (alpacaContract.LatestQuote.BidPrice + alpacaContract.LatestQuote.AskPrice) / 2

		contract := &interfaces.OptionContract{
			Symbol:            optionSymbol,
			Premium:           premium,
			Bid:               alpacaContract.LatestQuote.BidPrice,
			Ask:               alpacaContract.LatestQuote.AskPrice,
			Delta:             alpacaContract.Greeks.Delta,
			Gamma:             alpacaContract.Greeks.Gamma,
			Theta:             alpacaContract.Greeks.Theta,
			Vega:              alpacaContract.Greeks.Vega,
			ImpliedVolatility: alpacaContract.ImpliedVolatility,
		}

		return contract, nil
	}

	return nil, fmt.Errorf("no snapshot data for %s", optionSymbol)
}

// GetOptionChain retrieves available options for an underlying symbol
func (s *AlpacaOptionsDataService) GetOptionChain(ctx context.Context, underlying string, expirationDate time.Time) (map[string]*interfaces.OptionContract, error) {
	// Alpaca's option chain endpoint
	url := fmt.Sprintf("%s/v1beta1/options/contracts?underlying_symbols=%s&expiration_date=%s",
		s.baseURL,
		underlying,
		expirationDate.Format("2006-01-02"),
	)

	s.logger.WithFields(logrus.Fields{
		"underlying": underlying,
		"expiration": expirationDate.Format("2006-01-02"),
	}).Debug("Fetching option chain")

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("APCA-API-KEY-ID", s.apiKey)
	req.Header.Set("APCA-API-SECRET-KEY", s.secretKey)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch option chain: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var chainResp AlpacaOptionChainResponse
	if err := json.NewDecoder(resp.Body).Decode(&chainResp); err != nil {
		return nil, fmt.Errorf("failed to decode chain: %w", err)
	}

	// Convert to our format
	contracts := make(map[string]*interfaces.OptionContract)
	for _, alpacaContract := range chainResp.OptionContracts {
		expDate, _ := time.Parse("2006-01-02", alpacaContract.ExpirationDate)
		dte := int(time.Until(expDate).Hours() / 24)

		contract := &interfaces.OptionContract{
			Symbol:           alpacaContract.Symbol,
			UnderlyingSymbol: alpacaContract.UnderlyingSymbol,
			ContractType:     alpacaContract.Type,
			StrikePrice:      alpacaContract.StrikePrice,
			ExpirationDate:   expDate,
			DTE:              dte,
			OpenInterest:     alpacaContract.OpenInterest, OpenInterestPresent: alpacaContract.OpenInterestPresent,
		}

		contracts[alpacaContract.Symbol] = contract
	}

	s.logger.WithField("count", len(contracts)).Debug("Fetched option chain")
	return contracts, nil
}

// FindOptionsNearDTE finds option contracts near a target DTE for an underlying
func (s *AlpacaOptionsDataService) FindOptionsNearDTE(ctx context.Context, underlying string, targetDTE int, tolerance int) (map[string]*interfaces.OptionContract, error) {
	// Calculate target expiration date
	targetDate := time.Now().AddDate(0, 0, targetDTE)

	// Search in a range
	startDate := targetDate.AddDate(0, 0, -tolerance)
	endDate := targetDate.AddDate(0, 0, tolerance)

	url := fmt.Sprintf("%s/v1beta1/options/contracts?underlying_symbols=%s&expiration_date_gte=%s&expiration_date_lte=%s&type=call",
		s.baseURL,
		underlying,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)

	s.logger.WithFields(logrus.Fields{
		"underlying": underlying,
		"targetDTE":  targetDTE,
		"dateRange":  fmt.Sprintf("%s to %s", startDate.Format("2006-01-02"), endDate.Format("2006-01-02")),
	}).Info("Finding options near target DTE")

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("APCA-API-KEY-ID", s.apiKey)
	req.Header.Set("APCA-API-SECRET-KEY", s.secretKey)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch options: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var chainResp AlpacaOptionChainResponse
	if err := json.NewDecoder(resp.Body).Decode(&chainResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	contracts := make(map[string]*interfaces.OptionContract)
	for _, alpacaContract := range chainResp.OptionContracts {
		expDate, _ := time.Parse("2006-01-02", alpacaContract.ExpirationDate)
		dte := int(time.Until(expDate).Hours() / 24)

		contract := &interfaces.OptionContract{
			Symbol:           alpacaContract.Symbol,
			UnderlyingSymbol: alpacaContract.UnderlyingSymbol,
			ContractType:     alpacaContract.Type,
			StrikePrice:      alpacaContract.StrikePrice,
			ExpirationDate:   expDate,
			DTE:              dte,
			OpenInterest:     alpacaContract.OpenInterest, OpenInterestPresent: alpacaContract.OpenInterestPresent,
		}

		contracts[alpacaContract.Symbol] = contract
	}

	s.logger.WithField("count", len(contracts)).Info("Found option contracts")
	return contracts, nil
}
